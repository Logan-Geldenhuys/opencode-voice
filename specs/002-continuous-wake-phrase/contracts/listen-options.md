# Contract: Listening options

**Feature**: 002-continuous-wake-phrase

Static configuration, added to the options established by feature 001's `contracts/plugin-options.md`. All options here are additive; none change the meaning of an existing one.

## Segmentation

| Option                    | Type   | Default  | Meaning                                                         |
| ------------------------- | ------ | -------- | --------------------------------------------------------------- |
| `listenSilenceDurationMs` | number | `700`    | Pause length that ends a segment                                |
| `listenSilenceThreshold`  | string | `"0.5%"` | Amplitude below which audio counts as silence                   |
| `listenMinSegmentMs`      | number | `400`    | Segments shorter than this are discarded untranscribed (FR-015) |
| `listenMaxSegmentMs`      | number | `30000`  | Hard cap. A segment is closed even without a pause              |

`listenSilenceDurationMs` and `listenSilenceThreshold` are the two values that need tuning per microphone and room, and no default will be right on an unseen machine (research.md R-101). FR-021's documented shell procedure exists to tune them.

`listenSilenceThreshold` is passed through to the recorder unchanged and is **not** validated by the plugin. The recorder accepts percentages and decibel values with its own grammar; validating the string would mean reimplementing that grammar, which would then be wrong in a different way than the recorder is. A rejected threshold surfaces as the recorder's own error, which names the value and is more accurate than anything the plugin could say about it.

`listenMaxSegmentMs` bounds how long a single recorder may run before it is asked to stop. It costs one timer: on expiry the plugin calls `stop()` on the capture, and the recorder exits down the same path a pause would have taken it. Because it reuses the normal stop, it is not a second segmentation mechanism and needs no separate completion handling.

`listenMinSegmentMs` is the cost gate. Every segment above it is a paid request, so the value directly determines whether a cough or a keystroke costs money. SC-005 asserts that silence and noise generate no requests.

## Buffer

| Option                 | Type   | Default   | Meaning                                    |
| ---------------------- | ------ | --------- | ------------------------------------------ |
| `listenMaxBufferAgeMs` | number | `3600000` | Speech older than this is dropped (FR-014) |
| `listenMaxBufferChars` | number | `64000`   | Cap on accumulated text (FR-014)           |

One hour for the age bound, and roughly one hour of speech for the size bound. They are sized to coincide deliberately, so that neither dominates and neither is dead configuration: 64,000 characters is about 10,600 words, which is an hour at a fast conversational 175 words per minute. Talking without pause for an hour reaches the size bound slightly before the clock reaches the age bound; anything less continuous reaches the age bound first.

That gives each one a distinct job. The size bound is what fires when the developer has been talking, and it is the one that fires in practice. The age bound is the backstop for a session left running through a long silence, where little was said but a lot of time passed.

An hour is not a staleness policy and is not pretending to be one. An earlier draft used five minutes and justified it as the mitigation for the _listening left on and forgotten_ hazard. It is not much of one: five minutes is long enough to submit the wrong train of thought and short enough to silently discard speech the developer still wanted, which is the worse of the two failures because nothing reports it. The real mitigation is FR-013 — inspect the buffer, discard it, or stop listening. The bounds exist so that memory and prompt size stay finite, and 64,000 characters is around 16,000 tokens, a large but entirely ordinary prompt.

