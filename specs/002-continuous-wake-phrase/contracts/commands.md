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

Reports: whether listening is active, how long for, segment count, buffer character count, age of the oldest retained entry, and the configured wake phrases.

This is the design rather than a fallback. An earlier draft treated it as what to do if a persistent indicator proved unreachable; the persistent indicator has been dropped outright, because the host's notification call returns nothing that can be updated or dismissed and the alternative rendering surface is unproven from an external plugin and needs a build step to use ergonomically. Announcement plus a command is what remains, and it is sufficient for what User Story 3 actually asks: the developer must not lose track of a live microphone.

It MUST answer correctly while a transcription is in flight. That is the moment the developer is most likely to ask, and a status read that blocks on or races with an in-flight request is a status read that cannot be trusted.

### Inspect buffer

Satisfies FR-013.

Shows accumulated text without submitting it. Read-only.

### Discard buffer

Satisfies FR-013.

Clears the buffer without submitting. Listening continues. This is the recovery path for the two accepted hazards — talking _about_ a wake phrase, and ambient conversation entering the buffer.

## Wake-phrase actions

Not commands. Triggered by speech, matched against the buffer.

### Submission phrase

Satisfies FR-006, FR-008, FR-009, FR-016.

| Step | Behaviour                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Expired entries dropped (FR-014)                                                                                                             |
| 2    | Phrase located on a normalised join of the remaining entries                                                                                 |
| 3    | Match position mapped back into the original text and sliced there: text before is the prompt, phrase excluded, text after retained (FR-023) |
| 4    | Transcript label prefixed (FR-009)                                                                                                           |
| 5    | Empty result → nothing submitted, developer told why (FR-016)                                                                                |
| 6    | Prompt submitted to the agent                                                                                                                |
| 7    | Buffer replaced by the retained tail                                                                                                         |

Steps 2 and 3 are separate on purpose. The phrase is found in normalised text and the prompt is cut from the original, so the agent receives the capitalisation and punctuation the developer spoke. Submitting the normalised form would be shorter and would turn `Server.tsx` into `servertsx`. SC-011 measures the difference character for character.

**Never aborts the agent**, regardless of whether it is working (research.md R-105). The developer chose the phrase without the interrupt word; reinterpreting it based on the agent's incidental state would make the two phrases indistinguishable in exactly the situation where the distinction matters.

### Interrupt-and-submit phrase

Satisfies FR-007.

Identical, except the agent's current work is aborted before step 6. When the agent is idle, the abort is skipped and no error is raised — asking to stop something already stopped is not a failure.

## Mutual exclusion

Satisfies FR-017.

| Event                                        | Behaviour                                             |
| -------------------------------------------- | ----------------------------------------------------- |
| Held-key dictation attempted while listening | **Refused.** Names the active mode and how to stop it |
| Listening attempted while dictation captures | **Refused.** Same                                     |
| Concurrent capture processes                 | Never. One at most, across both paths                 |

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
| Buffer expired before submission     | Yes         | Speech was too old, naming the bound (FR-014)    |
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
| Termination                    | Tracked process handle only, never a command-line pattern match     |
| Audio path                     | One file per segment, in feature 001's owner-only capture directory |

The termination rule is inherited from feature 001's FR-016 and matters more here: the held-key path runs the same recorder binary, so a pattern kill from either path would destroy the other's process. FR-017 makes the modes exclusive, but the exclusion is enforced by this plugin rather than by the operating system — a recorder left behind by a crashed session is exactly the case a pattern match gets wrong.

The per-segment audio path matters within a single session, independently of the other mode. Segments follow one another closely enough that a shared fixed path would let a new capture truncate the previous segment's audio while it was still being uploaded.

## Tuning procedure

Satisfies FR-021. Not a command and not a program — the recorder does this already:

```sh
sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart
soxi -D seg*.wav
```

Speak, stop the recording, and the file count and durations answer the question. Vary the second threshold pair to change pause sensitivity, then put the values that work into `listenSilenceDurationMs` and `listenSilenceThreshold`.

It belongs in the quickstart rather than in the package. An earlier draft specified a standalone Node script for this. It would have been a new file in a new directory, excluded from publication, reimplementing the recorder argument construction that already exists in the plugin — and therefore capable of being tuned correctly while the plugin stayed wrong. The shell form drives the same binary with the same effect chain the plugin uses, which is the property that makes the tuning transferable.

## Non-goals

No spoken output. No speaker identification. No distinguishing mention of a wake phrase from use of it — the spec accepts that talking about a phrase fires it, with discard as the recovery path.
