# Data Model: Continuous Listening with Wake-Phrase Submission

**Feature**: 002-continuous-wake-phrase | **Date**: 2026-09-06

Nothing here is persisted. The buffer in particular MUST NOT be written to disk: FR-014 bounds how old speech may be before it is discarded, and persisting it across restarts would defeat that bound entirely.

Entities from feature 001 — Credential, Capture, Service configuration — are reused and are not restated. One change is required to Capture and it is one of ownership, not of shape: the record of what is currently capturing moves out of `lib/stt.js` into `lib/capture.js` and widens from a single slot to a set, so that both capture modes and the teardown paths consult the same record. See plan.md Phase A0 and research.md R-108.

---

## Segment

One continuous stretch of speech bounded by pauses. One recorder process produces exactly one segment and then exits, so a segment corresponds one-to-one with a recorder lifetime and its boundary is the recorder's exit rather than something inferred about a file (research.md R-101).

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

From recorder start to transcription completion or failure. Deliberately shorter than the buffer entry it produces.

**Disposal**

Audio deleted as soon as transcription completes or fails (FR-018). At most one segment's audio exists at a time; SC-006 asserts nothing beyond the segment currently in flight.

Each segment writes a distinct file rather than reusing a fixed path. This is not defensive: the next recorder starts while the previous segment is still being uploaded, so a fixed path would let one capture truncate audio that is mid-request. Feature 001's capture object supplies the per-capture path, which is why it is a prerequisite rather than a convenience.

**State transitions**

```text
recording --recorder exits on silence--> complete
recording --max duration reached-------> complete (stop requested, recorder exits)
complete  --too short------------------> discarded (audio deleted, no request)
complete  --transcribe-----------------> transcribed (audio deleted) --> appended to buffer
complete  --transcribe fail------------> failed (audio deleted, session continues)

any state --session stops--------------> discarded (audio deleted)
```

Both routes to `complete` end the same way — the recorder exits and its `exited` promise settles — so the maximum-duration bound is a request to stop early rather than a second completion mechanism.

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

| Field      | Type          | Notes                          |
| ---------- | ------------- | ------------------------------ |
| `entries`  | BufferEntry[] | Chronological                  |
| `maxAgeMs` | number        | Configured age bound (FR-014)  |
| `maxChars` | number        | Configured size bound (FR-014) |

**Validation**

- Entries older than `maxAgeMs` MUST be dropped. Enforced **both** on append and immediately before submission — appending alone is insufficient, because a buffer can sit untouched while the developer is silent and then be submitted by a wake phrase.
- When the total text exceeds `maxChars`, the oldest entries MUST be evicted until it does not.
- Both bounds MUST evict **whole entries**. Never part of one. An entry is the unit the tokeniser works on and its token offsets index into its own text; evicting characters out from under them would leave the offsets pointing at text that is no longer there. Whole-entry eviction keeps the entry the atom it already is everywhere else in the feature.
- A buffer with no usable text MUST NOT be submitted, and the developer MUST be told why (FR-016).
- The buffer MUST be inspectable and discardable without submitting (FR-013).

The two bounds describe the same envelope from different directions and are sized to coincide: an hour of wall clock, and roughly an hour of continuous speech. The size bound is what fires when the developer has been talking; the age bound is what fires when they have not. In practice the size bound is the operative one, because talking non-stop for an hour reaches it slightly before the clock does, and the age bound is the backstop for a session left running over a long silence. SC-009 asserts only that eviction is oldest-first and leaves retained entries undamaged; neither bound is the feature's real protection against submitting stale speech, because both are an hour wide. That protection is inspecting and discarding the buffer (FR-013).

**Lifetime**

Created when listening starts. Cleared on every submission. Destroyed when listening stops.

**Assembly on submission**

1. Drop expired entries.
2. Locate the wake phrase as a contiguous run of normalised tokens across the remaining entries. No normalised string is assembled; each token carries offsets into the entry text it came from.
3. Join the entry texts verbatim, wake phrase included and in the position it was spoken (FR-008). The run's offsets are read only to decide whether anything besides the phrase was said; nothing is cut out.
4. Empty `entries`.
5. Prefix the transcript label (FR-009), which names the agent so the retained phrase reads as a direct address.
6. If nothing besides the phrase was said, report and stop without submitting (FR-016).
7. Submit.

