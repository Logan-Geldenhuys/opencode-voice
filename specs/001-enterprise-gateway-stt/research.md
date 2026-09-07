# Research: Enterprise Gateway Speech-to-Text

**Feature**: 001-enterprise-gateway-stt | **Date**: 2026-09-06

All findings below were measured from the target machine rather than inferred from documentation: gateway behaviour by live request, host behaviour by instrumented probe, toolchain by inspection of the installed binaries. Every latency figure is a real request. This matters because four of the nine decisions contradict what the documentation, the model catalogue, or the obvious design would imply.

---

## R-001 — Transcription tier

**Decision**: `gpt-transcribe`.

**Rationale**: Measured on an identical 6-second clip, two runs each, all HTTP 200.

| Tier                     | Run 1     | Run 2     | Output quality                                    |
| ------------------------ | --------- | --------- | ------------------------------------------------- |
| **`gpt-transcribe`**     | **0.75s** | **0.74s** | Correct. Rendered a spoken path as `src/index.js` |
| `gpt-4o-transcribe`      | 1.02s     | 1.12s     | Correct                                           |
| `whisper-1`              | 1.51s     | 1.21s     | Left `src slash index.js` unconverted             |
| `gpt-4o-mini-transcribe` | 1.50s     | 1.81s     | Correct, but slowest                              |

`gpt-transcribe` is both the fastest and among the most accurate. Note that `whisper-1` — the tier the plugin's catalogue filter would have restricted the user to — is the only one that failed to convert a spoken file path, which is the single most common thing a developer dictates.

Vocabulary biasing via the request's `prompt` parameter was confirmed working on this tier.

**Alternatives considered**: `gpt-4o-mini-transcribe` was expected to be the fast cheap option and is in fact the slowest. `gpt-4o-transcribe-diarize` was not evaluated — speaker separation is out of scope.

---

## R-002 — Service host

**Decision**: Route both transcription and text correction at the OpenAI-compatible gateway host. Leave the agent itself on the Anthropic gateway host.

**Rationale**: This is a hard constraint, not a preference. Probing the Anthropic gateway host:

```
POST {anthropic-host}/v1/chat/completions
  -> 403 "endpoint 'api.anthropic.com/v1/chat/completions' ... is not allowed"
```

The Anthropic gateway exposes only the Anthropic-native messages endpoint. The plugin's LLM client constructs `${endpoint}/chat/completions` unconditionally, and the `AGENTS.md` invariant explicitly requires the OpenAI chat completions shape. The two are only reconcilable by pointing the plugin at the OpenAI-compatible host.

The same identity token authenticates against both hosts under the same tenant, so this costs nothing in credential handling.

**Alternatives considered**: Rewriting the client to speak the Anthropic messages API would violate an explicit repository invariant and would still leave transcription without a home — the Anthropic host offers no audio endpoint. Rejected.

---

## R-003 — Credential source

**Decision**: Read the editor's own credential store at the moment of each request. Retain an environment variable as a configurable fallback.

**Rationale**: The credential is a corporate SSO identity token with a **24-hour lifetime**. It exists in two places on the target machine, and they had already diverged before this feature was designed:

| Location                | Last modified   | Status                                          |
| ----------------------- | --------------- | ----------------------------------------------- |
| Editor credential store | Same day        | **Live** — refreshed by the normal sign-in flow |
| Shell environment file  | 98 days earlier | Stale                                           |

This is the failure that FR-005 exists to prevent, and it had already happened silently. An environment variable is a snapshot taken when the shell started; a process started before a re-authentication holds a dead token until it is restarted. Reading per request removes the entire class of problem.

**No cache.** The store is read on every request. The store file is 1 to 4 KB of local JSON, so a read and parse costs roughly 200 microseconds against a transcription request measured at 750 milliseconds: the cache would save about 0.03% of end-to-end latency. Against that it would add a `stat` per request, invalidation logic, an edge case for the store disappearing after a successful read, and several tests. More seriously, it would be the only part of this module capable of serving a stale token, which is the exact defect the decision above exists to eliminate. FR-005 says the credential is read at the moment of each request; an uncached read satisfies that both more directly and more provably.

**Alternatives considered**: An mtime-keyed cache was specified first and then removed, for the reason immediately above. Exporting the token from the credential store in shell startup was considered and rejected — it narrows the drift window but does not close it, because any shell or editor started before a re-authentication still holds the old value. Reading the token once at plugin initialisation was rejected for the same reason, more severely: opencode sessions routinely outlive a 24-hour token.

---

## R-004 — Text correction model

**Decision**: `gpt-4.1`.

**Rationale**: Benchmarked with the plugin's real correction prompt, `temperature=0.2`, two deliberately hard transcripts, three runs each, scored on whether specific target terms came out correct.

