# Research: Continuous Listening with Wake-Phrase Submission

**Feature**: 002-continuous-wake-phrase | **Date**: 2026-09-06

Builds on feature 001's research, which established the gateway, the transcription tier and the credential source. Findings here concern segmentation, wake-phrase handling, and the two host capabilities this feature needs that feature 001 did not.

---

## R-101 — Segmentation

**Decision**: Split at pauses, using the recorder's own silence detection. Not at fixed intervals.

**Rationale**: Fixed-interval chunking cuts words in half. A word split across two requests is mis-transcribed in both, and the damage is not recoverable by concatenation. Worse for this feature specifically, a wake phrase split across a chunk boundary may be recognisable in neither half.

The capture tool already performs silence-based splitting, so this costs no new dependency — which matters given the zero-runtime-dependency invariant.

Pause thresholds are deliberately left as configuration rather than fixed. They depend on microphone gain, room reverberation and speaking style, and no value chosen at design time will be right on an unseen machine. This is why FR-021 requires a way to tune them outside the editor: without one, tuning means repeatedly restarting the editor to test a threshold.

That way is the recorder itself, not a program written for the purpose. The same tool the plugin drives will segment to numbered files from a shell prompt:

```sh
sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart
soxi -D seg*.wav
```

Speak, stop the recording, and the file count and durations answer the question directly. An earlier draft of this plan specified a Node harness for this. It would have been a new file, in a new directory, excluded from the published package, reimplementing argument construction that already exists in the plugin - and therefore able to be tuned correctly while the plugin remained wrong. The two-line shell form exercises the plugin's actual code path, which is the property that matters.

**Alternatives considered**: Fixed 3-second chunks were the obvious first design and were rejected on the word-splitting problem above. Voice activity detection as a library dependency was rejected against the zero-dependency invariant, and would have required a build step for any native component.

---

## R-102 — Streaming transcription

**Decision**: Unavailable. Segments are transcribed as complete files over HTTP.

**Rationale**: Measured, not assumed. Both realtime paths are blocked at the gateway:

```
GET  {openai-host}/v1/realtime?intent=transcription   (WebSocket upgrade)
  -> 403 "AI Gateway error: The endpoint ... you requested is not allowed"

POST {openai-host}/v1/realtime/transcription_sessions
  -> 403 "AI Gateway error: The endpoint ... you requested is not allowed"
```

This is a gateway policy decision, not a capability gap in the upstream service, and it is not something the plugin can work around.

**Consequence, which propagates into the spec**: a wake phrase cannot be acted upon until the speaker has stopped talking long enough for a pause to be detected and the segment transcribed. There is no partial-hypothesis stream to match against mid-utterance. This sets the floor under SC-001 and is recorded as an assumption in the spec so that the latency is understood as a constraint rather than read as sloppiness.

**Alternatives considered**: Overlapping segment windows to shorten effective detection latency were considered and rejected — they multiply request volume, and deduplicating overlapping transcripts reintroduces the word-boundary problem R-101 exists to avoid.

---

## R-103 — No correction pass on continuous speech

**Decision**: Submit continuous speech uncorrected, labelled as a transcript that may contain recognition errors.

**Rationale**: The user asked for this directly: _"instead of using GPT-4.1-mini to normalize, just say that this is a transcript and may include errors whenever we send it to the agent."_

The measurements support it independently, which is worth recording because it means the requirement is not merely a preference:

- **Latency.** Correction costs 1.62s at p50 (feature 001, R-004). In held-key dictation that is paid once per deliberate act of composition. Here it would be paid on every submission, against a 3s p50 target that already spends 0.75s on transcription and ~0.5s on pause detection.
- **Error character.** Correction can substitute a confident wrong identifier — `gpt-4o-mini` produced `lib/sst.js` from `lib/stt.js`. In held-key dictation the developer reviews before sending, so the error is catchable. Continuous mode auto-submits, so an invented filename reaches the agent unreviewed.
- **Context.** The agent has the project's actual file tree and symbol names. A correction pass has a system prompt and a session title. The agent is strictly better placed to resolve `lib slash s t t dot j s`, provided it is told the text is a transcript.

So the label is not a consolation for skipping correction. It relocates the correction to the component best equipped to do it.

**Alternatives considered**: Correcting only when the buffer is short was rejected as unpredictable — identical-looking submissions would behave differently. Correcting asynchronously after submission was rejected as incoherent: the agent would already be working from the raw text.

---

## R-104 — Wake-phrase matching

**Decision**: Normalise to locate the phrase. Slice the original text to submit it. Longest phrase first.

**Rationale**: Exact string matching cannot work. Transcription returns the same spoken phrase with varying capitalisation, trailing punctuation and internal spacing. A literal comparison would fail unpredictably, and unpredictable triggering is worse than no triggering - the developer stops trusting the feature. So matching runs against a normalised form: case folded, punctuation stripped, whitespace collapsed.

