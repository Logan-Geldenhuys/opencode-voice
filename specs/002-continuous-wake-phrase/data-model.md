# Data Model: Continuous Listening with Wake-Phrase Submission

**Feature**: 002-continuous-wake-phrase | **Date**: 2026-09-06

Nothing here is persisted. The buffer in particular MUST NOT be written to disk: FR-014 bounds how old speech may be before it is discarded, and persisting it across restarts would defeat that bound entirely.

Entities from feature 001 — Credential, Capture, Service configuration — are reused unchanged and are not restated.

---

## Segment

One continuous stretch of speech bounded by pauses.

| Field        | Type           | Notes                                                                        |
| ------------ | -------------- | ---------------------------------------------------------------------------- |
| `path`       | string         | This segment's own audio file, in feature 001's owner-only capture directory |
| `durationMs` | number         | Used by the minimum-duration gate                                            |
| `capturedAt` | number         | Timestamp. Becomes the buffer entry's age basis                              |
| `text`       | string \| null | Transcript. Null until transcribed, and if transcription failed              |

**Validation**

- A segment shorter than the configured minimum duration MUST be discarded without transcription (FR-015). This is the cost gate: a door closing, a cough or a keystroke must not each become a paid request. SC-005 asserts that silence and noise generate no requests.
- A segment whose transcription fails MUST be dropped without ending the session (FR-019). One network error costs one segment, not the session.

**Lifetime**

From pause detection to transcription completion or failure. Deliberately shorter than the buffer entry it produces.

**Disposal**

Audio deleted as soon as transcription completes or fails (FR-018). At most one segment's audio exists at a time; SC-006 asserts nothing beyond the segment currently in flight.

Each segment writes a distinct file rather than reusing a fixed path. This is not defensive: segments within a single session follow one another closely enough that a fixed path would let one capture truncate the previous segment's audio while it was still being uploaded. Feature 001's capture object supplies this, which is why it is a prerequisite rather than a convenience.

**State transitions**

```text
capturing --pause detected--> complete
complete  --too short--------> discarded (audio deleted, no request)
complete  --transcribe-------> transcribed (audio deleted) --> appended to buffer
complete  --transcribe fail--> failed (audio deleted, session continues)

any state --session stops----> discarded (audio deleted)
```

---

## Buffer entry

One transcribed segment's text, with the time it was spoken.

| Field        | Type   | Notes                                                       |
| ------------ | ------ | ----------------------------------------------------------- |
| `text`       | string | Transcript of one segment                                   |
| `capturedAt` | number | Carried from the segment, **not** the time of transcription |

The distinction matters: age is measured from when the developer spoke, which is what FR-014 is about. Using transcription time would let a slow request make old speech look recent.

---

## Buffer

Ordered accumulation of entries since the last submission.

| Field      | Type          | Notes                     |
| ---------- | ------------- | ------------------------- |
| `entries`  | BufferEntry[] | Chronological             |
| `maxAgeMs` | number        | Configured bound (FR-014) |

**Validation**

- Entries older than `maxAgeMs` MUST be dropped. Enforced **both** on append and immediately before submission — appending alone is insufficient, because a buffer can sit untouched while the developer is silent and then be submitted by a wake phrase. SC-009 asserts that speech older than the bound never appears in a submitted prompt.
- A buffer with no usable text MUST NOT be submitted, and the developer MUST be told why (FR-016).
- The buffer MUST be inspectable and discardable without submitting (FR-013).

**Lifetime**

Created when listening starts. Cleared on every submission. Destroyed when listening stops.

**Assembly on submission**

1. Drop expired entries.
2. Locate the wake phrase across the remaining entries, matching on a normalised join.
3. Map the match position back into the original entry text and slice there: text before is the prompt, the phrase is excluded, text after is retained for the next buffer (FR-008).
4. Prefix the transcript label (FR-009).
5. If the result is empty, abort the submission and report (FR-016).

Step 3 is the load-bearing one. The match is found in normalised text but the prompt is cut from the original, so what reaches the agent retains the capitalisation and punctuation the developer spoke (FR-023). Slicing the normalised form instead would be simpler by about fifteen lines and would send `servertsx` where the developer said `Server.tsx`. SC-011 measures this character for character.

**The concurrency rule.** Steps 1 to 3 MUST occur under a guard that blocks appends, and the buffer MUST be replaced atomically with the retained tail. A segment transcribed while assembly is in progress must land in the _next_ buffer — not be silently dropped, and not be duplicated into both. This is the spec's _speech arrives while a submission is being assembled_ edge case, and it is the one place in this feature where a race produces silently wrong behaviour rather than an error.

**State transitions**

```text
empty --append--> accumulating --wake phrase--> assembling --> empty (+ retained tail)
                       |                            |
                       +--age expiry--> accumulating (pruned)
                       +--discard-----> empty
                       +--stop--------> destroyed
                                                    |
                                        +-----------+ (append blocked during assembly)
```

---

