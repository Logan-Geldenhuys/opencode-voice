# Implementation Plan: Continuous Listening with Wake-Phrase Submission

**Branch**: `002-continuous-wake-phrase` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-continuous-wake-phrase/spec.md`

## Summary

Add an always-listening mode. While active, audio is captured continuously, split at pauses, transcribed segment by segment, and accumulated into a buffer. When the developer speaks a wake phrase, the buffer is submitted to the agent as a prompt. A second phrase interrupts the agent first, then submits.

Technical approach: a new `lib/listen.js` module owning a long-lived capture process, driven by the host's disposal signal. It reuses feature 001's transcription, credential and audio foundations unchanged, and adds pause-based segmentation, a buffer with an age bound, and normalised wake-phrase matching.

Three design decisions are forced by measured constraints rather than chosen:

1. **No streaming.** The gateway blocks both realtime endpoints outright. Transcription happens on complete segments after a pause, which sets a hard floor on wake-phrase latency.
2. **No correction pass.** Continuous speech is submitted labelled as a transcript rather than corrected. The user asked for this directly, and it is also the better engineering answer: correction costs 1.62s on every submission and can substitute a confident wrong identifier, whereas the agent has project context that a correction pass does not.
3. **State is announced, not displayed.** The host's toast facility returns nothing — no handle, no update, no dismiss — so an external plugin cannot hold a persistent indicator open. Rather than pursue the one unproven mechanism that might, the design announces every transition and answers a status command on demand.

Four mechanisms were specified during planning and are deliberately not built. A per-word homophone substitution map, because the distortions it was meant to absorb span word boundaries and configured phrase variants express them strictly better. A capability probe for a persistent indicator, because the surface is unproven from external plugins and its ergonomic form needs a build step. A suspend-and-resume protocol between the two capture modes, because refusing the second mode is sufficient and involves no protocol. And a Node harness for tuning segmentation, because the recorder already segments to numbered files from the shell in one line. Each removal is recorded in [research.md](./research.md) with the reason.

## Technical Context

**Language/Version**: JavaScript, ESM only. Node.js 22.22.3 locally; CI runs Node 24.

**Primary Dependencies**: None at runtime. Depends on feature 001 within this repository.

**Storage**: `api.kv` for the listening preference and wake-phrase configuration. Buffer is in-memory only and never persisted — persisting speech would defeat the age bound in FR-014.

**Testing**: `node --test`. Wake-phrase matching and buffer behaviour are pure functions and get direct unit tests. Segmentation sensitivity is tuned by running the recorder directly from the shell, documented in [quickstart.md](./quickstart.md) rather than built as a tool (FR-021).

**Target Platform**: Ubuntu under WSL2, opencode TUI 1.18.21.

**Project Type**: Single TUI plugin. Adds one module.

**Performance Goals**: SC-001 — 3s p50, 6s p95 from the end of the wake phrase to the agent receiving the prompt. Budget: pause detection ~0.5s, transcription 0.75s, matching and submission negligible. The absence of a correction pass is what makes this reachable.

**Constraints**: No build step. Zero runtime dependencies. No streaming transcription available. Segment audio must not outlive its transcription. Continuous capture and held-key dictation must never be active at the same time. Submitted text must carry the speaker's original casing and punctuation (FR-023), so the normalised form used for matching must not be the form that is sent.

**Scale/Scope**: One developer, one microphone. Sessions of minutes to hours. Two files added (`lib/listen.js`, `lib/wake.js`), two modified (`index.js`, `lib/stt.js`), two test files added.

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
index.js                 # MODIFIED. Register listening commands
lib/
├── listen.js            # NEW. Session, segmentation, buffer, submission
├── wake.js              # NEW. Phrase normalisation and matching. Pure functions
├── stt.js               # MODIFIED. Reuse 001's capture object; refuse while listening
└── auth.js              # From 001. Unchanged
test/
├── wake.test.js         # NEW. Matching, prefix resolution, variants, original-text spans
├── listen.test.js       # NEW. Buffer, age bound, mode exclusion
└── stt.test.js          # MODIFIED
```