**The normalised form must not be what gets submitted.** This is the one place where this feature deliberately adds code rather than removing it, so the reasoning is worth stating in full. Normalisation is lossy in exactly the dimension that matters to an agent:

```text
"Fix the bug in Server.tsx, then run npm test."
  normalises to
"fix the bug in servertsx then run npm test"
```

`Server.tsx` does not survive. Neither does any sentence boundary across a multi-minute buffer. An earlier draft of this contract concluded that submitting normalised text was "acceptable and arguably preferable" on the grounds that punctuation from a transcript is unreliable anyway. That is wrong, and it is wrong in a way that is invisible in testing: normalised prose still reads perfectly well, so a test written on ordinary sentences passes whether or not the identifiers survived. The feature would corrupt precisely the terms FR-009's transcript label asks the agent to treat with care, and it would do so silently.

The fix is cheap because the module owns the join. The buffer is already an ordered array of segment texts, so the matcher can normalise internally, map the match offset back to a `(segmentIndex, charOffset)` pair, and slice the originals. Roughly fifteen lines. FR-023 requires it and SC-011 measures it character for character.

Two matching rules that are not obvious:

1. **Match against the whole buffer, not each segment** (FR-004). A phrase spoken across a pause lands in two segments and appears in neither alone. Pause placement inside a two-word phrase is not under the speaker's conscious control, so this is a normal case, not an edge case.
2. **Longest phrase wins** (FR-005). The two configured phrases share a prefix by design - one is the other plus an inserted word. Matching the shorter one first would read the interrupt variant as a plain submission followed by stray words, submitting the wrong thing _and_ failing to interrupt. SC-003 requires zero occurrences of this, which is why the phrase list is sorted by normalised length at compile time: the guarantee becomes a property of the data structure rather than a code path a caller can bypass.

A third rule was specified and has been removed. An earlier draft resolved multiple matches in the buffer by taking the last occurrence. But FR-004 requires detection after every segment append, so at most one phrase can be present at the moment detection runs - the first would have fired and cleared the buffer before the second was spoken. First-versus-last was unobservable. It has been replaced by the invariant itself, plus a test asserting it.

Transcription-side vocabulary biasing is available and confirmed working on the chosen tier, and is applied to raise the phrase's recognition rate before matching ever runs.

**Alternatives considered**: Fuzzy matching with an edit-distance threshold was rejected - it trades a known false-negative rate for an unknown false-positive rate, and false positives here submit unintended text to an agent with file-modifying tools. An explicit variant list fails predictably and is inspectable.

A configurable per-word homophone map was specified and has been removed. Variants (FR-022) already express everything it could, and strictly more: the motivating example was `opencode` recognised as the two words `open code`, which is a distortion spanning a word boundary that whole-word substitution cannot represent at all. Keeping both would mean the weaker mechanism running first, on text the stronger one is about to match, with the ability to corrupt it before matching begins. One mechanism means one place to look when a phrase misfires.

---

## R-105 — Agent interruption

**Decision**: Abort the session, then submit. The plain phrase submits regardless of agent state.

**Rationale**: The host exposes both a session abort and a prompt submission path, so the interrupt variant is abort-then-submit.

The behaviour that needs deciding is what the _plain_ phrase does when the agent is busy — the spec's _agent is busy when a plain submission fires_ edge case. The requirement is that behaviour be defined and consistent rather than timing-dependent. Decision: **the plain phrase always submits and never aborts.** The developer chose the phrase without the interrupt word; interpreting it as an interrupt because of the agent's incidental state would make the two phrases indistinguishable in exactly the situation where the distinction matters. If the host queues the prompt behind current work, that is the host's normal behaviour for a prompt submitted while busy, and matches what typing would do.

The converse is also fixed: the interrupt phrase with an idle agent submits normally and raises no error (FR-007). There is nothing wrong with asking to stop something that has already stopped.

**Alternatives considered**: Making the plain phrase abort when busy was rejected on the indistinguishability argument above. Rejecting the plain phrase while busy was rejected because it silently loses a buffer the developer intended to send.

---

## R-106 — Reporting listening state

**Decision**: Announce every transition as it happens, and provide a command that reports state and buffer contents on demand. No persistent indicator.

**Rationale**: Three findings, and together they leave one option.

