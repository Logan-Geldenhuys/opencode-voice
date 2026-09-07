---
description: "Task list for 001-enterprise-gateway-stt"
---

# Tasks: Enterprise Gateway Speech-to-Text

**Input**: Design documents from `/specs/001-enterprise-gateway-stt/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included. The plan requests them explicitly: Phase A exit criteria name `test/auth.test.js`, and the Project Structure lists `test/auth.test.js` as new plus `test/stt.test.js` and `test/llm-client.test.js` as modified.

**Organization**: Tasks are grouped by user story where a story owns the work. See the note below on why this feature puts more in the foundational phase than a greenfield feature would.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Flat layout, retained per plan.md Structure Decision: `index.js` and `lib/` at repository root, tests in `test/`. There is no `src/`. The `files: ["index.js", "lib"]` publish contract in `package.json` depends on this.

## Note on phase distribution

This feature repairs an existing working plugin rather than building a new one. Three of the plan's five implementation phases are cross-cutting infrastructure that every user story runs through: credential resolution, service routing, and the capture rework. None of the three is owned by a single story, and the plan's Phase E builds nothing at all.

Foundational is therefore larger than the template's example, and the per-story phases are correspondingly smaller and weighted toward verification. This reflects the plan rather than diverging from it. Attempting to distribute the infrastructure across the stories would create false independence: US1 cannot be tested without a resolved credential and a reachable endpoint, which is exactly why plan.md orders Phase A and Phase D before the story-facing work.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the prerequisites hold and record the starting state, so later failures are attributable

- [x] T001 Verify the `sox` prerequisite per step 1 of `specs/001-enterprise-gateway-stt/quickstart.md`: `sox --version` reports 14.4.2, `sox --help` lists `pulseaudio` under AUDIO DEVICE DRIVERS, and both the `silence` and `vad` effects are present
- [x] T002 Record the baseline at repository root: `npm run check` clean and `npm run test` at 16 passing, so any later regression is distinguishable from a pre-existing failure
- [ ] T003 Register the fork by local absolute path in the host's `~/.config/opencode/tui.jsonc` plugin array as a `[moduleSpec, options]` tuple, per step 4 of `specs/001-enterprise-gateway-stt/quickstart.md`
- [ ] T004 Export `OPENCODE_VOICE_STT_BASEURL` per step 3 of `specs/001-enterprise-gateway-stt/quickstart.md` and confirm the editor substitutes `{env:OPENCODE_VOICE_STT_BASEURL}` into the plugin's options object before the plugin sees it, per research.md R-008

**Checkpoint**: Audio capture tooling present, baseline recorded, plugin loaded, gateway location reaching the plugin without appearing in tracked configuration

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Credential resolution, service routing, and capture lifecycle. All three are prerequisites for every user story.

**CRITICAL**: No user story work can begin until this phase is complete

### Credential resolution (plan Phase A, FR-004 to FR-007)

- [x] T005 Create `lib/auth.js` exporting `createCredentialResolver({storePath, storeKeyPath, envVar})` returning `{resolve, describe}`, per `specs/001-enterprise-gateway-stt/contracts/credential-store.md`
- [x] T006 Implement `resolve()` in `lib/auth.js`: read the store file and traverse `storeKeyPath`, fall back to `process.env[envVar]`, and return `{ok: true, value, source, attempts}` or `{ok: false, attempts}`. Read the file on every call with no cache, no `stat`, and no mtime comparison, per the No caching section of the contract
- [x] T007 Implement the ordered attempt log in `lib/auth.js` as `[{source, label, outcome, detail}]`, recording every source consulted rather than returning a discriminated failure reason
- [x] T008 Implement `describe()` in `lib/auth.js` so it reports the name of the last successful source and never the value, satisfying prohibitions 1 to 6 of the contract
- [x] T009 [P] Create `test/auth.test.js` covering: store-before-env resolution order; a token altered between two consecutive `resolve()` calls being reflected by the second (the testable form of prohibition 6); the attempt log content when every source fails; `describe()` never returning the credential; and that no code path passes the value to a logger
- [x] T010 Replace the direct `process.env[cfg.apiKeyEnv]` read in `lib/llm-client.js` with the injected resolver, and surface a resolution failure distinctly from a service rejection of a credential that did resolve
- [x] T011 Replace the direct `process.env` credential reads at both transcription call sites in `lib/stt.js` with the injected resolver
- [x] T012 Construct the resolver in `index.js` from the `credentialStorePath`, `credentialStoreKeyPath` and `apiKeyEnv` options and pass it to both `registerSTT` and `createClient`, with defaults `~/.local/share/opencode/auth.json` and `["anthropic", "key"]`
- [x] T013 [P] Extend `test/llm-client.test.js` to assert the resolver is consulted per request and that the credential appears in no logged output

### Service routing (plan Phase D, FR-008 and FR-009)

- [x] T014 Rename the upstream transcription options in `lib/stt.js` from `sttEndpoint` and `sttModel` to the contract names `sttApiEndpoint` and `sttApiModel` at the option-reading site near line 627, keeping the module-level variable names already in use
- [x] T015 Apply the mutual endpoint default in `index.js`: `endpoint` defaults to `sttApiEndpoint` and `sttApiEndpoint` defaults to `endpoint`, so a working configuration names the gateway once, per `specs/001-enterprise-gateway-stt/contracts/plugin-options.md`
- [x] T016 Add option validation in `index.js` per the Validation section of the plugin options contract, including the rule that an empty string arriving from an unset `{env:NAME}` is reported as an unset environment variable naming `NAME` rather than as a malformed URL
- [x] T017 Set the option defaults in `index.js` per the contract: `sttApiModel` to `gpt-transcribe`, `model` to `gpt-4.1`, `maxTokens` to 400, `temperature` to 0.2, `sttTimeoutMs` and `llmTimeoutMs` to 15000

### Capture as an owned object (plan Phase B, FR-014 to FR-018)

- [x] T018 Replace the module-level `tmpDir = "/tmp"` in `lib/stt.js` with a per-load directory created by `fs.mkdtemp(path.join(os.tmpdir(), "opencode-voice-"), {mode: 0o700})`, removing the fixed `/tmp/opencode-stt.wav` path
- [x] T019 Introduce a capture object in `lib/stt.js` that owns its child process handle and its own audio file path and exposes `stop()`, replacing the module-level `soxProc`, `soxStderr` and `recording` variables, per the Capture entity in `specs/001-enterprise-gateway-stt/data-model.md`
- [x] T020 Replace `forceKillSox()` in `lib/stt.js` near line 231 so it signals the tracked child handle with SIGTERM and escalates to SIGKILL only if it does not exit, removing the `pkill -9 -f 'sox.*opencode-stt'` pattern match that can terminate unrelated processes owned by the same user
- [x] T021 Delete the captured audio file in a `finally` block in `doTranscribePipeline()` in `lib/stt.js` so it is removed on both the success and the failure path
- [x] T022 Enforce at most one active capture in `lib/stt.js` and reject a second trigger deterministically with a message naming the in-flight capture, rather than allowing concurrent captures to interfere
- [x] T023 Register `api.lifecycle.onDispose` in `index.js` to stop any active capture and remove the capture directory when the editor exits, including abnormal exit
- [x] T024 Replace the two hardcoded `AbortSignal.timeout(60000)` calls in `lib/stt.js` with the configured `sttTimeoutMs`, and add a timeout to `lib/llm-client.js` bounded by `llmTimeoutMs`, surfacing a timeout as a distinct actionable error rather than a generic failure
- [x] T025 [P] Extend `test/stt.test.js` to cover the capture object's path allocation and the termination path, keeping the existing pure-helper tests passing

**Checkpoint**: Foundation ready. A credential resolves per request, one configured endpoint serves both services, and capture owns its process and its file. User story work can begin.

---

## Phase 3: User Story 1 - Dictate a prompt instead of typing it (Priority: P1) MVP

**Goal**: Hold a key, speak a technical request, release, and see correct editable text appear in the prompt box without it being sent.

**Independent Test**: Hold the record key, say a sentence containing a file path and a technical term, release, and confirm the correct text appears in the prompt box and is not submitted.

### Implementation for User Story 1

- [ ] T026 [US1] Add `temperature` support to the request body in `lib/llm-client.js`, which currently sends none, so the correction call can run at the 0.2 measured in research.md R-004
- [ ] T027 [US1] Add vocabulary biasing to `transcribeApi()` in `lib/stt.js` by populating the transcription request's `prompt` parameter, confirmed working on `gpt-transcribe` in research.md R-001
- [ ] T028 [US1] Guard the empty-capture path in `lib/stt.js` so a capture with no speech neither sends a request nor inserts empty text, and tells the user nothing was captured
- [ ] T029 [P] [US1] Verify by source inspection that `appendTranscription()` in `lib/stt.js` near line 540 appends to existing prompt text rather than replacing it (FR-003), and that the `stt.record` command does not submit while `stt.submit` remains a separate opt-in command (FR-002). Record the result; if either check fails the fix belongs to the phase owning that code

### Verification for User Story 1

- [ ] T030 [US1] Walk acceptance scenarios 1 to 4 of User Story 1 using the User Story 1 checks in `specs/001-enterprise-gateway-stt/quickstart.md` and record the outcome of each
- [ ] T031 [US1] Confirm SC-003 against the benchmark in research.md R-004: at least 90% of target terms in correct written form, and no term replaced with a plausible-but-wrong identifier

**Checkpoint**: User Story 1 fully functional and independently testable. This is the MVP.

---

## Phase 4: User Story 2 - Credentials work without manual maintenance (Priority: P2)

**Goal**: A credential renewed after the editor started is picked up without a restart, and a credential that cannot be resolved produces an actionable message.

**Independent Test**: Dictate successfully, re-authenticate so a new credential is issued, then dictate again in the same editor session without restarting anything.

### Implementation for User Story 2

- [ ] T032 [US2] Render the attempt log in the user-facing error in `lib/stt.js` and `lib/llm-client.js` as one line per source tried with the reason each failed, matching the worked example in `specs/001-enterprise-gateway-stt/contracts/commands.md`, and never including the value
- [ ] T033 [US2] Distinguish an expired credential rejected by the service from a credential that could not be resolved, in the error surfaced from both `lib/stt.js` and `lib/llm-client.js`, because the corrective actions differ

### Verification for User Story 2

- [ ] T034 [P] [US2] Confirm SC-004 by searching the repository for any path that could emit credential material: `rg -n 'apiKey|token|Authorization|Bearer' index.js lib` reviewed against FR-007, plus a check that no temporary file written by the plugin contains the value
- [ ] T035 [US2] Walk acceptance scenarios 1 to 3 of User Story 2 using the User Story 2 checks in `specs/001-enterprise-gateway-stt/quickstart.md`, including renewing the credential mid-session without restarting the editor

**Checkpoint**: User Stories 1 and 2 both work independently. Dictation now survives credential renewal.

---

## Phase 5: User Story 3 - Diagnose and configure audio on a virtualised Linux desktop (Priority: P3)

**Goal**: Audio failures name their cause and remedy, the microphone is selectable and persists, and no transcription tier is hidden from the selector.

**Independent Test**: Stop the host audio bridge, attempt to dictate, and confirm the message identifies the bridge as the cause and states the remedy.

### Implementation for User Story 3

- [ ] T036 [US3] Remove the hardcoded `/whisper/i` catalogue filter from `getApiModels()` in `lib/stt.js` near line 450, which currently conceals every tier including the fastest and leaves only the one tier measured to mangle file paths
- [ ] T037 [US3] Group the tier selector options in `lib/stt.js` into a Measured group listing the four tiers observed to work fastest-first and a Remainder group holding everything else in service order, using the `category` field on the host dialog's options so the host's own type-to-filter does the narrowing, per research.md R-006
- [ ] T038 [P] [US3] Verify by source inspection that microphone selection through `listInputDevices()` in `lib/stt.js` persists across editor restarts via `api.kv` (FR-012), and that the existing WSL audio diagnostics name the cause and the corrective action for each failure mode (FR-013)

### Verification for User Story 3

- [ ] T039 [US3] Walk acceptance scenarios 1 to 3 of User Story 3 using the User Story 3 checks in `specs/001-enterprise-gateway-stt/quickstart.md`, including stopping the audio bridge and confirming the message identifies it
- [ ] T040 [US3] Confirm SC-007: no tier excluded by a client-side name pattern, `gpt-transcribe` reachable without scrolling, and typing in the selector narrows the full catalogue

**Checkpoint**: All three user stories independently functional

---

## Phase 6: Polish and Cross-Cutting Concerns

**Purpose**: Verification that spans stories, and the measurements the success criteria require

- [ ] T041 Confirm `npm run check` clean and `npm run test` passing at repository root, with the new `test/auth.test.js` included
- [ ] T042 [P] Confirm SC-006 and the lifecycle guarantees using the lifecycle checks in `specs/001-enterprise-gateway-stt/quickstart.md`: no audio remains after a session, the capture file and its directory are both owner-only while they exist, and killing the editor mid-capture leaves no `sox` process
- [ ] T043 [P] Measure SC-001 by timing ten six-second utterances from key release to text appearing, and confirm 3s at p50 and 5s at p95 against the 2.4s p50 component budget in plan.md
- [ ] T044 [P] Confirm SC-008 by inducing a stalled request and verifying a timeout is surfaced as a distinct error rather than an indefinite wait
- [ ] T045 Update `README.md` to document the renamed `sttApiEndpoint` and `sttApiModel` options, the `{env:NAME}` configuration form, and the credential store options, since the upstream README documents the old names
- [ ] T046 Walk `specs/001-enterprise-gateway-stt/quickstart.md` end to end on a clean editor start and confirm every check passes

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. T001 gates everything, because without `sox` no audio path can be exercised at all
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories
- **User Stories (Phases 3 to 5)**: All depend on Foundational completion, then proceed in priority order P1, P2, P3
- **Polish (Phase 6)**: Depends on all three stories being complete

### Ordering within Foundational

The three groups inside Phase 2 are not interchangeable, and the order follows plan.md:

1. **Credential resolution first** (T005 to T013). Nothing reaches the gateway without it, so no later exit criterion is checkable until it lands
2. **Service routing second** (T014 to T017). Also required before a request can succeed, and it is where the option defaults are established that the capture work then consumes
3. **Capture last** (T018 to T025). Its exit criteria require a completed transcription round trip, which needs the first two groups present. T018 must precede T019, and T019 must precede T020 through T024 because those operate on the object it introduces

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational. No dependency on US2 or US3
- **User Story 2 (P2)**: Starts after Foundational. Independently testable, though it exercises the dictation path US1 verifies
- **User Story 3 (P3)**: Starts after Foundational. Independent of both

### Parallel Opportunities

- T009 and T013 are different test files and can run alongside the implementation tasks they cover once the modules they import exist
- T025 is a different test file again and is independent of T009 and T013
- T029, T034 and T038 are all source-inspection tasks in different areas and can run in parallel with each other and with implementation work in their own story
- T042, T043 and T044 are independent measurements and can run in parallel
- Once Foundational completes, all three user story phases can proceed in parallel if staffed

### Sequential constraints worth calling out

- T014 renames options that T015, T016 and T017 then read. It must land first
- T018 creates the directory that T019's capture object allocates files in
- T024 depends on T017 having established the timeout defaults
- T036 and T037 both edit the selector path in `lib/stt.js` and must not run in parallel

---

## Parallel Example: Foundational test tasks

```bash
# Once lib/auth.js exists (T005 to T008), these three test files are independent:
Task: "Create test/auth.test.js covering resolution order and per-call re-read"
Task: "Extend test/llm-client.test.js to assert the resolver is consulted per request"
Task: "Extend test/stt.test.js to cover capture path allocation and termination"
```

## Parallel Example: Story verification

```bash
# The three source-inspection tasks touch different areas and different requirements:
Task: "Verify appendTranscription appends rather than replaces (FR-003, FR-002)"
Task: "Search for any path that could emit credential material (FR-007)"
Task: "Verify microphone persistence and audio diagnostics (FR-012, FR-013)"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup, starting with the `sox` gate
2. Complete Phase 2: Foundational in the stated group order
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: dictate a technical sentence and confirm it appears correctly and unsent
5. At this point the feature is useful on its own, with a freshly issued credential

### Incremental Delivery

1. Setup plus Foundational, so a credential resolves and one endpoint serves both services
2. Add User Story 1, validate, and the MVP is dictation
3. Add User Story 2, validate, and dictation survives credential renewal
4. Add User Story 3, validate, and audio failures become diagnosable
5. Polish, which is where the success criteria are measured rather than asserted

### On feature 002

Feature 002 must not begin before Phase 2's capture group is complete, specifically T019 and T020. Its plan records that it has nothing to extract precisely because T019 produces the object it needs. Beginning 002 earlier would mean building against module-level mutable state and then refactoring.

---

## Notes

- [P] tasks are different files with no dependency on incomplete work
- Phase 5's T036 and T037 are the only place this feature removes user-visible behaviour, and it removes a defect
- T029, T034 and T038 are verification rather than implementation, per plan.md Phase E: if one fails, the fix belongs to whichever earlier phase owns that code, not to the story phase that found it
- Commit after each task or logical group. Nothing in this feature is committed yet
- `npm run check` must be clean before any commit, per AGENTS.md