**Structure Decision**: Flat layout retained for the reasons given in feature 001's plan. `wake.js` is separate from `listen.js` because matching is pure and heavily tested, while the session is stateful and I/O-bound; mixing them would make the matching logic hard to test at the volume SC-002 and SC-003 demand.

No `lib/indicator.js` and no `tools/` directory. Both appeared in an earlier draft: the first to probe for a persistent rendering surface, the second to tune segmentation outside the editor. The indicator is gone because FR-012 no longer asks for a persistent display. The harness is gone because the recorder already does the job from the shell — `sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart` writes one numbered file per detected utterance, and `soxi -D seg*.wav` prints their durations. That is a documented procedure, not a module, and it exercises the same code path the plugin uses rather than a parallel reimplementation of it.

## Complexity Tracking

> Not filled. The Constitution Check records no violations.

## Phase 0 — Research

Complete. See [research.md](./research.md). Zero `NEEDS CLARIFICATION` remain.

- **R-101** Segmentation: pause-based via the recorder's own silence detection
- **R-102** Streaming: unavailable, 403 on both realtime endpoints
- **R-103** No correction pass on continuous speech
- **R-104** Wake-phrase matching: normalise to locate, slice the original to submit
- **R-105** Agent interruption: session abort, then submit
- **R-106** Listening state: announced transitions plus an on-demand status command
- **R-107** Mode exclusion: refuse the second mode rather than coordinate both

## Phase 1 — Design

