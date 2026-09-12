# Implementation Plan: Continuous Listening with Wake-Phrase Submission

**Branch**: `002-continuous-wake-phrase` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-continuous-wake-phrase/spec.md`

## Summary

Add an always-listening mode. While active, audio is captured continuously, split at pauses, transcribed segment by segment, and accumulated into a buffer. When the developer speaks a wake phrase, the buffer is submitted to the agent as a prompt. A second phrase interrupts the agent first, then submits.

Technical approach: a new `lib/listen.js` module that runs **one recorder per utterance**, each exiting of its own accord when the speaker pauses, driven by the host's disposal signal. It reuses feature 001's transcription, credential and capture foundations, and adds an age- and size-bounded buffer and token-aligned wake-phrase matching.

Three design decisions are forced by measured constraints rather than chosen:

1. **No streaming.** The gateway blocks both realtime endpoints outright. Transcription happens on complete segments after a pause, which sets a hard floor on wake-phrase latency.
2. **No correction pass.** Continuous speech is submitted labelled as a transcript rather than corrected. The user asked for this directly, and it is also the better engineering answer: correction costs 1.62s on every submission and can substitute a confident wrong identifier, whereas the agent has project context that a correction pass does not.
3. **State is announced, not displayed.** The host's toast facility returns nothing — no handle, no update, no dismiss — so an external plugin cannot hold a persistent indicator open. Rather than pursue the one unproven mechanism that might, the design announces every transition and answers a status command on demand.

Because transcription is request/response, something must decide that a stretch of speech is finished and hand over a complete file. Only the recorder has the samples, so the recorder decides — that much is forced. What remains is a genuine choice: **how the recorder reports that a file is finished.** A process has exactly two channels for that. It can write the next file and leave the previous one to be inferred complete, or it can exit, at which point the operating system closes the descriptor and finalises the header. This plan takes the second, because a signal the kernel guarantees is worth more than a side effect reconstructed from a directory listing, and because measurement showed the two produce byte-identical segment boundaries. R-101 in [research.md](./research.md) records the evidence.

Five mechanisms were specified during planning and are deliberately not built. A per-word homophone substitution map, because the distortions it was meant to absorb span word boundaries and configured phrase variants express them strictly better. A capability probe for a persistent indicator, because the surface is unproven from external plugins and its ergonomic form needs a build step. A suspend-and-resume protocol between the two capture modes, because refusing the second mode is sufficient and involves no protocol. A Node harness for tuning segmentation, because the recorder already segments to numbered files from the shell in one line. And a directory watcher with segment-completion inference, because a recorder that exits has already said everything the watcher was going to work out. Each removal is recorded in [research.md](./research.md) with the reason.

## Technical Context

**Language/Version**: JavaScript, ESM only. Node.js 22.22.3 locally; CI runs Node 24.

**Primary Dependencies**: None at runtime. Depends on feature 001 within this repository.

**Storage**: `api.kv` for the listening preference and wake-phrase configuration. Buffer is in-memory only and never persisted — persisting speech would defeat the bounds in FR-014.

**Testing**: `node --test`. Wake-phrase matching and buffer behaviour are pure functions and get direct unit tests. Segmentation sensitivity is tuned by running the recorder directly from the shell, and the accepted forms of each wake phrase are calibrated against the developer's own voice, both documented in [quickstart.md](./quickstart.md) rather than built as tools (FR-021, SC-012). Neither is a continuous-integration gate: their inputs are a room and a voice, and their outputs are configuration.

**Target Platform**: Ubuntu under WSL2, opencode TUI 1.18.21.

**Project Type**: Single TUI plugin. Adds one module.

**Performance Goals**: SC-001 — 3s p50, 6s p95 from the end of the wake phrase to the agent receiving the prompt. Budget: 0.7s waiting out the configured pause before the recorder exits, 0.75s transcription, matching and submission negligible — roughly 1.5s, with the rest of the budget as headroom for a slow request. The absence of a correction pass is what makes this reachable; adding one would spend 1.62s of the remaining 1.5s at the p50 target. The pause is a floor set by the silence threshold, so no design choice here moves it.

**Constraints**: No build step. Zero runtime dependencies. No streaming transcription available. Segment audio must not outlive its transcription. Continuous capture and held-key dictation must never be active at the same time, and the check that enforces this must consult one shared record of what is capturing rather than two per-mode flags that can disagree. Submitted text must carry the speaker's original casing and punctuation (FR-023), so no normalised string may be the thing that is sent.

**Scale/Scope**: One developer, one microphone. Sessions of minutes to hours. Three files added (`lib/wake.js`, `lib/listen.js`, and `lib/capture.js` extracted out of `lib/stt.js`), two modified (`index.js`, `lib/stt.js`), three test files added.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

`.specify/memory/constitution.md` remains an unfilled template, so as in feature 001 the `AGENTS.md` "Key invariants" section is treated as the de-facto constitution.

| Invariant                                                                   | Status           | Note                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Single default export `{ id, tui }`, no server plugin                       | PASS             | `lib/listen.js` is registered from the same entry point                                                                    |
| LLM calls use OpenAI chat completions, not Anthropic messages               | PASS — vacuously | This feature makes no LLM calls at all (FR-010)                                                                            |
| Configuration via `options` (static) and `api.kv` (runtime). No dotfile I/O | PASS             | Buffer is in-memory; capture files are OS temp only. The credential read inherited from 001 is already accounted for there |
| No build step. Plain ESM JavaScript, shipped as-is                          | PASS             | Nothing in the feature needs compilation. See below                                                                        |

**On the fourth invariant.** An earlier draft of this plan recorded it as AT RISK, because a persistent listening indicator would need a component tree whose ergonomic form is JSX, and JSX needs compiling. That risk is now gone rather than mitigated: FR-012 was rewritten to require announced transitions and an on-demand status command, both of which the host's existing toast and command facilities provide directly. No rendering surface is probed, no element factory is called, no build step is implied. The invariant holds by construction instead of by careful avoidance.

**Post-design re-check**: PASS on all four. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/002-continuous-wake-phrase/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── listen-options.md
│   ├── commands.md
│   └── wake-phrase.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
index.js                 # MODIFIED. Register listening commands; drain the capture registry on dispose
lib/
├── capture.js           # NEW, by extraction. Capture registry, temp dir, sequence, teardown
├── listen.js            # NEW. Session, per-utterance recorders, buffer, submission
├── wake.js              # NEW. Phrase tokenisation and matching. Pure functions
├── stt.js               # MODIFIED. Import capture ownership from lib/capture.js
└── auth.js              # From 001. Unchanged
test/
├── wake.test.js         # NEW. Matching, prefix resolution, variants, original-text spans
├── listen.test.js       # NEW. Buffer, bounds, eviction, mode exclusion
├── capture.test.js      # NEW. Registry, drain, exit-hook coverage of both modes
└── stt.test.js          # MODIFIED
```