Transcript 1 traps: a spoken file path, a spoken line number, and the homophones `jason`, `rap`, `no`, `a sink`, `locks`, `back off`.
Transcript 2 traps: `plug in`, `sox`, `k v`, `mick`, `app and prompt`.

| Model          | p50       | Range     | T1  | T2      | Persistent misses    |
| -------------- | --------- | --------- | --- | ------- | -------------------- |
| **`gpt-4.1`**  | **1.62s** | 1.40–1.75 | 9/9 | **7/7** | none                 |
| `gpt-4.1-nano` | 1.56s     | 1.12–1.75 | 9/9 | 6/7     | `appendPrompt`       |
| `gpt-4o`       | 1.64s     | 1.24–1.84 | 9/9 | 6/7     | `kv`                 |
| `gpt-4.1-mini` | 1.81s     | 1.39–2.10 | 9/9 | 5/7     | `appendPrompt`, `kv` |

Two results are worth stating plainly because they invert the obvious choice:

1. **The full model is not slower than the small ones.** Correction output is around 70 tokens, so latency is dominated by round-trip and time-to-first-token, not generation throughput. Reaching for a smaller model buys nothing here.
2. **`gpt-4.1-mini`, the intuitive pick, is both the slowest and the least accurate of the four.**

**Disqualified outright**: `gpt-4o-mini` turned `lib/stt.js` into `lib/sst.js`. A correction pass that invents a plausible, wrong filename is worse than no correction pass, because the error survives review — this is what SC-003's second clause is written against.

**Rejected on latency**: reasoning-gated models are entitled but unusable in a voice loop — `gpt-5.6-terra` 3.4s, `gpt-5.6-sol` 5.77s, `gpt-5.6-luna` 6.8s. `o4-mini` spent its entire token budget on internal reasoning and returned **empty content**.

---

## R-005 — On-device transcription

**Decision**: Rejected. Transcription is remote.

**Rationale**: The target machine has an AMD Ryzen 7 PRO 7840U with Radeon 780M integrated graphics — no CUDA device, no `nvcc`. An on-device engine would be CPU-only, restricting it to the small model tiers. Those tiers are _both_ slower than a 0.75s network round trip _and_ less accurate than the remote tiers on exactly the technical vocabulary that matters here.

The user's opening request mentioned a custom Whisper deployment. The measurements do not support it: there is no accuracy or latency argument for local inference on this hardware, and it would add a build toolchain, a model download, and a second failure surface.

**Alternatives considered**: A local tiny model used purely as a cheap gate before spending a network call was designed and then dropped once the user confirmed that sending all audio to the gateway is acceptable. It remains the right answer if the privacy posture ever changes, and is recorded here for that reason.

---

## R-006 — Transcription tier catalogue

**Decision**: Remove the substring filter. Group the measured-working tiers first and leave the remainder reachable, relying on the host dialog's own filtering rather than a client-side name match.

**Rationale**: The current implementation filters the service catalogue with `/whisper/i` before presenting tiers to the user. Against this gateway that filter hides every tier except `whisper-1` — which R-001 measured as the slowest accurate option and the only one that mangled a file path. The fastest tier is invisible.

Removing the filter without grouping would substitute a different usability failure for the first one. This gateway advertises 1328 models; a flat selector with 1328 entries, of which 1146 are other tenants' fine-tunes, is worse than the broken filter it replaced. `TuiDialogSelectProps` provides built-in type-to-filter and a per-option `category` field, so the correct division of labour is for the plugin to categorise and the host to filter. Nothing is hidden, and the tiers that were measured to work stay one keystroke away.

A caveat that must not be designed away: **the catalogue is not the entitlement list.** The gateway advertises 1328 models, of which 1146 are other tenants' fine-tunes, plus internal codenamed builds. Entitlement was verified by direct request:

