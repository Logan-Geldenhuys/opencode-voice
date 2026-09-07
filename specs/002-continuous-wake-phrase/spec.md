# Feature Specification: Continuous Listening with Wake-Phrase Submission

**Feature Branch**: `002-continuous-wake-phrase`

**Created**: 2026-09-06

**Status**: Draft

**Input**: User description: "Continuous transcription where a spoken keyword dumps the accumulated transcript into the opencode agent. A second keyword interrupts the agent first, then submits. No spoken output."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Think aloud, then hand it to the agent (Priority: P1)

A developer turns on listening and works. They talk through a problem out loud, sometimes in fragments, sometimes over a minute or two. When they have said enough, they say the submission phrase. Everything they said since the last submission is handed to the agent as a prompt and the agent starts working. They never touched the keyboard.

**Why this priority**: This is the feature. It is what separates continuous listening from dictation — the developer does not have to decide up front that they are composing a prompt, hold a key, and speak in one clean take. They think out loud and then commit.

**Independent Test**: Turn on listening, speak three separate sentences with pauses between them, say the submission phrase, and confirm all three sentences reach the agent as one prompt and the agent begins work.

**Acceptance Scenarios**:

1. **Given** listening is on and the developer has spoken several sentences separated by pauses, **When** they say the submission phrase, **Then** all speech since the previous submission is sent to the agent as a single prompt.
2. **Given** a prompt has just been submitted, **When** the developer speaks again and submits again, **Then** the second prompt contains only the speech that followed the first submission, with no repetition.
3. **Given** the developer says the submission phrase at the end of a sentence, **When** the prompt is assembled, **Then** the phrase itself does not appear in the text sent to the agent.
4. **Given** the developer has said nothing since the last submission, **When** they say the submission phrase, **Then** nothing is sent to the agent and they are told the buffer was empty.
5. **Given** speech is submitted to the agent, **When** the agent receives it, **Then** the prompt is marked as voice-transcribed and possibly containing recognition errors, so the agent treats unfamiliar identifiers with appropriate suspicion.

---

### User Story 2 - Interrupt the agent and redirect it (Priority: P2)

The agent is midway through work the developer no longer wants — it has misunderstood, or they have thought of something better. They say the interrupt-and-submit phrase. The agent stops what it is doing, and the developer's accumulated speech is submitted as the new instruction.

**Why this priority**: Watching an agent go the wrong way and having to reach for the keyboard defeats the purpose of hands-free operation. It is P2 because P1 is useful without it — you can simply wait for the agent to finish.

**Independent Test**: Give the agent a long-running task, then while it is working speak a correction and say the interrupt-and-submit phrase. Confirm the agent stops and then acts on the new instruction.

**Acceptance Scenarios**:

1. **Given** the agent is actively working, **When** the developer says the interrupt-and-submit phrase, **Then** the agent's current work is stopped before the new prompt is submitted.
2. **Given** the agent is idle, **When** the developer says the interrupt-and-submit phrase, **Then** the phrase behaves as a plain submission and no error is raised for there being nothing to interrupt.
3. **Given** both phrases share a common prefix, **When** the developer says the interrupt-and-submit phrase, **Then** it is recognised as the interrupt variant and not as the plain submission variant followed by stray words.

---

### User Story 3 - Know whether it is listening, and stop it easily (Priority: P3)

The developer is told whenever the microphone goes live or stops, and can ask at any time whether it is listening and what it has heard. Turning listening on and off is a single deliberate action. They can inspect what has accumulated before committing to sending it, and discard it if it is nonsense.

**Why this priority**: An always-on microphone the developer has lost track of is the feature's main hazard — both for privacy and for accidental submissions. It is P3 only because it is worthless without P1 existing first.

**Independent Test**: Toggle listening on and confirm the transition is announced, ask for the current state and see that it reports listening, inspect the accumulated buffer, discard it, and toggle listening off confirming that transition is announced too.

**Acceptance Scenarios**:

1. **Given** listening is off, **When** the developer activates it, **Then** the change is signalled and the active state remains discoverable afterwards.
2. **Given** listening is on and speech has accumulated, **When** the developer inspects the buffer, **Then** they see the accumulated text and can discard it without submitting it.
3. **Given** listening is on, **When** the editor exits by any means, **Then** capture stops and no recording is left behind.
4. **Given** listening has never been turned on in this session, **When** the developer starts the editor, **Then** the microphone is not active.

---

### Edge Cases