**Structure Decision**: Flat layout retained for the reasons given in feature 001's plan. `wake.js` is separate from `listen.js` because matching is pure and heavily tested, while the session is stateful and I/O-bound; mixing them would make the matching logic hard to test at the volume SC-002 and SC-003 demand.

`lib/capture.js` is an extraction, not an invention. Feature 001 already built the capture object this feature needs, but it kept the temp directory, the filename sequence and the live-capture handle private to `lib/stt.js`, and wired the process exit hook to a single module-scoped variable. Nothing 002 creates would be visible to that hook. Rather than duplicate teardown in `listen.js` and hope the two copies stay in agreement, the ownership moves to one module that both modes register with. See Phase A0.

No `lib/indicator.js` and no `tools/` directory. Both appeared in an earlier draft: the first to probe for a persistent rendering surface, the second to tune segmentation outside the editor. The indicator is gone because FR-012 no longer asks for a persistent display. The harness is gone because the recorder already does the job from the shell — `sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart` writes one numbered file per detected utterance, and `soxi -D seg*.wav` prints their durations.

That one-liner uses `newfile : restart` while the plugin runs one recorder per utterance, so it is worth being precise about why it is still the right procedure. What is being tuned is the silence effect's parameters, and those are identical in both. Measurement confirms the consequence: given the same input, `newfile : restart` and a single-shot recorder that exits on the first pause cut at the same sample. So the durations the shell prints are the durations the plugin will see. The procedure observes the plugin's segmentation without reimplementing it — which is what an actual harness would have done, and why it would have been possible to tune it correctly while the plugin stayed wrong.

