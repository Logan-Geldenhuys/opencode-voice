# Contract: Commands and user-facing behaviour

**Feature**: 002-continuous-wake-phrase

Extends feature 001's command contract. Command names are logical; the registration mechanism is an implementation choice.

## Listening control

### Toggle listening

Satisfies FR-011, FR-012.

| Aspect          | Behaviour                                                              |
| --------------- | ---------------------------------------------------------------------- |
| Initial state   | **Off.** Never active at editor start                                  |
| On activation   | Recorder starts, buffer created, transition announced                  |
| On deactivation | Recorder terminated, temp audio removed, buffer discarded, announced   |
| Refused         | If held-key dictation is capturing, naming it and how to stop (FR-017) |
| Visibility      | Announced transitions plus an on-demand status command (FR-012)        |

Starting to listen is always an explicit act. Nothing — not a previous session's preference, not a persisted setting — may cause the microphone to be live without the developer having asked in this session. A persisted "was listening" flag is specifically excluded: reopening an editor and finding the microphone already live is the exact hazard User Story 3 exists to prevent.

### Show status

Satisfies FR-012 together with the announced transitions, and is the mechanism behind SC-007.

Reports: whether listening is active, how long for, segment count, buffer character count, age of the oldest retained entry, the configured wake phrases, **and the accumulated text itself**.

This is the design rather than a fallback. An earlier draft treated it as what to do if a persistent indicator proved unreachable; the persistent indicator has been dropped outright, because the host's notification call returns nothing that can be updated or dismissed and the alternative rendering surface is unproven from an external plugin and needs a build step to use ergonomically. Announcement plus a command is what remains, and it is sufficient for what User Story 3 actually asks: the developer must not lose track of a live microphone.

It MUST answer correctly while a transcription is in flight. That is the moment the developer is most likely to ask, and a status read that blocks on or races with an in-flight request is a status read that cannot be trusted.

Including the text satisfies FR-013's inspection half as well. An earlier draft had a separate _inspect buffer_ command, but status already reported the segment count, the character count and the age of the oldest entry — every fact about the buffer except the one the developer wants — and the difference between the two commands was one field. Two commands would also mean two answers to "what is going on", which can disagree. FR-012 already specifies them as one.

### Discard buffer

Satisfies FR-013.

Clears the buffer without submitting. Listening continues. This is the recovery path for the two accepted hazards — talking _about_ a wake phrase, and ambient conversation entering the buffer.

## Wake-phrase actions

Not commands. Triggered by speech, matched against the buffer.

### Submission phrase

Satisfies FR-006, FR-008, FR-009, FR-016.

| Step | Behaviour                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 1    | Expired entries dropped (FR-014)                                                                               |
| 2    | Phrase located as a contiguous run of normalised tokens across the remaining entries                           |
| 3    | Entry texts joined verbatim, phrase included; the run's spans only say whether anything else was said (FR-008) |
| 4    | Buffer emptied                                                                                                 |
| 5    | Transcript label prefixed, naming the agent so the retained phrase reads as an address (FR-009)                |
| 6    | Empty result → nothing submitted, developer told why (FR-016)                                                  |
| 7    | Prompt submitted to the agent                                                                                  |

Steps 2 and 3 are separate on purpose. The phrase is located through normalised tokens and the prompt is cut from the original text, so the agent receives the capitalisation and punctuation the developer spoke. Submitting a normalised form would turn `Server.tsx` into `servertsx`. SC-011 measures the difference character for character.

Steps 1 to 4 all mutate, and they all complete before step 7 does anything asynchronous. That ordering is the whole of the concurrency story: a segment finishing transcription during the submit lands in a buffer that has already been emptied, so it is neither lost nor duplicated. An earlier draft placed the buffer replacement last and required steps 1 to 3 to hold a lock against appends. Moving the replacement ahead of the first `await` removes the window instead of guarding it (research.md R-109).

**Never aborts the agent**, regardless of whether it is working (research.md R-105). The developer chose the phrase without the interrupt word; reinterpreting it based on the agent's incidental state would make the two phrases indistinguishable in exactly the situation where the distinction matters.

### Interrupt-and-submit phrase

Satisfies FR-007.

Identical, except the agent's current work is aborted before step 7. When the agent is idle, the abort is skipped and no error is raised — asking to stop something already stopped is not a failure.

## Mutual exclusion

Satisfies FR-017.

| Event                                        | Behaviour                                             |
| -------------------------------------------- | ----------------------------------------------------- |
| Held-key dictation attempted while listening | **Refused.** Names the active mode and how to stop it |
| Listening attempted while dictation captures | **Refused.** Same                                     |
| Concurrent capture processes                 | Never. One at most, across both paths                 |

Both refusals read the same shared capture registry (`lib/capture.js`, plan.md Phase A0), not a per-mode flag. Two flags can disagree with each other and with the operating system; one record cannot. This is also what makes the third row enforceable rather than merely intended.