Step 3 is the load-bearing one. The phrase is located through normalised tokens but the prompt is cut from the original text, so what reaches the agent retains the capitalisation and punctuation the developer spoke (FR-023). Slicing a normalised form instead would send `servertsx` where the developer said `Server.tsx`. SC-011 measures this character for character.

**Why the order is what it is.** Steps 1 to 4 mutate; steps 5 to 7 do not. Every mutation is complete before the first `await`, and appends only ever run in a continuation after an `await` of their own transcription request. So no append can interleave with assembly: by the time one could, `entries` is already empty and the text being submitted is a local value that no longer aliases it. A segment transcribed during the submission lands in the next buffer because that is the only buffer left to land in.

An earlier draft put step 4 after the submit and required steps 1 to 3 to run under a guard that blocked appends, describing this as the one place in the feature where a race produces silently wrong behaviour. Ordering the mutation first removes the window rather than guarding it, so the guard, the lock and the race are all gone (research.md R-109). The spec's _speech arrives while a submission is being assembled_ edge case is satisfied by the ordering, and a test asserts it by appending from a continuation scheduled during the submit.

**State transitions**

```text
empty --append--> accumulating --wake phrase--> empty
                       |
                       +--age or size eviction--> accumulating (oldest entries dropped)
                       +--discard---------------> empty
                       +--stop------------------> destroyed
```

There is no `assembling` state. Assembly does not span an `await`, so no other operation can observe the buffer part-way through one.

---

## Wake phrase

A configured spoken trigger.

| Field       | Type                               | Notes                                  |
| ----------- | ---------------------------------- | -------------------------------------- |
| `canonical` | string                             | The phrase as the developer says it    |
| `variants`  | string[]                           | Accepted recognition variants (FR-022) |
| `action`    | `"submit"` \| `"interrupt_submit"` | What firing it does                    |

**Validation**

- Matching operates on normalised tokens — each word case folded and stripped of punctuation, carrying its offsets in the original text (FR-003). Distortions beyond formatting are handled by `variants`, not by a second substitution pass.
- Normalisation MUST exist only to locate the phrase. No normalised text may reach the agent (FR-023). Because tokens are normalised individually and the original is never joined into a normalised string, there is no normalised form of the buffer that could be submitted by mistake.
- Matching operates on the **whole buffer**, never a single segment (FR-004). A token run may cross an entry boundary, which is how a phrase split by a pause still matches.
- When phrases share a prefix, the longer MUST win (FR-005). Enforced by sorting the compiled set by token count descending, so it is a property of the data rather than a rule in the search. The two configured phrases share a prefix by design, differing by inserted words. SC-003 requires zero misclassifications.
- Both phrases and their variants MUST be configurable (FR-022).

**Why variants are explicit rather than fuzzy**

An explicit variant list fails predictably and is inspectable. Edit-distance matching trades a known false-negative rate for an unknown false-positive rate, and a false positive submits unintended speech to an agent holding file-modifying tools. Given that asymmetry, predictable failure is the safer property.

**Why there is no homophone map**

An earlier draft carried a configurable per-word substitution map alongside `variants`. Variants express everything it could and strictly more: the map's own motivating example was `opencode` heard as the two words `open code`, a distortion spanning a word boundary that whole-word substitution cannot represent. Two mechanisms for one job also means the weaker one runs first, on the text the stronger one is about to match, able to corrupt it before matching begins. `variants` is the single place to look when a phrase misfires.

---

## Listening session

The period between the developer turning listening on and off.

| Field     | Type            | Notes                                                                     |
| --------- | --------------- | ------------------------------------------------------------------------- |
| `active`  | boolean         | Never true at startup (FR-011)                                            |
| `capture` | Capture \| null | The current recorder. Replaced once per utterance, null between recorders |
| `buffer`  | Buffer          | Owned by the session                                                      |
| `abort`   | AbortSignal     | Derived from the host's disposal signal                                   |

`capture` holds one recorder at a time and is replaced on each utterance rather than living for the whole session. It is also registered with `lib/capture.js` for the duration, so teardown does not depend on the session being asked politely.