- **Transient notifications cannot be made persistent.** The host's notification call returns nothing - no handle, no dismiss, no update. It is fire-and-forget by construction. A notification that stays on screen while the microphone is live is not merely awkward to build, it is unrepresentable in the API.
- **A persistent slot surface exists, and built-in plugins use it.** Confirmed by reading the shipped binary: a built-in plugin registers `app`, `app_bottom` and `home_bottom` renderers and builds element trees through the host's element factory.
- **Whether an _external_ plugin can reach it is unproven.** Built-in plugins are compiled into the binary and resolve the rendering runtime internally. An external plugin would have to resolve it itself; the packages concerned are declared as optional peer dependencies and are not installed. No external plugin on this machine calls the slot API, so there is no working example to copy. The ergonomic form of that API is JSX, which would require a build step and therefore violate an `AGENTS.md` invariant outright.

An earlier draft resolved this with a runtime capability probe: try the element factory without JSX, fall back to signalling if it fails. That was a reasonable hedge, and it has been dropped for two reasons. First, it makes an unproven surface a load-bearing part of the design, with a second code path that only executes on machines where the probe succeeds - which is the hardest kind of behaviour to test. Second, FR-012's own stated minimum turns out to be sufficient: the developer's requirement is not to see the microphone state continuously, it is to not lose track of it. _"As long as the plugin displays something in opencode it should be good."_

So signalling is the design rather than the fallback. Every transition is announced at the moment it occurs, and `listen.status` answers on demand. Neither depends on an unproven API, neither needs a build step, and there is one code path instead of two.

The cost is honest and worth naming: there is no way to glance at the screen and see that the microphone is live. An earlier success criterion asked for exactly that within two seconds, and has been removed rather than restated more weakly, because a `void`-returning notification call cannot deliver it.

**Alternatives considered**: A terminal-multiplexer status indicator was researched in depth and is entirely feasible - the developer's existing configuration already drives status styling from user options set by external processes, so this would be idiomatic rather than novel. It was dropped on explicit instruction: _"Look forget the TMUX piece for now."_ It remains the best answer if a persistent indicator is ever wanted, and is recorded here for that reason. It has one real drawback: it spans two repositories, since the plugin sets the option but the multiplexer configuration must render it.

If a persistent indicator is wanted later, the way in is a throwaway spike against `slots.register` with a non-JSX element factory, promoted to a feature only if it works. That is a separate increment with its own evidence, not a branch inside this one.

---

## R-107 — Mutual exclusion with held-key dictation

**Decision**: The two modes are mutually exclusive. Attempting one while the other is active is refused.

**Rationale**: Both paths capture from the same microphone. Left alone, speech intended for held-key dictation is also captured continuously, transcribed twice, and reaches the agent twice - once as reviewed dictation and once inside a later buffer.

An earlier draft solved this by coordination: held-key dictation would suspend the listening session, whatever continuous capture recorded during the overlap would be discarded, and the session would resume afterwards. That is a state machine over a long-lived child process, with a discard window, verified across twenty alternating exchanges.

Refusal is the cheaper answer and loses nothing. The developer asked for both modes to exist - _"I probably want both push-to-talk and continuous modes"_ - which is a requirement about what the plugin offers, not about what can be armed simultaneously. And the two are functionally redundant while both are running: during a listening session the wake phrase already performs the submission that the held key exists to perform. Suspending one mode to run a second mode that does the same job is machinery in service of nothing.

So the second attempt is refused, with a message naming what is active and how to stop it. There is no suspend state, no discard window, no resume path, and no overlap to test. FR-017 states the exclusion and SC-010 measures the refusal.

This still depends on feature 001's Phase B fix, and the dependency is not softened by the exclusion. Two reasons. Termination by command-line pattern match cannot distinguish the two paths' recorder processes, so either can kill the other's - and mutual exclusion is enforced by the plugin, not by the operating system, so a stale process from a crashed session is exactly the case where it matters. And a fixed audio file path is shared by every capture, which is a problem within a single listening session regardless of the other mode, because segments follow each other closely enough to truncate. Ordering the phases so 001 Phase B precedes this feature avoids a defect that presents as the listening session dying at random.

---

## Resolved unknowns

| Unknown                                                 | Resolution                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Streaming transcription available?                      | No. 403 on both realtime endpoints (R-102)                         |
| How to segment continuous audio                         | Recorder's silence detection, thresholds configurable (R-101)      |
| Whether to correct continuous speech                    | No. Label as transcript (R-103)                                    |
| How to match phrases reliably                           | Normalise to locate, longest first (R-104)                         |
| What text reaches the agent                             | The original, sliced by mapped offsets. Never normalised (R-104)   |
| Plain phrase behaviour while agent busy                 | Always submits, never aborts (R-105)                               |
| Persistent indicator reachable from an external plugin? | Unproven, and no longer needed. Announce transitions (R-106)       |
| Preventing double capture                               | Modes are exclusive; the second attempt is refused (R-107)         |
| How to tune pause thresholds outside the editor         | Two lines of shell against the recorder itself (R-101)             |
| Buffer age bound                                        | Configurable, enforced on append and on submission (data-model.md) |