- Working: `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`
- Entitled but requiring different request parameters: `o4-mini`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`
- Advertised but 403: `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4-mini`, `gpt-5.4-nano`

So presenting the whole catalogue satisfies SC-007, but selecting a tier can still fail at request time. That failure must be reported as a rejected tier and be distinguishable from an authentication failure — this is the spec's _transcription service rejects the requested quality tier_ edge case.

---

## R-007 — Capture process termination

**Decision**: Track the spawned child process and terminate that handle. Never match on command line.

**Rationale**: The current implementation terminates recording with a pattern match against running processes' command lines. Two problems:

1. It can terminate unrelated processes belonging to the same user that happen to match — the basis for FR-016.
2. It becomes an outright defect the moment a second capture exists. Feature 002 adds a continuous capture process using the same binary; a pattern kill from the held-key path would terminate it.

Fixing this now, in 001, is cheaper than discovering it in 002.

**Alternatives considered**: Narrowing the pattern was rejected — it reduces the probability of the collision without removing it, and does nothing about the 002 interaction.

Implementation note: the four lifecycle defects FR-014 to FR-018 describe are all symptoms of the same cause, which is that the recording process handle and the recording file path live in module-level mutable state rather than in an object. Fixing the shape fixes all four, and leaves feature 002 with a capture surface it can use directly instead of extracting one.

---

## R-008 — Configuration indirection

**Decision**: Use the editor's own `{env:NAME}` substitution. Add no plugin-side indirection.

**Rationale**: FR-009 requires that tracked configuration contain no tenant identifier and no gateway hostname. The user's editor configuration directory is a public repository, so this is a disclosure requirement, not a preference.

The first design met it with a paired-option convention: every option accepting a URL would gain a sibling ending in `Env` naming an environment variable to read instead, with a precedence rule and a warning when both were supplied. That is a convention plus a resolver plus a warning branch, repeated per option.

It is also unnecessary. The editor already performs this substitution on raw configuration text before parsing. Verified by measurement rather than by reading the binary: a probe plugin was registered temporarily in `tui.jsonc` with option values containing `{env:DCP_PROBE_VALUE}` at the top level and nested inside an object, alongside a control string containing no placeholder. The plugin recorded what it actually received:

```json
{
  "probeUrl": "https://probe.example/v1",
  "probeNested": { "inner": "https://probe.example/v1" },
  "probeLiteral": "unchanged"
}
```

Substitution reaches nested values inside plugin option objects, and strings without a placeholder pass through untouched. So the requirement is met by the user writing `"sttApiEndpoint": "{env:OPENCODE_VOICE_STT_BASEURL}"` and the plugin containing no indirection code at all.

**The credential is deliberately excluded from this mechanism.** Substitution happens once, when configuration is loaded. A token substituted at load time is frozen for the life of the editor process, which is precisely the 24-hour-rotation failure R-003 exists to prevent. The credential is therefore still named by environment variable and read per request, and `apiKeyEnv` survives while the URL-oriented `*Env` options do not. The distinction is not inconsistency: one names a value to read repeatedly, the other supplies a value once.

**Alternatives considered**: The paired-option convention, rejected above as a duplicate of a working host mechanism. A single uniform helper applying `{env:}` semantics inside the plugin was held as a fallback in case `tui.jsonc` turned out to use a different loader from `opencode.jsonc`; the measurement above retired it.

---

## R-009 — Audio capture toolchain

**Decision**: `sox` with PulseAudio support is a hard prerequisite, installed by the operator.

**Rationale**: All capture goes through `sox`. It was absent on the target machine at design time, and installing it requires elevation the agent does not have, so it is recorded as a gate rather than as a task. Now installed and verified:

| Component          | Verified                                                            |
| ------------------ | ------------------------------------------------------------------- |
| SoX                | 14.4.2, with `sox`, `play`, `rec`, `soxi` on `PATH`                 |
| `libsox-fmt-pulse` | Present; `pulseaudio` appears in SoX's audio device driver list     |
| `silence` effect   | Present. Required by the existing silence-trimming capture argument |
| `vad` effect       | Present. Relevant to feature 002's segmentation                     |

Without this, every phase's audio path fails at capture and Phase E cannot be walked at all.

**Alternatives considered**: `arecord` via ALSA was not pursued. The existing implementation is built on `sox` argument construction with unit tests around it, and WSLg exposes audio through PulseAudio, which `sox` addresses directly.

---

## Resolved unknowns

| Unknown                                                            | Resolution                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which gateway host serves audio and chat                           | OpenAI-compatible host; Anthropic host rejects both (R-002)                                                                                                                                                      |
| Whether the identity token authenticates beyond the Anthropic host | Yes, same token, same tenant                                                                                                                                                                                     |
| Fastest accurate transcription tier                                | `gpt-transcribe` at 0.75s (R-001)                                                                                                                                                                                |
| Best correction model within a voice latency budget                | `gpt-4.1` at 1.62s p50 (R-004)                                                                                                                                                                                   |
| Whether streaming transcription is available                       | No. Both realtime endpoints return 403 "not allowed". Constrains 002, not 001                                                                                                                                    |
| Whether on-device transcription is viable                          | No — no CUDA device (R-005)                                                                                                                                                                                      |
| Which host configuration file loads plugins                        | `tui.jsonc` carries `plugin`; `tui.json` carries theme and keybinds. Both are present and neither duplicates the other's keys, so the operative file for this feature is `tui.jsonc`. Confirmed in quickstart.md |
| Audio capture prerequisites                                        | `sox` 14.4.2 with `libsox-fmt-pulse`, installed and verified. PulseAudio driver plus `silence` and `vad` effects present (R-009)                                                                                 |
| Whether the plugin needs its own environment indirection           | No. The editor substitutes `{env:NAME}` into nested plugin options, measured (R-008). The credential remains the one exception, by design                                                                        |