**Validation**

- MUST NOT be active at startup. Beginning to listen requires an explicit act (FR-011).
- MUST NOT start while held-key dictation is capturing, and MUST cause a held-key attempt to be refused while active (FR-017). `active` is what the refusal message reads to name the mode, but the check itself consults the shared capture registry, because two per-mode flags can disagree with each other and with the operating system while one shared record cannot.
- Every transition MUST be signalled at the moment it occurs, and state MUST be reportable on demand (FR-012).

There is no `suspended` field. An earlier draft had one, for a design in which held-key dictation suspended the session and resumed it afterwards, discarding the overlap. FR-017 now refuses the second mode instead, so the state does not exist to be represented. This removed a state, a discard rule, and the transitions in and out of both.

**Lifetime**

Explicitly started, explicitly stopped, or terminated by editor exit.

**Disposal**

On stop or exit — including abnormal exit — the recorder is terminated, temp audio removed, in-flight transcription requests aborted, and the buffer discarded (FR-020). Termination targets tracked process handles only, never a command-line pattern match, because the held-key path runs the same binary. FR-017 makes the two modes exclusive, but the exclusion is enforced by this plugin rather than by the operating system, so a stale recorder left by a crashed session is precisely the case a pattern match would get wrong.

Exit teardown reaches this session's recorder because the recorder is in the shared registry, not because the exit hook knows the session exists. This is the whole point of Phase A0: as feature 001 stands, the exit hook drains a single module variable inside `lib/stt.js`, which a session-owned recorder would never appear in — leaving a live recorder and a file of the developer's voice behind on exactly the abnormal path FR-020 names.

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
  ├─starts, one per utterance──> recorder process ──exits──> Segment
  │                                    ^                        │
  │                              registered in              transcribed
  │                              lib/capture.js                 v
  └─owns──> Buffer <────────────append──────────────── Buffer entry
                │
           wake phrase match (token run)
                v
            prompt ──> agent (labelled as transcript, auto-submitted)
```

The recorder is not a long-lived child of the session. The session starts one, waits for it to exit, hands the file off to transcription, and starts the next — so the arrow from recorder to segment is the process exiting, not a message it sends.

Reused from feature 001: Credential (per-request resolution), Service configuration (transcription endpoint and tier), Capture (per-capture path, tracked handle, bounded termination). This feature adds no correction-service dependency at all — FR-010 removes it.

---

## Notable non-entities

**Correction result.** Absent by design (FR-010, research.md R-103). There is no corrected form of continuous speech; the raw transcript is what is submitted, labelled.

**Audio history.** No audio is retained beyond the segment being transcribed. There is no recording of a session, and no way to replay one. The tuning procedure (FR-021) records to the developer's own files outside the editor and has nothing to do with this entity.

**Indicator state.** There is no indicator, so there is no state for one. FR-012 is satisfied by announcing transitions as they occur and by a command that reads `session.active` and the buffer at the moment it is asked. Nothing is stored, which means nothing can disagree with the recorder - and the failure mode that would matter, a display reading "off" while the microphone is live, is unreachable rather than merely unlikely.

**Suspension.** Covered above: FR-017 refuses rather than coordinates, so there is no suspended session, no overlap window, and no queue of discarded audio.

**Normalised buffer text.** There is no normalised representation of the buffer, joined or otherwise. Normalisation happens per token and produces offsets, not text. An earlier draft joined the entries, normalised the join, matched in that string and then mapped the offsets back — work that existed only to recover the alignment the join had just discarded. Because no normalised string exists, FR-023 cannot be violated by submitting one, and SC-011 is measuring something unreachable rather than something forbidden.

**Assembly guard.** No lock, mutex or append queue. Replaced by the ordering rule above.

**Segment completion state.** Nothing tracks whether a segment has finished recording. The recorder's exit is that fact, delivered by the kernel. An earlier draft used one long-lived recorder writing numbered files, which required a directory watcher, a sequence parser, a rule for inferring that file _n_ was complete because file _n+1_ had appeared, and a size test to tell a real segment from the empty placeholder the recorder opens at each cut. Measurement showed both designs cut the audio in the same places, so all four mechanisms were paying for nothing (research.md R-101).