- **The developer talks about the wake phrase**: saying "you trigger it by saying the submission phrase" will fire it. This is accepted rather than solved; recovery is that the developer can stop listening and clear the buffer. Attempting to distinguish mention from use is out of scope.
- **Wake phrase split across a pause**: the developer pauses between the first and second word of the phrase. Detection must still succeed, because the phrase is only meaningful as a whole and pause placement is not under the speaker's conscious control.
- **Wake phrase mis-transcribed**: the phrase will be returned with predictable variations in spacing, capitalisation and punctuation, and sometimes with a word split or merged. Formatting variation must be tolerated automatically; the rest is handled by configuring accepted forms of the phrase. Exact string matching would make the feature unreliable.
- **Ambient conversation**: a colleague speaks, a call plays through speakers, or the developer talks to someone else. That speech enters the buffer. Bounded by a maximum buffer age and by the buffer being inspectable and discardable.
- **Listening left on and forgotten**: the developer walks away. Every subsequent utterance is transcribed remotely, costing money and sending unrelated speech off the machine. Bounded by the buffer age limit and by the state being visible.
- **Held-key dictation attempted while listening**: continuous capture would also hear the speech intended for the held key, producing a duplicate, and two recorders would contend for the microphone. Refused rather than coordinated: the modes are mutually exclusive and the refusal says which one is running.
- **Very short sounds**: a door, a cough, a keyboard. These must not each become a transcription request.
- **A single segment fails to transcribe**: one network error must not end the listening session; it must lose at most that segment.
- **Agent is busy when a plain submission fires**: the developer submits without the interrupt variant while the agent is working. Behaviour must be defined and consistent rather than dependent on timing.
- **Speech arrives while a submission is being assembled**: words spoken in the moment between the phrase being detected and the prompt being sent must not be silently lost or duplicated into the next buffer.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST capture audio continuously while listening is active and MUST divide it into segments at natural pauses in speech, rather than at fixed time intervals, so that words are not cut in half.
- **FR-002**: The system MUST transcribe each segment and accumulate the results into a buffer representing everything said since the last submission.
- **FR-003**: The system MUST detect a configurable submission phrase and a configurable interrupt-and-submit phrase within the accumulated text, tolerating the spacing, punctuation and capitalisation variations that speech recognition produces. Variations that are not merely formatting MUST be accommodated by configuring additional accepted forms of the phrase, per FR-022, rather than by a second substitution mechanism: the distortions that matter in practice span word boundaries, and a mechanism that rewrites individual words cannot express them.
- **FR-004**: The system MUST detect wake phrases against the accumulated buffer rather than against individual segments, so a phrase spoken across a pause is still recognised.
- **FR-005**: When the phrases share a prefix, the system MUST resolve detection in favour of the longer phrase, so that the interrupt variant is never mistaken for the plain variant.
- **FR-006**: On detecting the submission phrase, the system MUST submit the buffered text to the agent, clear the buffer, and begin accumulating afresh.
- **FR-007**: On detecting the interrupt-and-submit phrase, the system MUST stop the agent's current work before submitting, and MUST submit normally when the agent was not working.
- **FR-008**: The system MUST treat a wake phrase as a terminator: text before it is submitted, the phrase itself is excluded, and anything transcribed after it does not become part of that submission.
- **FR-009**: The system MUST label submitted text as a voice transcript that may contain recognition errors, particularly in code identifiers and file paths, so the agent can weigh unfamiliar terms accordingly.
- **FR-010**: The system MUST NOT apply language-model correction to continuously captured speech before submitting it. Correction adds latency to every submission and can introduce confident, wrong substitutions; labelling the text as a transcript delegates that judgement to the agent, which has the surrounding project context that a correction pass does not.
- **FR-011**: The system MUST require an explicit action to begin listening and MUST NOT listen by default when the editor starts.
- **FR-012**: The system MUST signal every change of listening state at the moment it occurs — starting, stopping, and each submission — and MUST provide a command that reports on demand whether listening is active and what the buffer currently holds. The editor offers no facility for a persistent indicator that an external component can rely on, so state is conveyed by announcing transitions and by answering when asked.
- **FR-013**: The system MUST allow the developer to inspect the accumulated buffer and to discard it without submitting it.
- **FR-014**: The system MUST discard buffered speech older than a configurable maximum age, so that speech from much earlier cannot be submitted to the agent by a later wake phrase.
- **FR-015**: The system MUST discard captured segments shorter than a configurable minimum duration without transcribing them, so incidental noise does not generate requests.
- **FR-016**: The system MUST NOT submit when the buffer contains no usable text, and MUST tell the developer why nothing was sent.
- **FR-017**: The system MUST NOT permit continuous listening and held-key dictation to be active at the same time. Attempting either while the other is active MUST be refused with a message naming the active mode and how to stop it. The two modes are alternatives rather than layers: while listening, the wake phrase already performs what the held key exists to do, so nothing is lost by making them exclusive, and coordinating two live capture processes over the same microphone is avoided entirely.
- **FR-018**: The system MUST delete each captured segment as soon as it has been transcribed or has failed, and MUST NOT retain audio for the duration of a listening session.
- **FR-019**: The system MUST survive the failure of an individual segment — a network error, a rejected request, a timeout — by losing only that segment and continuing to listen.
- **FR-020**: The system MUST stop capture and remove temporary audio when the editor exits, including abnormal exit, and MUST abandon any transcription requests still in flight.
- **FR-021**: The system MUST document a procedure for observing segmentation behaviour outside the editor, so that pause-detection sensitivity can be tuned to the developer's microphone and room. Sensitivity thresholds are environment-specific and cannot be established by design. The procedure MUST use the capture tooling the feature already depends on rather than requiring anything additional to be built or installed.
- **FR-022**: The system MUST allow the wake phrases and their accepted variants to be configured, so a developer whose phrase is unreliable in their accent or environment can change it.
- **FR-023**: The system MUST submit the developer's speech with its original capitalisation and punctuation intact. Any normalised form used to locate a wake phrase MUST be used only for locating it, and MUST NOT be what reaches the agent. Normalisation necessarily discards case and punctuation, which is exactly what distinguishes a file path or an identifier from an ordinary word; submitting normalised text would corrupt the same terms FR-009 asks the agent to treat with care.

