# Contract: Listening options

**Feature**: 002-continuous-wake-phrase

Static configuration, added to the options established by feature 001's `contracts/plugin-options.md`. All options here are additive; none change the meaning of an existing one.

## Segmentation

| Option                    | Type   | Default | Meaning                                                         |
| ------------------------- | ------ | ------- | --------------------------------------------------------------- |
| `listenSilenceDurationMs` | number | `700`   | Pause length that ends a segment                                |
| `listenSilenceThreshold`  | string | `"2%"`  | Amplitude below which audio counts as silence                   |
| `listenMinSegmentMs`      | number | `400`   | Segments shorter than this are discarded untranscribed (FR-015) |
| `listenMaxSegmentMs`      | number | `30000` | Hard cap. A segment is closed even without a pause              |

`listenSilenceDurationMs` and `listenSilenceThreshold` are the two values that need tuning per microphone and room, and no default will be right on an unseen machine (research.md R-101). FR-021's documented shell procedure exists to tune them.

`listenSilenceThreshold` is passed through to the recorder unchanged and is **not** validated by the plugin. The recorder accepts percentages and decibel values with its own grammar; validating the string would mean reimplementing that grammar, which would then be wrong in a different way than the recorder is. A rejected threshold surfaces as the recorder's own error, which names the value and is more accurate than anything the plugin could say about it.

`listenMaxSegmentMs` is a safety valve, not a segmentation strategy. Constant background noise can prevent silence ever being detected; without a cap, one segment grows until the session ends and nothing is ever transcribed.

`listenMinSegmentMs` is the cost gate. Every segment above it is a paid request, so the value directly determines whether a cough or a keystroke costs money. SC-005 asserts that silence and noise generate no requests.

## Buffer

| Option                 | Type   | Default  | Meaning                                    |
| ---------------------- | ------ | -------- | ------------------------------------------ |
| `listenMaxBufferAgeMs` | number | `300000` | Speech older than this is dropped (FR-014) |
| `listenMaxBufferChars` | number | `8000`   | Cap on assembled prompt size               |

Five minutes for the age bound: long enough to think aloud through a problem, short enough that speech from a previous train of thought cannot be submitted by a later wake phrase. This is the primary mitigation for the _listening left on and forgotten_ hazard, and SC-009 asserts it holds.

The character cap protects against an unbounded prompt after a long unattended session. When exceeded, the **oldest** text is dropped — the newest speech is the operative instruction.

## Wake phrases

| Option              | Type     | Default   | Meaning             |
| ------------------- | -------- | --------- | ------------------- |
| `listenWakePhrases` | object[] | see below | Phrase set (FR-022) |

There is no `listenHomophones` option. An earlier draft added one, holding whole-word substitutions applied before matching. It is removed because `variants` on each phrase does the same job and more — a word split such as `opencode` into `open code` crosses a word boundary, which is the distortion that actually occurs and which whole-word substitution cannot express. One mechanism, configured in one place, per FR-003.

Default:

```jsonc
"listenWakePhrases": [
  { "canonical": "opencode execute",          "action": "submit",
    "variants": ["open code execute"] },
  { "canonical": "opencode stop and execute", "action": "interrupt_submit",
    "variants": ["open code stop and execute", "opencode stop execute"] }
]
```

Validated at compile time against `contracts/wake-phrase.md`: no empty phrases, no single-word phrases, no two actions sharing a normalised form. A single-word phrase is rejected outright rather than warned about — it will fire during ordinary speech, and the failure is an unintended submission to an agent with file-modifying tools.

## Submission

| Option                  | Type    | Default   | Meaning                                                |
| ----------------------- | ------- | --------- | ------------------------------------------------------ |
| `listenTranscriptLabel` | string  | see below | Prefix on every submitted prompt (FR-009)              |
| `listenAutoSubmit`      | boolean | `true`    | Whether a wake phrase submits or only fills the prompt |

Default label:

> The following is a voice transcript and may contain speech recognition errors, particularly in code identifiers, file paths and technical terms. Treat unfamiliar identifiers with suspicion and verify them against the project before acting on them.

This label is the entire substitute for a correction pass (FR-010, research.md R-103). It is configurable because its effectiveness depends on the agent model reading it.

`listenAutoSubmit` defaults to `true`, inverting feature 001's review-before-send default. That inversion is deliberate and is justified in the spec: the wake phrase _is_ the developer's confirming act. The option exists so the inversion can be undone during tuning, when a developer may want to see what a wake phrase would have submitted before trusting it to submit.

## State reporting

No option. An earlier draft added `listenIndicator` with `auto`, `slot` and `signal` modes, selecting between a persistent in-editor indicator and a signalling fallback.

There is nothing left to select between. The host's toast facility returns no handle, so a toast cannot be updated or dismissed and therefore cannot be persistent. The one surface that might render a persistent indicator is unproven from external plugins, depends on an optional peer dependency that is not installed, and its ergonomic form requires a build step the project forbids. FR-012 was rewritten to require announced transitions plus an on-demand status command, which the host supports directly. A three-way option whose only viable value is `signal` is not configuration.

## Interaction with feature 001

| Reused unchanged                | Notes                                                |
| ------------------------------- | ---------------------------------------------------- |
| Transcription endpoint and tier | Same service, same `gpt-transcribe` tier             |
| Credential resolution           | Per-request, from the editor credential store        |
| Capture object                  | Owns its process and its audio file; one per segment |
| Capture directory               | Per plugin load, owner-only, beneath the OS temp dir |
| Request timeout                 | Applies per segment                                  |

The capture object is the load-bearing reuse. Feature 001's Phase B replaces module-level process and path variables with an object that owns both, which is what allows this feature to run a capture at all without the two paths interfering. Note that FR-017 makes the two modes mutually exclusive, so they never capture concurrently — but the audio path must still be per-capture, because segments within a single listening session follow one another closely enough that a fixed path would have one truncating the next.

**Not used**: the correction endpoint and model. This feature makes no LLM calls (FR-010). Correction configuration remains valid for held-key dictation and is simply not consulted here.

## Validation

Validated once at initialisation. A malformed option must name the option, not produce a stack trace.

- All `*Ms` values: positive integers.
- `listenMinSegmentMs` < `listenMaxSegmentMs`.
- `listenMaxBufferChars`: positive integer.
- `listenWakePhrases`: non-empty; compiles cleanly.

`listenSilenceThreshold` is deliberately absent from this list, for the reason given under Segmentation: it is the recorder's grammar to validate, not the plugin's.

## Reference configuration

Extends feature 001's, adding only what differs from the defaults:

```jsonc
[
  "/home/logan/opencode-voice",
  {
    "sttApiEndpoint": "{env:OPENCODE_VOICE_STT_BASEURL}",
    "sttApiModel": "gpt-transcribe",
    "model": "gpt-4.1",
    "sttVocabulary": ["opencode", "oxlint", "oxfmt", "WSL", "PulseAudio"],
    "listenSilenceDurationMs": 700,
    "listenMaxBufferAgeMs": 300000,
  },
]
```

Wake phrases are omitted, so the defaults apply. `sttVocabulary` already contains `opencode`, which biases recognition of both phrases' shared prefix — the cheapest available improvement to SC-002.

The endpoint uses the editor's own `{env:NAME}` substitution rather than a paired `...Env` option, per feature 001's `contracts/plugin-options.md` and research.md R-008. Only the transcription endpoint appears, because the correction endpoint defaults from it and this feature makes no LLM calls in any case.