## Wake phrase

A configured spoken trigger.

| Field       | Type                               | Notes                                  |
| ----------- | ---------------------------------- | -------------------------------------- |
| `canonical` | string                             | The phrase as the developer says it    |
| `variants`  | string[]                           | Accepted recognition variants (FR-022) |
| `action`    | `"submit"` \| `"interrupt_submit"` | What firing it does                    |

**Validation**

- Matching operates on normalised text — case folded, punctuation stripped, whitespace collapsed (FR-003). Distortions beyond formatting are handled by `variants`, not by a second substitution pass.
- The normalised form MUST be used only to locate the phrase. It MUST NOT be what gets submitted (FR-023).
- Matching operates on the **whole buffer**, never a single segment (FR-004).
- When phrases share a prefix, the longer MUST win (FR-005). The two configured phrases share one by design, differing by an inserted word. SC-003 requires zero misclassifications.
- Both phrases and their variants MUST be configurable (FR-022).

**Why variants are explicit rather than fuzzy**

An explicit variant list fails predictably and is inspectable. Edit-distance matching trades a known false-negative rate for an unknown false-positive rate, and a false positive submits unintended speech to an agent holding file-modifying tools. Given that asymmetry, predictable failure is the safer property.

**Why there is no homophone map**

An earlier draft carried a configurable per-word substitution map alongside `variants`. Variants express everything it could and strictly more: the map's own motivating example was `opencode` heard as the two words `open code`, a distortion spanning a word boundary that whole-word substitution cannot represent. Two mechanisms for one job also means the weaker one runs first, on the text the stronger one is about to match, able to corrupt it before matching begins. `variants` is the single place to look when a phrase misfires.

---

## Listening session

The period between the developer turning listening on and off.

| Field     | Type            | Notes                                                            |
| --------- | --------------- | ---------------------------------------------------------------- |
| `active`  | boolean         | Never true at startup (FR-011)                                   |
| `capture` | Capture \| null | Feature 001's capture object for the segment currently recording |
| `buffer`  | Buffer          | Owned by the session                                             |
| `abort`   | AbortSignal     | Derived from the host's disposal signal                          |

**Validation**

- MUST NOT be active at startup. Beginning to listen requires an explicit act (FR-011).
- MUST NOT start while held-key dictation is capturing, and MUST cause a held-key attempt to be refused while active (FR-017). `active` is the whole of the exclusion check.
- Every transition MUST be signalled at the moment it occurs, and state MUST be reportable on demand (FR-012).

There is no `suspended` field. An earlier draft had one, for a design in which held-key dictation suspended the session and resumed it afterwards, discarding the overlap. FR-017 now refuses the second mode instead, so the state does not exist to be represented. This removed a state, a discard rule, and the transitions in and out of both.

**Lifetime**

Explicitly started, explicitly stopped, or terminated by editor exit.

**Disposal**

On stop or exit — including abnormal exit — the recorder is terminated, temp audio removed, in-flight transcription requests aborted, and the buffer discarded (FR-020). Termination targets the tracked process handle only, never a command-line pattern match, because the held-key path runs the same binary. FR-017 makes the two modes exclusive, but the exclusion is enforced by this plugin rather than by the operating system, so a stale recorder left by a crashed session is precisely the case a pattern match would get wrong.

**State transitions**

```text
off       --start--------------> listening
off       --held-key active----> refused (stays off)
listening --stop---------------> off
listening --held-key attempted-> refused (stays listening)
listening --editor exit--------> terminated
```

Two states, and the refusals are edges that return to where they started. This is what mutual exclusion buys over coordination: the diagram has no third state, so there is nothing to get stuck in.

---

## Relationships

```text
Listening session
  ├─owns──> recorder process ──emits──> Segment
  │                                        │
  │                                   transcribed
  │                                        v
  └─owns──> Buffer <──append── Buffer entry
                │
           wake phrase match
                v
            prompt ──> agent (labelled as transcript, auto-submitted)
```

Reused from feature 001: Credential (per-request resolution), Service configuration (transcription endpoint and tier). This feature adds no correction-service dependency at all — FR-010 removes it.

---

## Notable non-entities

**Correction result.** Absent by design (FR-010, research.md R-103). There is no corrected form of continuous speech; the raw transcript is what is submitted, labelled.

**Audio history.** No audio is retained beyond the segment being transcribed. There is no recording of a session, and no way to replay one. The tuning procedure (FR-021) records to the developer's own files outside the editor and has nothing to do with this entity.

**Indicator state.** There is no indicator, so there is no state for one. FR-012 is satisfied by announcing transitions as they occur and by a command that reads `session.active` and the buffer at the moment it is asked. Nothing is stored, which means nothing can disagree with the recorder - and the failure mode that would matter, a display reading "off" while the microphone is live, is unreachable rather than merely unlikely.

**Suspension.** Covered above: FR-017 refuses rather than coordinates, so there is no suspended session, no overlap window, and no queue of discarded audio.