## Complexity Tracking

> Not filled. The Constitution Check records no violations.

## Phase 0 — Research

Complete. See [research.md](./research.md). Zero `NEEDS CLARIFICATION` remain.

- **R-101** Segmentation: one recorder per utterance, completion signalled by process exit
- **R-102** Streaming: unavailable, 403 on both realtime endpoints
- **R-103** No correction pass on continuous speech
- **R-104** Wake-phrase matching: token spans into the original text, never a normalised string
- **R-105** Agent interruption: session abort, then submit
- **R-106** Listening state: announced transitions plus an on-demand status command
- **R-107** Mode exclusion: refuse the second mode rather than coordinate both
- **R-108** Capture ownership: one registry both modes join, rather than a per-module singleton
- **R-109** Submission assembly: mutate the buffer synchronously before the first await, rather than lock it
- **R-110** Wake-phrase recognition: calibrated once into configuration, not measured by an audio benchmark

## Phase 1 — Design

Complete. Artifacts: [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

## Implementation Phases

### Prerequisite — 001's capture object

**Satisfied.** Feature 001 is implemented on this branch and its tests pass. `createCapture({ process, path, logger })` returns an object owning one recorder and one audio file, exposing an `exited` promise settled from both the `exit` and `error` events, a `stop()` that sends SIGINT and escalates on a bounded timer, a `terminate()` that escalates SIGTERM to SIGKILL, and a `removeAudio()` that tolerates a missing file. Termination is by tracked handle; the command-line pattern match that could kill an unrelated process is gone.

That object is the load-bearing reuse, and it is reused as built. Phase A0 below changes only who owns the _collection_ of captures, not what a capture is.

An earlier draft of this plan opened with its own phase to "extract the pieces this feature needs" from 001, and that phase was removed on the grounds that 001 now produces the capture object directly. The removal was right about the object and wrong about the ownership: 001 builds exactly the capture this feature wants, but keeps the registry of live captures, the temp directory and the filename sequence private, so a capture created by `listen.js` would be invisible to the teardown that `index.js` wires up. Phase A0 is that gap, correctly scoped this time — twenty-odd lines of relocation rather than a refactor of the thing itself.

### Phase A0 — Capture ownership (FR-017, FR-020)

Move the capture registry out of `lib/stt.js` into `lib/capture.js`: the temp directory helper, the filename sequence, the record of what is currently capturing, the async drain, and the synchronous drain used by the process exit hook. Generalise the record from one nullable slot to a set, because this feature creates a capture per utterance and the exit hook must find whichever one is live at that instant. `lib/stt.js` imports it and behaves exactly as it does now.

This is the only place in the feature where 001's code is modified rather than called, and it is worth being clear about why it is not optional. Two requirements depend on it directly. FR-020 asks that abnormal exit leave no recorder running and no audio on disk; the exit hook currently reaches one module-scoped variable, so without this phase an abnormal exit during a listening session leaves a live recorder and a recording of the developer's voice behind. FR-017 asks that the two capture modes never both be active; without a shared record, the check compares a flag in `listen.js` against a variable in `stt.js`, which is two facts that can disagree — the precise defect class 001's own commentary says the capture object was introduced to eliminate.

**Exit criteria**: 001's existing tests pass unchanged. `test/capture.test.js` asserts that a capture created outside `stt.js` is drained by the same teardown path, and that the synchronous drain kills every live capture rather than one.

### Phase A — Wake-phrase matching (FR-003 to FR-005, FR-008, FR-022, FR-023)

`lib/wake.js`, pure functions. Tokenise each buffer entry into words that each carry the offsets they occupied in the **original** text. Match a configured phrase as a contiguous run of those tokens. Slice the text before and after the run out of the originals, by offset. When phrases share a prefix the longer wins (FR-005), enforced by sorting the compiled phrase list by token count at compile time rather than by a rule in the search loop, so a caller cannot bypass it.

No normalised string is ever assembled. This is the point of the token approach, and it replaces an earlier design that built a normalised join of the buffer, matched inside it, and mapped the resulting offsets back to a segment index and a character offset. That draft called the mapping the one place in the feature that deliberately added code. It was adding code to recover information it had just discarded: tokens carry their own provenance, so there is no offset space to map back _from_.

Three consequences, in descending order of how much they matter:

1. **FR-023 holds by construction.** Text is only ever sliced out of what the speaker actually said. `Server.tsx` cannot arrive as `servertsx`, because nothing is ever reconstructed from normalised forms — the token `server` merely points at where `Server` is.
2. **Word-boundary alignment stops being a rule.** An earlier matching rule required matches to align to word boundaries in normalised text, so that `submitted` could not match a phrase containing `submit`. A token run cannot partially match a token, so the rule has no work left to do and is deleted rather than tested.
3. **Punctuation tolerance is structural.** `opencode, execute!` tokenises to the same two words as `opencode execute`, because punctuation is simply not part of any token.

There is no homophone substitution map. Configured variants subsume it and express more: the motivating distortion was `opencode` splitting into `open code`, which crosses a word boundary and which no per-word substitution can represent.

**Exit criteria**: `test/wake.test.js` covers every configured accepted form (SC-002 at 100%, not a sample), asserts SC-003's zero misclassifications, and asserts SC-011 by round-tripping text containing file paths, identifiers and punctuation — with `Server.tsx` named as its own case rather than folded into a general casing assertion, because prose hides this failure. This is where the highest test density belongs: it is the feature's correctness core and it is cheap to test exhaustively.

### Phase B — Listening session (FR-001, FR-002, FR-011, FR-012, FR-015, FR-017 to FR-020)

`lib/listen.js`. A loop: spawn a recorder configured to trim leading silence and stop after the configured trailing pause, await its `exited` promise, and spawn the next. One recorder per utterance. Each finished capture is length-checked against the minimum duration, transcribed, appended to the buffer, and its audio deleted whether transcription succeeded or failed. Segment failures are logged and dropped without ending the session (FR-019).

The recorder's exit _is_ the segment boundary, so nothing needs to detect one. `capture.exited` already resolves on both `exit` and `error`, and a file whose writer has exited is finalised by the operating system rather than by inference. There is no directory watcher, no sequence-number parsing, no rule for deciding when a file stopped growing, and no empty placeholder file to tell apart from a real segment. `listenMaxSegmentMs` is a `setTimeout` that calls `capture.stop()`, which is the same path a normal stop takes rather than a second mechanism reserved for when things go wrong.

The one cost is that no audio is captured between one recorder exiting and the next being ready, measured at roughly 130ms. That window lands inside a pause by construction: the effect chain trims leading silence, so a fresh recorder is not recording from its first sample, it is waiting for speech. Losing anything requires resuming speech within 130ms of the 700ms pause that just ended the previous segment, and the worst case is the attack of one syllable — which FR-004's buffer-wide matching already absorbs.

Repeated consecutive segment failures are surfaced even though single ones are not. Dropping every segment silently satisfies FR-019 to the letter while leaving the developer talking to a microphone that is recording nothing.

Teardown is bound to the host's disposal signal, which stops the loop, drains the capture registry from Phase A0, and aborts in-flight transcription requests rather than awaiting them (FR-020). Listening never starts implicitly (FR-011).

Mode exclusion is a precondition, not a protocol (FR-017). Starting listening while a held-key capture is in progress is refused; starting a held-key capture while listening is active is refused. Each refusal names the mode that is running and how to stop it. There is no suspend, no discard window and no resume, because there is never a moment when both are armed — and while listening, the wake phrase already does what the held key exists to do, so the exclusion costs the developer nothing.

Every transition is announced as it happens (FR-012), and a status command reports whether listening is active and what the buffer holds.

**Exit criteria**: a session survives injected transcription failures at one in five (SC-008); captures below the minimum duration issue no request (SC-005); no audio accumulates (SC-006); killing the editor leaves nothing running; every attempt to run one mode while the other is active is refused with the active mode named (SC-010); every transition produces a signal and the status command answers correctly, including mid-transcription (SC-007).

### Phase C — Buffer and submission (FR-006, FR-007, FR-009, FR-013, FR-014, FR-016)

Buffer bounded on two axes (FR-014, SC-009): a maximum age, and a maximum size. Both evict the oldest entries first, and both evict **whole entries** — never part of one, because an entry's tokens carry offsets into its own text and a partial slice would leave them pointing at text that is no longer there. Size is the bound that fires when the developer has been talking; age is the bound that fires when they have not. Inspect and discard are folded into the status command and a discard command (FR-013): status already reports how much is buffered, and showing the text is the whole of what a separate inspect command would have added.

On the submission phrase: assemble, prefix the transcript label (FR-009), submit, clear. On the interrupt phrase: abort the agent's current work first, then the same (FR-007). An empty buffer submits nothing and says why (FR-016).

Detection runs after every segment is appended, which means the buffer can hold at most one undetected wake phrase at any moment — an earlier one would already have fired and cleared. An earlier draft of the matching contract specified that the last occurrence wins when several are present. That rule is unobservable under this invariant and has been removed rather than implemented; a test asserts the invariant instead.

Speech transcribed while a submission is being assembled belongs to the next buffer, not this one and not nowhere — the spec's _speech arrives while a submission is being assembled_ edge case. An earlier draft required this to happen "under a guard that blocks appends", which is a lock, with everything a lock brings. It is not needed. Appends only ever run in continuations after an `await`, so a synchronous run cannot be interleaved. Ordering the steps so that every buffer mutation completes before the first `await` makes the window not merely guarded but non-existent: expire, locate, slice, and empty the buffer, all in one tick; then label and submit from the value already in hand. The requirement is met by choosing an order rather than by adding a mechanism, and the earlier draft's description of this as the one place a race produces silently wrong behaviour no longer applies.

**Exit criteria**: all User Story 1 and 2 acceptance scenarios pass; both bounds evict oldest-first and whole-entry (SC-009); SC-011 holds end to end, not only in `wake.js` unit tests.

## Risks

| Risk                                                      | Impact                                                 | Mitigation                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause detection cuts mid-sentence                         | Fragmented buffer, wake phrase split                   | FR-004 matches against the buffer, not segments, so a split phrase still matches. Shell procedure for tuning                                                                      |
| Wake phrase fires during conversation about the feature   | Unintended submission                                  | Accepted in the spec. Recovery is stop listening, discard buffer. SC-004 tests only phrase-free conversation                                                                      |
| Listening left on and forgotten                           | Cost, and unrelated speech leaving the machine         | Both buffer bounds (FR-014) plus announced transitions and a status command (FR-012). The main hazard, and the reason User Story 3 exists                                         |
| Normalised text reaches the agent instead of the original | Identifiers lowercased, punctuation stripped, silently | Unreachable rather than forbidden: no normalised string is ever assembled, so there is nothing to accidentally send. SC-011 measures it anyway, with `Server.tsx` as a named case |
| Agent busy when a plain submission fires                  | Undefined behaviour                                    | Behaviour must be defined and consistent, not timing-dependent — see research.md R-105                                                                                            |
| Segment transcription cost                                | Every utterance is a paid request                      | Minimum duration gate (FR-015), enforced before the request is built. SC-005 asserts captures below the threshold issue none                                                      |
| A capture created by `listen.js` is invisible to teardown | Live recorder and voice audio left behind on exit      | Phase A0 moves the registry to `lib/capture.js` so both modes register with one record. Without it FR-020 and FR-017 are unenforceable, not merely untested                       |
| Speech lost in the gap between consecutive recorders      | A clipped syllable at the start of an utterance        | Measured at ~130ms, and the leading-silence trim places it inside a pause. FR-004 matches buffer-wide, so a clipped word does not break detection                                 |

## Out of Scope

Spoken output. Speaker identification and separating the developer's voice from others in the room. Distinguishing mention of a wake phrase from use of it. On-device transcription, rejected in feature 001.