Complete. Artifacts: [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

## Implementation Phases

### Prerequisite — 001 Phase B

**No phase below may begin before feature 001's Phase B is complete.** Phase B is where capture becomes an object that owns its own process handle and its own audio file. Two things follow from it that this feature depends on absolutely.

First, until it lands, termination is by command-line pattern match, so starting a second recorder means either path can kill the other's process. Second, until it lands, the audio path is a fixed constant, so two concurrent captures write the same file and one truncates the other.

An earlier draft of this plan opened with its own Phase A to "extract the pieces this feature needs" from 001. That phase no longer exists, and its removal is the point: 001's Phase B was rewritten to produce a capture object rather than to patch four defects in place, so the reuse surface this feature needs is what 001 already builds. There is nothing to extract. Had both been left as drafted, 001 would have built a thing and 002 would have immediately refactored it — a retrofit scheduled in advance.

**Exit criteria for the prerequisite**: 001's tests pass; capture is startable and stoppable through an object whose disposal is independent of any other capture.

### Phase A — Wake-phrase matching (FR-003 to FR-005, FR-008, FR-022, FR-023)

`lib/wake.js`, pure functions. Normalise transcript text — case, punctuation, whitespace — then search for configured phrases and their configured variants. When phrases share a prefix the longer wins (FR-005), enforced by sorting the compiled phrase list by length at compile time rather than by a rule in the search loop, so a caller cannot bypass it.

Matching returns the position of the match **mapped back into the original text**, not into the normalised text (FR-023). The buffer is an ordered list of segment strings, so the module controls the join and can map a normalised offset to a segment index and character offset within it, then slice the originals. Text before the phrase is submitted, the phrase is excluded, text after carries forward (FR-008) — all three as spoken, with capitalisation and punctuation intact.

This mapping is the one place in the feature where the design deliberately adds code rather than removing it. Returning normalised text would be perhaps fifteen lines shorter and would destroy exactly the tokens that matter: `Server.tsx` normalises to `servertsx`, and sentence boundaries across a multi-minute buffer vanish. The failure would be invisible in testing, because normalised prose still reads perfectly well.

There is no homophone substitution map. Configured variants subsume it and express more: the motivating distortion was `opencode` splitting into `open code`, which crosses a word boundary and which no per-word substitution can represent.

**Exit criteria**: `test/wake.test.js` covers the SC-002 variant set, asserts SC-003's zero misclassifications, and asserts SC-011 by round-tripping text containing file paths, identifiers and punctuation. This is where the highest test density belongs — it is the feature's correctness core and it is cheap to test exhaustively.

### Phase B — Listening session (FR-001, FR-002, FR-011, FR-012, FR-015, FR-017 to FR-020)

`lib/listen.js`. One capture process for the session's lifetime, emitting segments at pauses. Each segment is length-checked, transcribed, appended to the buffer, and its audio deleted whether transcription succeeded or failed. Segment failures are logged and dropped without ending the session (FR-019).

Teardown is bound to the host's disposal signal, which also aborts in-flight transcription requests (FR-020). Listening never starts implicitly (FR-011).

Mode exclusion is a precondition, not a protocol (FR-017). Starting listening while a held-key capture is in progress is refused; starting a held-key capture while listening is active is refused. Each refusal names the mode that is running and how to stop it. There is no suspend, no discard window and no resume, because there is never a moment when both are armed — and while listening, the wake phrase already does what the held key exists to do, so the exclusion costs the developer nothing.

Every transition is announced as it happens (FR-012), and a status command reports whether listening is active and what the buffer holds.

**Exit criteria**: an hour-long session survives injected failures at one in five (SC-008); no audio accumulates (SC-006); killing the editor leaves nothing running; every attempt to run one mode while the other is active is refused with the active mode named (SC-010); every transition produces a signal and the status command answers correctly, including mid-transcription (SC-007).

### Phase C — Buffer and submission (FR-006, FR-007, FR-009, FR-013, FR-014, FR-016)

Buffer with an age bound: entries older than the configured maximum are dropped so a later wake phrase cannot submit speech from much earlier (FR-014, SC-009). Inspect and discard commands (FR-013).

On the submission phrase: assemble, prefix the transcript label (FR-009), submit, clear. On the interrupt phrase: abort the agent's current work first, then the same (FR-007). An empty buffer submits nothing and says why (FR-016).

Detection runs after every segment is appended, which means the buffer can hold at most one undetected wake phrase at any moment — an earlier one would already have fired and cleared. An earlier draft of the matching contract specified that the last occurrence wins when several are present. That rule is unobservable under this invariant and has been removed rather than implemented; a test asserts the invariant instead.

Speech transcribed while a submission is being assembled belongs to the next buffer, not this one and not nowhere — the spec's _speech arrives while a submission is being assembled_ edge case. Snapshot and clear under a guard, then submit from the snapshot.

**Exit criteria**: all User Story 1 and 2 acceptance scenarios pass; SC-009 holds; SC-011 holds end to end, not only in `wake.js` unit tests.

## Risks

| Risk                                                      | Impact                                                 | Mitigation                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause detection cuts mid-sentence                         | Fragmented buffer, wake phrase split                   | FR-004 matches against the buffer, not segments, so a split phrase still matches. Shell procedure for tuning                                                |
| Wake phrase fires during conversation about the feature   | Unintended submission                                  | Accepted in the spec. Recovery is stop listening, discard buffer. SC-004 tests only phrase-free conversation                                                |
| Listening left on and forgotten                           | Cost, and unrelated speech leaving the machine         | Age bound (FR-014) plus announced transitions and a status command (FR-012). The main hazard, and the reason User Story 3 exists                            |
| Normalised text reaches the agent instead of the original | Identifiers lowercased, punctuation stripped, silently | FR-023 forbids it and SC-011 measures it character for character. The mapping is unit-tested on `Server.tsx` specifically, because prose hides this failure |
| Agent busy when a plain submission fires                  | Undefined behaviour                                    | Behaviour must be defined and consistent, not timing-dependent — see research.md R-105                                                                      |
| Segment transcription cost                                | Every utterance is a paid request                      | Minimum duration gate (FR-015). SC-005 asserts silence and noise generate none                                                                              |

## Out of Scope

Spoken output. Speaker identification and separating the developer's voice from others in the room. Distinguishing mention of a wake phrase from use of it. On-device transcription, rejected in feature 001.