When either bound is exceeded, the **oldest entries** are evicted until it is not. Eviction removes whole entries, never part of one: an entry is the unit the tokeniser works on and its token spans index into its own text, so trimming characters off the front of an entry would leave those spans pointing at text that is no longer there.

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
    "variants": ["open code stop and execute", "opencode stop execute"] },
  { "canonical": "hey nome execute",          "action": "submit",
    "variants": ["hey node execute", "hey norm execute", "hey nom execute",
                 "hey gnome execute", "hey no me execute"] },
  { "canonical": "hey nome stop and execute", "action": "interrupt_submit",
    "variants": ["hey node stop and execute", "hey norm stop and execute",
                 "hey nom stop and execute", "hey gnome stop and execute",
                 "hey no me stop and execute"] }
]
```

The second pair carries a name the recogniser does not render stably: measurement on a single speaker and microphone produced `node`, `norm`, `nom`, `gnome` and `no me` for the same spoken word, and vocabulary biasing shifted none of them. The phrase is therefore three tokens rather than two, so that the unstable token sits between two reliable ones. Measured against eighteen plausible utterances mentioning those words, the two-token form fired on five of them while still missing one real rendering; the three-token form fired on none and missed nothing. Length is what buys that, and it is why the rule in wake-phrase.md is to lengthen the phrase rather than accept a form.

Validated at compile time against `contracts/wake-phrase.md`: no empty phrases, no single-token phrases, no two actions compiling to the same token sequence. A single-token phrase is rejected outright rather than warned about — it will fire during ordinary speech, and the failure is an unintended submission to an agent with file-modifying tools.

The `variants` lists above are starting points, not measurements. Establishing which distortions this developer's voice and room actually produce is the calibration procedure in quickstart.md, and its output is these lists (SC-012).

## Submission

| Option                  | Type    | Default   | Meaning                                                |
| ----------------------- | ------- | --------- | ------------------------------------------------------ |
| `listenTranscriptLabel` | string  | see below | Prefix on every submitted prompt (FR-009)              |
| `listenAutoSubmit`      | boolean | `true`    | Whether a wake phrase submits or only fills the prompt |

Default label:

> The following is a voice transcript and may contain speech recognition errors, particularly in code identifiers, file paths and technical terms. Treat unfamiliar identifiers with suspicion and verify them against the project before acting on them. The developer speaks to you as Nome. A phrase addressing you by name is how they mark a direct instruction; the surrounding speech is them thinking aloud, and is context rather than a request. Act on the instruction, and use the rest to inform how. Speech recognition renders "Nome" inconsistently, most often as "node" or "norm". A phrase of the form "hey <something> execute" is this address mis-transcribed rather than a reference to Node.js or to a colleague; read it as the developer speaking to you and do not remark on the error.

This label does two jobs. It is the entire substitute for a correction pass (FR-010, research.md R-103), and it is what makes the retained wake phrase legible (FR-008, FR-009): the phrase is left in the transcript because it marks the direct instruction, which only helps if the recipient knows that is what it is. It is configurable because its effectiveness depends on the agent model reading it.

The label calls out the unstable token by name. The name in `hey nome execute` arrives as `node` or `norm` more often than as itself, and both of those are words a developer could mean literally, so an agent reading one has no way to tell a mangled address from a topic. The tokens bracketing it transcribe reliably and need no explanation. Explaining the distortion is what makes retaining the phrase under FR-008 useful rather than merely harmless.

Otherwise the label names the agent but deliberately does not list the configured phrases. The phrases are already present in the transcript, and they are configuration — a prose list of them would eventually disagree with `listenWakePhrases`, and the failure would be silent.

`listenAutoSubmit` defaults to `true`, inverting feature 001's review-before-send default. That inversion is deliberate and is justified in the spec: the wake phrase _is_ the developer's confirming act. The option exists so the inversion can be undone during tuning, when a developer may want to see what a wake phrase would have submitted before trusting it to submit.

When `false`, the assembled prompt is placed in the editor's prompt and left there, unsubmitted. Everything else is unchanged: the buffer is still emptied, and the interrupt phrase still aborts the agent before filling the prompt. Only the final submit is skipped. Spelling this out matters because the alternative readings are both wrong — leaving the buffer intact would make the next wake phrase resubmit everything, and skipping the abort would make the interrupt phrase silently stop being an interrupt.

## State reporting

No option. An earlier draft added `listenIndicator` with `auto`, `slot` and `signal` modes, selecting between a persistent in-editor indicator and a signalling fallback.

There is nothing left to select between. The host's toast facility returns no handle, so a toast cannot be updated or dismissed and therefore cannot be persistent. The one surface that might render a persistent indicator is unproven from external plugins, depends on an optional peer dependency that is not installed, and its ergonomic form requires a build step the project forbids. FR-012 was rewritten to require announced transitions plus an on-demand status command, which the host supports directly. A three-way option whose only viable value is `signal` is not configuration.

## Interaction with feature 001

| Reused                          | Notes                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| Transcription endpoint and tier | Same service, same `gpt-transcribe` tier                         |
| Credential resolution           | Per-request, from the editor credential store                    |
| Capture object                  | Owns its process and its audio file; one per segment             |
| Capture directory               | Per plugin load, owner-only, beneath the OS temp dir             |
| Request timeout                 | Applies per segment                                              |
| Capture registry                | Moved to `lib/capture.js` by Phase A0, then shared by both modes |

The capture object is the load-bearing reuse. Feature 001 replaced module-level process and path variables with an object owning both, which is what allows this feature to run a recorder at all without the two paths interfering. Each recorder produces one segment and exits, so the object's `exited` promise is the segment boundary and its `stop()` is how the maximum-duration bound is applied.

One thing is **not** reused as it stands, and Phase A0 exists to fix it: the record of what is currently capturing lives in a module variable inside `lib/stt.js`, along with the temp-directory helper and the sequence counter, and the plugin's dispose and process-exit hooks drain that variable. A recorder owned by a listening session would not appear in it, so on abnormal exit a live recorder and a file of the developer's voice would survive — the case FR-020 names. The same variable is what FR-017's exclusion check has to consult, and two per-mode flags can disagree with each other and with the operating system where one shared record cannot. Phase A0 moves the registry into `lib/capture.js` and widens it from one slot to a set. Nothing about the capture object's shape changes.

FR-017 makes the two modes mutually exclusive, so they never capture concurrently — but the audio path must still be per-capture, because the next recorder in a listening session starts while the previous segment is still being uploaded.

**Not used**: the correction endpoint and model. This feature makes no LLM calls (FR-010). Correction configuration remains valid for held-key dictation and is simply not consulted here.

The transcription vocabulary is shared, and that is a constraint rather than a convenience. Both modes call the same transcription function, so a term added to bias the recogniser toward a wake word skews every dictated sentence toward a word only one mode cares about. Wake-phrase recognition is therefore handled by accepting the forms the recogniser produces (wake-phrase.md variants), not by biasing it toward the form we wanted. Nothing else leaks in the other direction: the transcript label, the wake phrases and the segmentation options are read only by this feature.

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
  },
]
```

Wake phrases and both buffer bounds are omitted, so the defaults apply. `sttVocabulary` already contains `opencode`, which biases recognition of both phrases' shared prefix — the cheapest available improvement to SC-012.

The endpoint uses the editor's own `{env:NAME}` substitution rather than a paired `...Env` option, per feature 001's `contracts/plugin-options.md` and research.md R-008. Only the transcription endpoint appears, because the correction endpoint defaults from it and this feature makes no LLM calls in any case.
