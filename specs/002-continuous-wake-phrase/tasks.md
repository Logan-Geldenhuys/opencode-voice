---
description: "Task list for 002-continuous-wake-phrase"
---

# Tasks: Continuous Listening with Wake-Phrase Submission

**Input**: Design documents from `/specs/002-continuous-wake-phrase/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The plan requests them explicitly: the Project Structure lists `test/wake.test.js`, `test/listen.test.js` and `test/capture.test.js` as new, and Phase A's exit criteria call `wake.js` the feature's correctness core and ask for the highest test density in the repository.

**Organization**: Tasks are grouped by user story where a story owns the work. See the note below on phase distribution.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Flat layout, retained per plan.md Structure Decision: `index.js` and `lib/` at repository root, tests in `test/`. There is no `src/`. The `files: ["index.js", "lib"]` publish contract in `package.json` depends on this.

## Note on phase distribution

Foundational is large, and deliberately so. Three of the plan's four implementation phases are prerequisites that no single story owns.

Phase A0 relocates capture ownership, and two requirements are unenforceable without it (FR-017, FR-020). Phase A is the wake-phrase matcher, which User Story 1 and User Story 2 both depend on and which is pure enough to test exhaustively before any session exists. Phase B's session loop is what every story runs through.

The listening toggle is also foundational rather than part of User Story 3, even though visibility is that story's subject. User Story 1's independent test begins "turn on listening", so the toggle has to exist before any story can be exercised. What User Story 3 owns is the visibility built on top of it: announcing every transition, reporting state on demand, and discarding without submitting.

Attempting to distribute this across the stories would create false independence. Nothing can be observed at all until a recorder runs, a segment transcribes, and text accumulates.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the prerequisites hold and establish the two environment-specific values the feature cannot supply defaults for

- [X] T001 Record the baseline at repository root: `npm run check` clean and `npm run test` at 58 passing, so any later regression is distinguishable from a pre-existing failure
- [X] T002 Confirm the capture prerequisite: `sox --version` reports 14.4.2 and `sox --help` lists the `silence` effect, which is what divides audio at pauses per research.md R-101
- [ ] T003 Tune pause sensitivity per step 1 of `specs/002-continuous-wake-phrase/quickstart.md` using `sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart` and `soxi -D seg*.wav`, and record the working values for `listenSilenceDurationMs` and `listenSilenceThreshold` (FR-021)
- [ ] T004 Add the listen options block to the host's `~/.config/opencode/tui.jsonc` per step 2 of `specs/002-continuous-wake-phrase/quickstart.md`, using the values from T003 and leaving `listenAutoSubmit` at `false` until T031 has calibrated the phrases

**Checkpoint**: Baseline recorded, capture tooling confirmed, pause thresholds measured on this microphone rather than assumed

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Capture ownership, wake-phrase matching, and the listening session. None is owned by a single story.

**CRITICAL**: No user story work can begin until this phase is complete

### Capture ownership (plan Phase A0, FR-017 and FR-020)

- [X] T005 Create `lib/capture.js` and move into it from `lib/stt.js`: the temp directory helper `ensureCaptureDir()`, the filename sequence behind `buildCapturePath()`, the record of what is currently capturing, the async drain `stopActiveCapture()`, and the synchronous drain `disposeCapturesSync()`. Leave `createCapture()` itself unchanged, per plan.md Prerequisite
- [X] T006 Generalise the live-capture record in `lib/capture.js` from one nullable slot to a set with register and unregister, so the async drain terminates and removes audio for every live capture and the synchronous drain SIGKILLs and unlinks every live capture rather than one, per research.md R-108
- [X] T007 Re-point `lib/stt.js` at `lib/capture.js` with no behaviour change: held-key dictation still allows at most one capture at a time and still allocates one file per capture
- [X] T008 Re-point the `api.lifecycle.onDispose` registration and the `process.once("exit")` hook in `index.js` at the `lib/capture.js` drains, so a capture created by any module is reachable by teardown
- [X] T009 [P] Create `test/capture.test.js` asserting: a capture created outside `lib/stt.js` is drained by the same teardown path; the synchronous drain kills every live capture rather than the most recent; the registry is empty after a drain; and unregistering a capture that already exited is harmless

**Checkpoint A0**: 001's existing tests pass unchanged and both capture modes share one record of what is live

### Wake-phrase matching (plan Phase A, FR-003 to FR-005, FR-008, FR-022, FR-023)

- [ ] T010 Create `lib/wake.js` exporting `tokenise(text)` returning `[{norm, start, end}]`, where `start` and `end` are offsets into the text passed in, so `text.slice(start, end)` returns the word as it was spoken, per `specs/002-continuous-wake-phrase/contracts/wake-phrase.md`
- [ ] T011 Implement `compilePhrases(config)` in `lib/wake.js`, normalising each canonical form and variant through `tokenise` and sorting the compiled set by token count descending so FR-005 is structural rather than a rule in the search loop. Reject at compile time: an empty list, a phrase tokenising to zero tokens, a single-token phrase, and two different actions compiling to the same token sequence
- [ ] T012 Implement `findWake(entries, compiled)` in `lib/wake.js` returning `null` or `{action, matched, before, after}`, matching a phrase as a contiguous run of tokens across the concatenated entries rather than within any single one, so a phrase spoken across a pause is still found (FR-004), and slicing `before` and `after` out of the original entry texts by offset. Assemble no normalised string at any point (FR-023)
- [ ] T013 [P] Create `test/wake.test.js` covering the test obligations table in `specs/002-continuous-wake-phrase/contracts/wake-phrase.md`: the `tokenise` span round trip; every configured accepted form resolving correctly (SC-002 at 100%, exhaustive not sampled); zero interrupt-resolved-as-plain (SC-003); a match spanning an entry boundary mapping back into both originals; `submitted` not matching a phrase containing `submit`; the at-most-one-phrase invariant; phrase-free technical conversation matching nothing; every compile-time rejection; and `Server.tsx` round-tripping as its own named case rather than folded into a general casing assertion

**Checkpoint A**: matching is correct and exhaustively tested before anything stateful depends on it

### Listening session (plan Phase B, FR-001, FR-002, FR-011, FR-015, FR-017 to FR-020)

- [ ] T014 Add the `listen*` option defaults and validation to `index.js` per `specs/002-continuous-wake-phrase/contracts/listen-options.md`: `listenSilenceDurationMs` 700, `listenSilenceThreshold` `"2%"`, `listenMinSegmentMs` 400, `listenMaxSegmentMs` 30000, `listenMaxBufferAgeMs` 3600000, `listenMaxBufferChars` 64000, `listenAutoSubmit` true, plus `listenWakePhrases` and `listenTranscriptLabel`. Validate the numeric bounds and that `listenMinSegmentMs` is less than `listenMaxSegmentMs`, and leave `listenSilenceThreshold` unvalidated so a bad value surfaces as the recorder's own error
- [ ] T015 Create `lib/listen.js` with the per-utterance recorder loop: spawn a recorder configured to trim leading silence and stop after the configured trailing pause, wrap it with `createCapture()`, await its `exited` promise, then spawn the next. The recorder's exit is the segment boundary, so implement no directory watcher, no sequence-number parsing and no stopped-growing rule, per research.md R-101
- [ ] T016 Implement the duration gates in `lib/listen.js`: a finished capture shorter than `listenMinSegmentMs` is discarded without a transcription request being built (FR-015), and `listenMaxSegmentMs` is a `setTimeout` calling `capture.stop()` so the recorder exits down the same path a pause would have taken it
- [ ] T017 Transcribe each accepted segment in `lib/listen.js` by reusing feature 001's transcription path and credential resolver unchanged, delete the segment audio in a `finally` so it goes on both the success and failure path (FR-018), and drop a failed segment without ending the session (FR-019)
- [ ] T018 Surface repeated consecutive segment failures in `lib/listen.js` while leaving a single failure logged only, per the error contract in `specs/002-continuous-wake-phrase/contracts/commands.md`, because dropping every segment silently satisfies FR-019 to the letter while leaving the developer talking to a microphone that is recording nothing
- [ ] T019 Enforce mode exclusion in both directions by consulting the `lib/capture.js` registry rather than a flag in each module (FR-017): starting listening while a held-key capture is in progress is refused, starting a held-key capture while listening is active is refused, and each refusal names the active mode and how to stop it
- [ ] T020 Bind teardown in `lib/listen.js` to the host disposal signal so it stops the loop, drains the capture registry, and aborts in-flight transcription requests rather than awaiting them (FR-020)
- [ ] T021 Register the listening toggle command in `index.js` as `listen.toggle` with `slash: { name: "listen-toggle" }`, matching the `stt.*` registration style already in `lib/stt.js`. Listening MUST NOT begin implicitly at editor start and no was-listening flag is persisted (FR-011)
- [ ] T022 [P] Create `test/listen.test.js` covering the segment gates and mode exclusion: a capture below the minimum duration issues no request; a capture at the maximum duration is stopped through `capture.stop()`; each exclusion direction is refused with the active mode named; and segment audio is removed on both the success and the failure path

**Checkpoint**: Foundation ready. Audio is captured, split at pauses, transcribed and discarded; matching is correct; both modes share one capture record; the session can be turned on and off. User story work can begin.

---

## Phase 3: User Story 1 - Think aloud, then hand it to the agent (Priority: P1) MVP

**Goal**: Turn on listening, talk through a problem in fragments over a minute or two, say the submission phrase, and have all of it reach the agent as one prompt without touching the keyboard.

**Independent Test**: Turn on listening, speak three separate sentences with pauses between them, say the submission phrase, and confirm all three reach the agent as one prompt and the agent begins work.

### Implementation for User Story 1

- [ ] T023 [US1] Append each transcribed segment to the buffer in `lib/listen.js` as `{text, capturedAt}` where `capturedAt` is when the speech was captured rather than when transcription completed, per the Buffer entry entity in `specs/002-continuous-wake-phrase/data-model.md`, because using transcription time would let a slow request make old speech look recent
- [ ] T024 [US1] Implement age-bound eviction in `lib/listen.js` against `listenMaxBufferAgeMs`, enforced both on append and immediately before submission, evicting whole entries oldest-first and never truncating partway through one (FR-014)
- [ ] T025 [US1] Implement size-bound eviction in `lib/listen.js` against `listenMaxBufferChars`, also whole-entry and oldest-first, because an entry's tokens carry offsets into its own text and a partial slice would leave them pointing at text that is no longer there
- [ ] T026 [US1] Run wake detection after every segment append in `lib/listen.js`, which is what makes the at-most-one-undetected-phrase invariant hold, and implement no last-occurrence-wins rule, per plan.md Phase C
- [ ] T027 [US1] Implement submission assembly in `lib/listen.js` in the order fixed by research.md R-109: expire, locate the token run, slice the originals, and replace the buffer with the retained tail, all completing before the first `await`; then prefix the label, apply the empty check, and submit from the value already in hand. Replacing the buffer with the retained tail is what clears it and begins fresh accumulation (FR-006). Add no lock, mutex or append queue
- [ ] T028 [US1] Prefix every submitted prompt with `listenTranscriptLabel` in `lib/listen.js` (FR-009), which is the entire substitute for a correction pass, and make no language-model correction call on continuous speech (FR-010)
- [ ] T029 [US1] Guard the empty-buffer path in `lib/listen.js` so a wake phrase with nothing accumulated submits nothing and reports why, naming which bound evicted the speech when a bound is the reason (FR-016)
- [ ] T030 [US1] Implement `listenAutoSubmit: false` in `lib/listen.js` exactly as specified in `specs/002-continuous-wake-phrase/contracts/listen-options.md`: the prompt is filled and left unsubmitted, the buffer is still replaced by the retained tail, and only the final submit is skipped
- [ ] T031 [P] [US1] Extend `test/listen.test.js` with the buffer tests: both bounds evicting oldest-first and whole-entry; a retained entry never truncated mid-entry; a segment transcribed during assembly landing in the next buffer rather than being lost or duplicated; and the empty-buffer path issuing no submission

### Verification for User Story 1

- [ ] T032 [US1] Calibrate the wake phrases per step 3 of `specs/002-continuous-wake-phrase/quickstart.md`: speak each phrase ten times, read the recogniser's actual output from the log, and write the observed forms into `listenWakePhrases` variants. Confirm SC-012 at nine of ten, then set `listenAutoSubmit` to `true`
- [ ] T033 [US1] Walk acceptance scenarios 1 to 5 of User Story 1 using the User Story 1 checks in `specs/002-continuous-wake-phrase/quickstart.md`, including check 1.9 where speech continues through the submission and appears in the next prompt rather than being lost or duplicated
- [ ] T034 [US1] Confirm SC-011 end to end rather than only in `test/wake.test.js`: submit speech containing file paths, identifiers and sentence punctuation and confirm the agent receives it character for character apart from the removed phrase
- [ ] T035 [US1] Measure SC-001 by timing ten submissions from the end of the spoken phrase to the agent receiving the prompt, and confirm 3s at p50 and 6s at p95 against the roughly 1.5s component budget in plan.md
- [ ] T036 [US1] Confirm SC-009 using checks 4.1 to 4.4 in `specs/002-continuous-wake-phrase/quickstart.md`, overriding both bounds downward first because both default to roughly an hour

**Checkpoint**: User Story 1 fully functional and independently testable. This is the MVP.

---

## Phase 4: User Story 2 - Interrupt the agent and redirect it (Priority: P2)

**Goal**: While the agent is working, say the interrupt-and-submit phrase and have it stop before the new instruction is submitted.

**Independent Test**: Give the agent a long-running task, then while it is working speak a correction and say the interrupt-and-submit phrase. Confirm the agent stops and then acts on the new instruction.

### Implementation for User Story 2

- [ ] T037 [US2] Implement the interrupt action in `lib/listen.js` by calling `client.session.abort({sessionID})` with flat parameters before the submit step, per `specs/002-continuous-wake-phrase/contracts/commands.md`, and continue to the submission even if the abort itself fails
- [ ] T038 [US2] Skip the abort without raising an error when the agent is idle (FR-007), so the interrupt phrase behaves as a plain submission rather than reporting that there was nothing to interrupt
- [ ] T039 [US2] Confirm by source inspection that the plain submission phrase in `lib/listen.js` never aborts the agent regardless of whether it is working, because reinterpreting a phrase based on incidental agent state would make the two phrases indistinguishable in exactly the situation where the distinction matters

### Verification for User Story 2

- [ ] T040 [US2] Walk acceptance scenarios 1 to 3 of User Story 2 using the User Story 2 checks in `specs/002-continuous-wake-phrase/quickstart.md`, including the shared-prefix case where the interrupt phrase must not resolve as the plain phrase followed by stray words
- [ ] T041 [US2] Confirm SC-003 against the calibrated variant set from T032: zero interrupt-resolved-as-plain across every configured accepted form of both phrases. Any single occurrence is a blocking failure

**Checkpoint**: User Stories 1 and 2 both work independently. The agent can now be redirected mid-task.

---

## Phase 5: User Story 3 - Know whether it is listening, and stop it easily (Priority: P3)

**Goal**: Every transition is announced as it happens, the current state and buffer contents can be asked for at any time, and the buffer can be discarded without submitting it.

**Independent Test**: Toggle listening on and confirm the transition is announced, ask for the current state and see that it reports listening, inspect the accumulated buffer, discard it, and toggle listening off confirming that transition is announced too.

### Implementation for User Story 3

- [ ] T042 [US3] Announce every listening transition in `lib/listen.js` at the moment it occurs — starting, stopping, and each submission (FR-012) — using the host toast facility, holding no persistent indicator open
- [ ] T043 [US3] Register the status command in `index.js` as `listen.status` with `slash: { name: "listen-status" }`, reporting whether listening is active, how long it has been, the segment count, the buffer size in characters, the age of the oldest entry, the configured phrases, and the accumulated text itself. It MUST answer correctly while a transcription is in flight
- [ ] T044 [US3] Register the discard command in `index.js` as `listen.discard` with `slash: { name: "listen-discard" }`, clearing the buffer without submitting it while listening continues (FR-013). This is the recovery path for both hazards the spec accepts
- [ ] T045 [P] [US3] Extend `test/listen.test.js` to assert the status snapshot is correct mid-transcription, that discard leaves the session active, and that a fresh session reports inactive with an empty buffer
- [ ] T046 [US3] Confirm by source inspection that no separate inspect-buffer command exists, per `specs/002-continuous-wake-phrase/contracts/commands.md`: status reports the text, and two commands reporting the same state could disagree

### Verification for User Story 3

- [ ] T047 [US3] Walk acceptance scenarios 1 to 4 of User Story 3 using the User Story 3 checks in `specs/002-continuous-wake-phrase/quickstart.md`, including check 3.4 that the microphone is not active on a fresh editor start
- [ ] T048 [US3] Confirm SC-007: every transition produces a signal at the time it occurs and the status command answers correctly in every trial including mid-transcription

**Checkpoint**: All three user stories independently functional

---

## Phase 6: Polish and Cross-Cutting Concerns

**Purpose**: The success criteria that span stories, measured rather than asserted

- [ ] T049 Confirm `npm run check` clean and `npm run test` passing at repository root, with `test/wake.test.js`, `test/listen.test.js` and `test/capture.test.js` all included
- [ ] T050 [P] Confirm SC-006 using the lifecycle checks in `specs/002-continuous-wake-phrase/quickstart.md`: at no point during or after a session does audio remain on disk beyond the segment currently being transcribed, and killing the editor mid-session with `kill -9` leaves no recorder running and no audio behind
- [ ] T051 [P] Confirm SC-008 by injecting transcription request failures at one in five and verifying the session continues and successful submissions still occur
- [ ] T052 [P] Confirm SC-005 by driving the segment-handling path with captures on both sides of `listenMinSegmentMs` and counting the requests issued, which must be zero below the threshold
- [ ] T053 [P] Confirm SC-010 across repeated attempts: held-key dictation while listening is refused every time with the active mode named, and at no point do two capture processes run at once
- [ ] T054 [P] Confirm SC-004 across a continuous listening period of normal technical conversation that deliberately excludes the wake phrases, with zero unintended submissions
- [ ] T055 Update `README.md` to document the listening mode, the `listen*` options, the two wake phrases and their variants, and the two one-time calibrations, since the upstream README documents neither the mode nor the options
- [ ] T056 Walk `specs/002-continuous-wake-phrase/quickstart.md` end to end on a clean editor start and confirm every check passes

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. T003 gates the segmentation values every later observation depends on
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories
- **User Stories (Phases 3 to 5)**: All depend on Foundational completion, then proceed in priority order P1, P2, P3
- **Polish (Phase 6)**: Depends on all three stories being complete

### Ordering within Foundational

The three groups inside Phase 2 are not interchangeable:

1. **Capture ownership first** (T005 to T009). It is the only place 001's code is modified, and doing it before `lib/listen.js` exists means the session is written against the shared registry from its first line rather than being retrofitted onto it. Retrofitting is what plan.md's Prerequisite section describes as a refactor scheduled in advance
2. **Wake matching second** (T010 to T013). Pure functions with no dependency on the capture work, so this group can run alongside group 1 if staffed. It comes before the session because the session's submission path calls it, and because it is cheap to get exhaustively right in isolation
3. **Session last** (T014 to T022). Depends on group 1 for the registry and on T014 for the option defaults it reads

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational. No dependency on US2 or US3
- **User Story 2 (P2)**: Starts after Foundational, but T041's confirmation of SC-003 depends on T032 having calibrated the variant set, because an uncalibrated variant list makes the measurement meaningless
- **User Story 3 (P3)**: Starts after Foundational. Independent of both

### Parallel Opportunities

- Foundational groups 1 and 2 touch different files entirely (`lib/capture.js` and `lib/stt.js` versus `lib/wake.js`) and can proceed simultaneously
- T009, T013, T022, T031 and T045 are test files; T009 and T013 are fully independent of each other, while T022, T031 and T045 all extend `test/listen.test.js` and must be sequenced among themselves
- T050 through T054 are five independent measurements and can run in parallel
- Once Foundational completes, all three user story phases can proceed in parallel if staffed, subject to the T041 and T032 ordering above

### Sequential constraints worth calling out

- T005 must precede T006, because the record cannot be generalised before it has been moved
- T006 must precede T008, because the exit hook binds to the generalised drain
- T010 must precede T011 and T012, both of which call `tokenise`
- T014 must precede T015 and T016, which read the option defaults it establishes
- T023 must precede T024 and T025, because both bounds evict the entries it creates
- T026 must precede T027: detection running after every append is what makes the at-most-one-phrase invariant true, and T027 is written assuming it
- T032 must precede T041, and should precede T033, because auto-submit is left off until the phrases are calibrated

---

## Parallel Example: Foundational groups 1 and 2

```bash
# Different files, no shared state. Two workstreams:
Task: "Create lib/capture.js and move the registry out of lib/stt.js"     # T005 to T009
Task: "Create lib/wake.js with tokenise, compilePhrases and findWake"     # T010 to T013
```

## Parallel Example: Polish measurements

```bash
# Five independent measurements against a working feature:
Task: "Confirm SC-006, no audio on disk, including kill -9 mid-session"
Task: "Confirm SC-008, one-in-five injected failures do not end the session"
Task: "Confirm SC-005, captures below the minimum duration issue no request"
Task: "Confirm SC-010, exclusion refused every time, never two capture processes"
Task: "Confirm SC-004, phrase-free conversation produces no submission"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup, ending with measured pause thresholds rather than defaults
2. Complete Phase 2: Foundational in the stated group order
3. Complete Phase 3: User Story 1, calibrating the phrases at T032 before trusting auto-submit
4. **STOP and VALIDATE**: speak three sentences with pauses, say the submission phrase, and confirm all three arrive as one prompt with punctuation and identifiers intact
5. At this point the feature is useful on its own. Redirecting a busy agent still requires the keyboard

### Incremental Delivery

1. Setup plus Foundational, so audio is captured, split, transcribed and discarded, and matching is correct
2. Add User Story 1, validate, and the MVP is hands-free prompt composition
3. Add User Story 2, validate, and a misdirected agent can be stopped and redirected by voice
4. Add User Story 3, validate, and the always-on microphone becomes something the developer can see and control
5. Polish, which is where the success criteria are measured rather than asserted

### On the two calibrations

T003 and T032 are the only tasks whose output is configuration rather than code, and neither is a continuous-integration gate. Their inputs are a room, a microphone and a voice. T003 must happen first because nothing can be observed until segmentation works; T032 cannot happen until a segment can be transcribed, which is why it sits inside User Story 1 rather than in Setup.

---

## Notes

- [P] tasks are different files with no dependency on incomplete work
- T039 and T046 are verification rather than implementation: if either fails, the fix belongs to whichever earlier task owns that code
- Phase A0 (T005 to T008) is the only place this feature modifies feature 001's code. Everything else calls it
- The absence of a directory watcher in T015 is a requirement of that task, not an omission from it. See research.md R-101
- Commit after each task or logical group. Nothing in feature 002 is committed yet
- `npm run check` must be clean before any commit, per AGENTS.md
