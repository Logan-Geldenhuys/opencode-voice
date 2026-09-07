# Implementation Plan: Enterprise Gateway Speech-to-Text

**Branch**: `001-enterprise-gateway-stt` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-enterprise-gateway-stt/spec.md`

## Summary

Configure and extend the `opencode-voice` fork so held-key dictation works inside opencode on WSL2, transcribing through the corporate AI gateway using the identity token opencode already holds.

The work is roughly one third configuration and two thirds correcting assumptions upstream makes that do not hold here. Upstream assumes the credential lives in an environment variable, that the transcription catalogue can be filtered by the substring `whisper`, and that only one capture process will ever exist. None of those are true for this deployment.

Technical approach: add a credential resolver that reads the editor's own credential store at call time; route transcription and text-correction at the OpenAI-compatible gateway host rather than the Anthropic host; replace the catalogue filter; and rework capture so that a single object owns its child process and its temporary file. That last item is simultaneously the fix for four lifecycle defects here and the reuse surface feature 002 needs, which is why it is expressed as a shape change rather than as four separate repairs.

Three mechanisms were considered and deliberately not built, each because something cheaper reaches the same requirement:

- **A modification-time cache in front of the credential store.** The store read costs roughly 200 microseconds against a transcription request measured at 750 milliseconds, so the cache would save about 0.03% of end-to-end latency. It would also be the only component in the resolver able to fail by serving a stale token, which is the precise defect this feature exists to correct. FR-005 is satisfied more directly, and far more provably, by an uncached read.
- **A plugin-side `*Env` option convention for supplying URLs from the environment.** The editor already substitutes `{env:NAME}` into plugin option objects, including nested values. Measured in research.md R-008. Introducing a second mechanism would duplicate a working one, and FR-009 now forbids exactly that.
- **A discriminated failure-reason enum in the resolver.** An ordered attempt log is strictly more informative than a four-value taxonomy, has one code path instead of a union plus a message mapping, and matches what the command contract actually asks to be displayed.

## Technical Context

**Language/Version**: JavaScript, ESM only. Node.js 22.22.3 locally; CI runs Node 24. No TypeScript.

**Primary Dependencies**: None at runtime — the fork has zero runtime dependencies and this feature adds none. Dev-only: `oxlint@1.65.0`, `oxfmt@0.50.0`. Host contract comes from `@opencode-ai/plugin` (typedefs 1.15.10 against binary 1.18.21).

**Storage**: `api.kv` for runtime user settings (microphone, quality tier). Static settings via plugin `options` in the host's `tui.jsonc`, which the editor resolves `{env:NAME}` references in before the plugin sees them. One new read-only path: the editor credential store, read on each request rather than cached. No writes outside a per-run temporary directory created restricted to the owner.

**Testing**: `node --test` via `npm run test`. Lint and format gate via `npm run check` (`oxlint . && oxfmt --check .`).

**Target Platform**: Ubuntu under WSL2 on Windows, AMD Ryzen 7 PRO 7840U, no discrete GPU. Audio via WSLg's PulseAudio bridge. Host application is opencode TUI 1.18.21.

**Project Type**: Single TUI plugin, library-shaped. One default export `{ id, tui }` from `index.js`, logic in `lib/`.

**Performance Goals**: SC-001 — a six-second utterance becomes reviewable text within 3s at p50 and 5s at p95, measured from key release. Measured component budget: 0.75s transcription + 1.62s correction + local overhead ≈ 2.4s p50.

**Constraints**: No build step (AGENTS.md invariant). Zero runtime dependencies. Credential must never be logged or persisted. Captured audio must not be readable by other accounts and must not outlive its transcription attempt. Every network call must be bounded by a timeout.

**Scale/Scope**: One developer, one machine, one microphone. Roughly 4 files touched, 1 file added (`lib/auth.js`), 3 test files.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

`.specify/memory/constitution.md` is an unfilled template — every principle is still `[PLACEHOLDER]`. There are therefore no ratified project principles to gate against.

Rather than record a vacuous pass, this plan treats the **`AGENTS.md` "Key invariants" section as the de-facto constitution**, since it is the actual written contract for agents working in this repository:

| Invariant                                                                       | Status        | Note                                                                                         |
| ------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Single default export `{ id, tui }`, no server plugin                           | PASS          | Unchanged.                                                                                   |
| LLM calls use OpenAI chat completions, not Anthropic messages                   | PASS          | Reinforced — see research.md R-002, which proves the Anthropic host cannot serve this shape. |
| Configuration via `options` (static) and `api.kv` (runtime). **No dotfile I/O** | **VIOLATION** | FR-004/FR-005 require reading the editor credential store. Justified in Complexity Tracking. |
| No build step. Plain ESM JavaScript, shipped as-is                              | PASS          | No new dependencies, no compilation.                                                         |

**Post-design re-check**: unchanged. The single violation is intrinsic to FR-004 and is confined to one new module with a read-only, no-write contract.

## Project Structure

### Documentation (this feature)

```text
specs/001-enterprise-gateway-stt/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output — measured evidence and decisions
├── data-model.md        # Phase 1 output — entities and state
├── quickstart.md        # Phase 1 output — operator setup and verification
├── contracts/
│   ├── plugin-options.md    # Static configuration contract
│   ├── commands.md          # User-facing command contract
│   └── credential-store.md  # Credential resolution contract
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
index.js                 # Plugin entry. Wires options -> credential resolver -> STT/TTS
lib/
├── auth.js              # NEW. Credential resolution from store, env fallback
├── stt.js               # MODIFIED. Capture, transcription, correction, insertion
├── llm-client.js        # MODIFIED. Credential source, timeout
├── logger.js            # Unchanged
├── session.js           # Unchanged
└── tts.js               # Unchanged. Dormant in this deployment
test/
├── auth.test.js         # NEW
├── stt.test.js          # MODIFIED
└── llm-client.test.js   # MODIFIED
```

**Structure Decision**: The existing flat layout is retained. This is a single small plugin with a hard "no build step" invariant; introducing `src/` would add path indirection for no benefit and would break the `files: ["index.js", "lib"]` publish contract in `package.json`. New logic goes in `lib/auth.js` because credential resolution is used by two independent callers (`stt.js` and `llm-client.js`) and must not be duplicated.

## Complexity Tracking

> Filled because the Constitution Check above records one violation.

| Violation                                                                             | Why Needed                                                                                                                                                                               | Simpler Alternative Rejected Because                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading the editor credential store from disk, against the "No dotfile I/O" invariant | FR-004 and FR-005 require the credential to be read at call time from the store the editor already maintains, so a token renewed after the editor started is picked up without a restart | The environment-variable approach the invariant implies was **measured to have already failed in this exact deployment**: the live token in the credential store was renewed the same day, while the copy in the shell environment file was 98 days stale (see research.md R-003). An environment variable is a snapshot taken at shell start; the credential is renewed every 24 hours. The invariant's intent is to prevent the plugin _writing_ configuration behind the user's back. This is a read-only access to a file the host application owns, confined to `lib/auth.js`, which exposes no write path. |

## Phase 0 — Research

Complete. See [research.md](./research.md). All Technical Context unknowns are resolved; zero `NEEDS CLARIFICATION` remain.

Decisions reached:

- **R-001** Transcription tier: `gpt-transcribe`
- **R-002** Service host: the OpenAI-compatible gateway, not the Anthropic gateway
- **R-003** Credential source: editor credential store, read per request
- **R-004** Correction model: `gpt-4.1`
- **R-005** On-device transcription: rejected
- **R-006** Catalogue filter: remove the substring match; measured-working tiers first, remainder reachable
- **R-007** Capture process termination: track the child process, never pattern-match
- **R-008** Configuration indirection: the editor's own `{env:NAME}` substitution, measured to reach nested plugin options
- **R-009** Audio toolchain: `sox` 14.4.2 with the PulseAudio driver, a hard prerequisite

## Phase 1 — Design

Complete. Artifacts: [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

## Prerequisites

`sox` with PulseAudio support is a hard gate: without it every audio path fails at capture and Phase E cannot be walked at all. Install with `sudo apt install sox libsox-fmt-pulse pulseaudio-utils`. Verified present at SoX 14.4.2 with the `pulseaudio` driver and both the `silence` and `vad` effects; see research.md R-009.

Note also that this repository carries `.opencode/skills/opencode-voice-benchmark/` from upstream. It auto-injects agent instructions whenever the editor runs with this directory as its working directory. It is inherited rather than written for this feature, and nothing in this plan depends on it.

## Implementation Phases

Ordered so that each phase's exit criteria are checkable with what exists at that point, and so the capture rework lands before anything that depends on its shape. Phase letters are execution order.

### Phase A — Credential resolution (FR-004 to FR-007)

Add `lib/auth.js` exporting a resolver that, per call, returns a credential from the first available source: the configured credential store file at a configured property path, else the configured environment variable.

The store is read on every call. There is no cache, for the reason given in the Summary: the read is negligible against the request it accompanies, and a cache is the only way this module could serve a stale token.

Failure reporting is an ordered attempt log rather than a taxonomy of reasons. Each attempted source records what was tried and how it failed, and the log is rendered only when every source has failed, which is the only case FR-006 can surface. What must stay distinct is resolution failure versus the service rejecting a credential that did resolve, because those have different corrective actions.

Wire into `lib/llm-client.js` and the two transcription call sites in `lib/stt.js`. All three currently read `process.env[apiKeyEnv]` directly at the point of use, so this is a substitution rather than a restructure.

**Exit criteria**: `test/auth.test.js` passes, covering resolution order, a token renewed between two consecutive calls being picked up by the second, every failure path, and the assertion that no code path passes the credential to a logger.

### Phase B — Capture as an owned object (FR-014 to FR-018)

Rather than four separate repairs against module-level mutable state, change the shape: capture becomes an object that owns its child process handle and its temporary file, and exposes `stop()`. Doing it this way fixes the four defects at once and leaves feature 002 with nothing to extract.

The four defects it resolves:

1. Termination by command-line pattern match, which can kill unrelated processes owned by the same user. Replaced by the tracked child handle, signalled to terminate and then killed if it does not exit.
2. Captured audio readable by other accounts. Replaced by a per-run directory created restricted to the owner, which additionally removes the fixed-path collision that a second capture path would otherwise introduce.
3. Captured audio left on disk after transcription. Deleted on both the success and the failure path.
4. Unbounded network waits. Timeouts on transcription and correction, surfaced as a distinct error rather than as a generic failure.

Also enforce single capture and stop capture on editor exit through the host disposal hook.

**Exit criteria**: no audio remains after a session (SC-006); killing the editor leaves no capture process; a stalled request surfaces a timeout rather than hanging; the object is the only thing holding a process handle or a file path.

### Phase C — Transcription correctness (FR-010, FR-011)

Remove the hardcoded `/whisper/i` catalogue filter. Because the gateway reports far more tiers than the user is entitled to use, the selector groups the measured-working tiers first and leaves the remainder reachable below them, relying on the host dialog's built-in filtering rather than a client-side name match. Add vocabulary biasing to the transcription request. Set the correction model default to `gpt-4.1`.

**Exit criteria**: no tier is excluded by a name pattern, and the measured-working tiers are reachable in one keystroke (SC-007); the benchmark in research.md R-004 reproduces at or above its recorded accuracy.

### Phase D — Service routing (FR-008, FR-009)

Make one configured location sufficient: the correction endpoint defaults to the transcription endpoint and vice versa, so a working configuration names the gateway once. Independent configuration stays possible. No indirection code is added; environment values reach the options through the editor's own `{env:NAME}` substitution (R-008), and `quickstart.md` shows the resulting configuration.

The credential remains an exception, and deliberately so. It is named by environment variable rather than substituted as a value, because substitution happens once at configuration load and would freeze a token that rotates every 24 hours, reintroducing FR-005's failure mode.

**Exit criteria**: a configuration containing no tenant identifier and no gateway hostname resolves to working endpoints for both transcription and correction.

### Phase E — Verification of existing behaviour (FR-001 to FR-003, FR-012, FR-013)

This phase builds nothing. Source inspection confirms the behaviour is already present and correct: insertion appends through `appendTranscription` in `lib/stt.js` without submitting, submission is a separate opt-in command, microphone selection exists and persists through `api.kv`, and the WSL audio diagnostics are implemented.

The work is therefore to walk the acceptance scenarios and record the result. Any task written here must be a verification task; if a check fails, the fix belongs to whichever earlier phase owns that code, not to this one.

**Exit criteria**: all User Story 1 and User Story 3 acceptance scenarios pass by manual walkthrough in `quickstart.md`.

## Risks

| Risk                                                     | Impact                                     | Mitigation                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway entitlement to `gpt-transcribe` is withdrawn     | Feature stops working                      | FR-011 makes tiers runtime-discoverable; four tiers were measured working. Fall back to `gpt-4o-transcribe` at 1.0s                                              |
| Correction introduces a confident wrong identifier       | Silent damage, worse than an obvious error | Why `gpt-4o-mini` was rejected — it produced `lib/sst.js` from `lib/stt.js`. SC-003 tests for this specifically, and FR-002's review-before-send is the backstop |
| WSLg PulseAudio bridge becomes stale after Windows sleep | No audio, no obvious cause                 | Existing diagnostics detect it; FR-013 requires the corrective action be named                                                                                   |
| Host plugin API drifts                                   | Plugin breaks on opencode upgrade          | Typedefs already trail the binary by three minor versions. Keep to documented surfaces; upstream is unpinned so pin the fork by local path                       |

## Out of Scope

Continuous listening, wake phrases, and agent interruption are feature 002. Spoken output is not planned. On-device transcription is rejected in research.md R-005 and not revisited.