The two modes are alternatives, not layers. An earlier draft coordinated them: dictation would suspend the session, the overlap would be discarded, the session would resume. That is a state machine over a long-lived child process with a discard window, and it exists to preserve a combination that has no use — during a listening session the wake phrase already performs what the held key is for.

Refusal loses nothing the developer asked for. Both modes exist; only one is armed at a time. There is no suspended state to get stuck in, no overlap to discard, and nothing to test across alternating exchanges. SC-010 asserts the refusal names the active mode, and that two capture processes never coexist.

The refusal message must name the active mode and the command to stop it. A bare "unavailable" would leave the developer guessing which mode is holding the microphone, which is the one thing they cannot see.

## Error message contract

Every failure names a cause and a corrective action. Segment-level failures must not interrupt the developer — they are logged, not surfaced, because a transient network error costing one segment is not worth breaking concentration for (FR-019).

| Condition                            | Surfaced?   | Must convey                                      |
| ------------------------------------ | ----------- | ------------------------------------------------ |
| Recorder fails to start              | Yes         | Which binary or device, and the remedy           |
| Audio bridge unreachable             | Yes         | Audio subsystem is the cause, plus the remedy    |
| Single segment transcription fails   | No — logged | Session continues (FR-019)                       |
| Repeated segment failures            | Yes         | Transcription is failing persistently            |
| Wake phrase fires on an empty buffer | Yes         | Nothing to send (FR-016)                         |
| Buffer emptied by a bound            | Yes         | Which bound evicted the speech (FR-014)          |
| Agent abort fails                    | Yes         | Abort failed. Submission still proceeds          |
| Credential unresolvable              | Yes         | Inherited from feature 001. Never the value      |
| Second capture mode attempted        | Yes         | Which mode is active, and the command to stop it |

The repeated-failure case is a deliberate escalation. Silently dropping every segment satisfies FR-019 literally while leaving the developer talking to a microphone that is recording nothing.

## Lifecycle guarantees

| Event                          | Guarantee                                                           |
| ------------------------------ | ------------------------------------------------------------------- |
| Segment transcribed            | Audio deleted (FR-018)                                              |
| Segment fails                  | Audio deleted (FR-018)                                              |
| Listening stops                | Recorder terminated, audio removed, buffer discarded                |
| Editor exits normally          | Same, via the host disposal hook (FR-020)                           |
| Editor exits abnormally        | Same                                                                |
| In-flight requests at teardown | Aborted, not awaited (FR-020)                                       |
| Termination                    | Tracked process handles only, never a command-line pattern match    |
| Teardown reach                 | Every recorder in the shared registry, not only the one a mode owns |
| Audio path                     | One file per segment, in feature 001's owner-only capture directory |

The termination rule is inherited from feature 001's FR-016 and matters more here: the held-key path runs the same recorder binary, so a pattern kill from either path would destroy the other's process. FR-017 makes the modes exclusive, but the exclusion is enforced by this plugin rather than by the operating system — a recorder left behind by a crashed session is exactly the case a pattern match gets wrong.

The teardown-reach row is why Phase A0 exists. As feature 001 stands, the exit hook drains one module variable inside `lib/stt.js`; a recorder started by a listening session would never be in it, so the abnormal-exit rows above would be claims rather than guarantees.

The per-segment audio path matters within a single session, independently of the other mode. The next recorder starts while the previous segment is still being uploaded, so a shared fixed path would let it truncate a file mid-request.

## Tuning procedure

Satisfies FR-021. Not a command and not a program — the recorder does this already:

```sh
sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart
soxi -D seg*.wav
```

Speak, stop the recording, and the file count and durations answer the question. Vary the second threshold pair to change pause sensitivity, then put the values that work into `listenSilenceDurationMs` and `listenSilenceThreshold`.

The plugin does not use `: newfile : restart` — it starts one recorder per utterance instead. The one-liner keeps that clause anyway because it lets one recording session produce several segments, which is what makes the durations easy to read off. The silence clause is the part that determines where the cuts fall and it is identical in both forms; measurement confirmed the two produce the same boundaries to the sample (research.md R-101). So the durations printed here are the durations the plugin will see.

It belongs in the quickstart rather than in the package. An earlier draft specified a standalone Node script for this. It would have been a new file in a new directory, excluded from publication, reimplementing the recorder argument construction that already exists in the plugin — and therefore capable of being tuned correctly while the plugin stayed wrong. The shell form drives the same binary with the same silence clause the plugin uses, which is the property that makes the tuning transferable.

## Calibration procedure

Satisfies SC-012. Also not a command and not a program: turn listening on, speak each wake phrase ten times, and read the transcripts out of the plugin log. Recognition variants that recur go into the phrase's `variants` list. Full steps are in quickstart.md.

The output of this procedure is configuration, which is why it is a procedure and not a test. An automated benchmark would need committed audio fixtures encoding one voice in one room, and would answer a question about the fixtures rather than about the developer.

## Non-goals

No spoken output. No speaker identification. No distinguishing mention of a wake phrase from use of it — the spec accepts that talking about a phrase fires it, with discard as the recovery path.