### Key Entities

- **Segment**: one continuous stretch of speech bounded by pauses. Has audio that exists only until transcribed, a duration used to decide whether it is worth transcribing, and resulting text.
- **Buffer**: the ordered accumulation of segment text since the last submission. Bounded by a maximum age. Inspectable and discardable. Cleared on submission.
- **Wake phrase**: a configured spoken trigger with a set of accepted recognition variants and an associated action — submit, or interrupt then submit.
- **Listening session**: the period between the developer turning listening on and off. Owns the capture process and is responsible for tearing it down.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: From the moment the developer finishes saying the submission phrase, the accumulated prompt reaches the agent within 3 seconds for at least half of submissions and within 6 seconds for at least 95%.
- **SC-002**: Across a fixed set of recorded utterances of each wake phrase — spoken at varying speed, with and without a pause inside the phrase, and with the recognition variants observed in practice — the correct action is triggered at least 95% of the time.
- **SC-003**: The interrupt variant is never resolved as the plain variant: zero misclassifications across the benchmark set.
- **SC-004**: Across a continuous listening period containing normal technical conversation that deliberately excludes the wake phrases, zero unintended submissions occur.
- **SC-005**: During an hour of listening that includes silence, incidental noise and speech, the number of transcription requests does not exceed the number of distinct spoken utterances, confirming that silence and noise generate no requests.
- **SC-006**: At any point during and after a listening session, zero captured audio files remain on disk beyond the segment currently being transcribed.
- **SC-007**: Every transition of listening state produces a signal in the editor at the time it occurs, and the state-reporting command answers correctly in 100% of trials, including while a segment is being transcribed.
- **SC-008**: Injected failure of individual transcription requests at a rate of one in five does not end the listening session, and successful submissions still occur.
- **SC-009**: Speech captured more than the configured maximum buffer age before a wake phrase never appears in a submitted prompt.
- **SC-010**: Attempting held-key dictation while listening is active is refused, and the refusal names the active mode, in 100% of attempts. At no point do two capture processes run at once.
- **SC-011**: Across a set of submissions containing file paths, identifiers and sentence punctuation, the text the agent receives matches what was spoken, character for character, apart from the removed wake phrase. Zero occurrences of lowercased identifiers or stripped punctuation.

## Assumptions

- This feature builds on the transcription, credential and audio foundations established by the enterprise gateway speech-to-text feature, and is not independently deliverable without them.
- Streaming transcription is not available. Transcription happens on complete segments after a pause is detected, which sets a floor on how quickly a wake phrase can be recognised. A phrase cannot be acted on before the speaker has stopped talking.
- Sending all captured speech to the corporate AI gateway while listening is active is acceptable. The developer has accepted the cost and privacy consequences in exchange for a simpler design, on the basis that listening is explicitly opt-in and easily stopped.
- Automatic submission without review is intended for this feature, in contrast to held-key dictation where review is required. The wake phrase is treated as the developer's deliberate act of confirmation.
- The developer is willing to tune pause-detection sensitivity once for their microphone and room. No attempt is made to determine these values automatically.
- Speaking the wake phrase in conversation about the feature will trigger it. This is accepted; the recovery path is stopping listening and discarding the buffer.
- Spoken output from the agent is out of scope. This feature only carries speech inwards.
- One developer, one microphone, one machine. Speaker identification and separating the developer's voice from other voices in the room are out of scope.
