# Quickstart: Continuous Listening with Wake-Phrase Submission

**Feature**: 002-continuous-wake-phrase | **Date**: 2026-09-06

**Prerequisite**: feature 001 installed and verified. This feature adds no new audio prerequisites, no new endpoints and no new credentials — it reuses all of them. If `specs/001-enterprise-gateway-stt/quickstart.md` does not pass, stop there first.

Like that file, this one is tracked in git and contains no gateway hostnames, tenant identifiers or credentials.

---

## 1. Tune segmentation before using it in the editor

Do this first. Default pause thresholds will be wrong for an unseen microphone and room, and diagnosing that from inside the editor is slow and misleading — badly tuned segmentation looks like broken wake-phrase detection.

No tooling is needed. The recorder segments to numbered files on its own:

```bash
cd "$(mktemp -d)"
sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart
```

Speak three sentences with clear pauses, then interrupt with Ctrl-C:

```bash
ls seg*.wav
soxi -D seg*.wav
```

Expect one file per sentence, each with a plausible duration. The two threshold pairs are `above_periods duration threshold` for the leading trim and then for the split, so `1 0.7 2%` is the 700ms-at-2% pause that `listenSilenceDurationMs` and `listenSilenceThreshold` configure.

| Symptom                           | Adjust                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| One long file covering everything | Lower the second threshold (e.g. `1 0.7 1%`) — noise is masking the pauses |
| Sentences split mid-word          | Raise the second duration (e.g. `1 1.0 2%`)                                |
| Many tiny files                   | Raise the threshold, or raise `listenMinSegmentMs` later                   |
| Nothing at all                    | Audio problem, not tuning. Re-run feature 001's step 2                     |

Record the values that work; they go into the configuration in step 2. This is FR-021's procedure.

The plugin does not use the `: newfile : restart` clause — it starts one recorder per utterance and lets each exit at the pause. The clause is here only so that one recording session yields several files, which is what makes the durations easy to read. The `silence` clause is what decides where the cuts fall, it is identical in both forms, and measurement confirmed the two produce the same boundaries to the sample (research.md R-101). A threshold that works here works in the plugin.

## 2. Configure

Extend the feature 001 entry in `~/.config/opencode/tui.jsonc` with the values from step 1:

```jsonc
[
  "/home/logan/opencode-voice",
  {
    "sttApiEndpoint": "{env:OPENCODE_VOICE_STT_BASEURL}",
    "sttApiModel": "gpt-transcribe",
    "sttVocabulary": ["opencode", "oxlint", "oxfmt", "WSL", "PulseAudio"],
    "listenSilenceDurationMs": 700,
    "listenSilenceThreshold": "2%",
    "listenMinSegmentMs": 400,
    "listenAutoSubmit": false,
  },
]
```

Wake phrases and both buffer bounds are omitted so the defaults apply. `opencode` is already in `sttVocabulary`, which biases recognition of both phrases' shared prefix.

`{env:...}` is resolved by the editor before the plugin sees the value, so the tracked configuration carries no hostname. Only the transcription endpoint appears: correction defaults from it, and this feature makes no correction calls at all (FR-010). There is no `listenIndicator` — state is announced rather than displayed, so there is nothing to configure.

`"listenAutoSubmit": false` is set deliberately for the first session. Wake phrases then fill the prompt instead of sending it, so you can see what _would_ have been submitted before trusting the feature with an agent that can modify files. It is also what makes step 3 safe to run. Remove it once the phrases behave.

Restart opencode.

## 3. Calibrate the wake phrases

Do this before trusting the feature and before removing `listenAutoSubmit: false`. It is the single highest-risk item in the whole feature, and unlike segmentation it cannot be checked from the shell, because it needs the transcription service.

Turn listening on, then speak each phrase ten times at a normal pace — varying speed a little, and once with a deliberate pause in the middle of the phrase:

| Utterance                   | Expected                                 |
| --------------------------- | ---------------------------------------- |
| `opencode execute`          | Prompt filled, agent **not** interrupted |
| `opencode stop and execute` | Agent interrupted, then prompt filled    |

Nine of ten must fire correctly for each phrase (SC-012). Any occurrence of the interrupt phrase behaving as a plain submission is an **SC-003 failure and is blocking**, because it both submits the wrong text and fails to stop the agent.

When an utterance does not fire, read what the recogniser actually returned out of the plugin log and add that form to the phrase's `variants` (FR-022):

```jsonc
"listenWakePhrases": [
  { "canonical": "opencode execute", "action": "submit",
    "variants": ["open code execute", "<what your log showed>"] },
  { "canonical": "opencode stop and execute", "action": "interrupt_submit",
    "variants": ["open code stop and execute", "opencode stop execute"] }
]
```

Then repeat the ten utterances. `open code` is already configured because it is the predictable split of the shared prefix; anything else is specific to your voice, microphone and room.

The output of this step is configuration, not a passing test. It is deliberately not automated: an automated benchmark would need committed audio fixtures, which would encode one voice in one room and would then be measuring the fixtures (research.md R-110). Matching itself _is_ tested exhaustively and with no tolerance — that is SC-002, and it runs in `npm run test` against text rather than audio.

---

## Verification

### User Story 1 — think aloud, then submit

| #   | Action                                                     | Expected                                                                      |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1.1 | Toggle listening on                                        | Transition announced at that moment                                           |
| 1.2 | Say three sentences with pauses, then _"opencode execute"_ | All three reach the agent as one prompt; agent starts work                    |
| 1.3 | Inspect the submitted prompt                               | Begins with the transcript label. Does **not** contain the phrase             |
| 1.4 | Speak again, submit again                                  | Second prompt contains only speech after the first submission — no repetition |
| 1.5 | Say _"opencode execute"_ having said nothing else          | Nothing submitted; told the buffer was empty                                  |
| 1.6 | Time from the end of the phrase to the agent receiving     | Under 3s typically, under 6s always (SC-001)                                  |
| 1.7 | Speak the phrase as _"opencode ... execute"_ with a pause  | Still fires — the token run crosses the entry boundary (FR-004)               |
| 1.8 | Dictate _"fix the bug in Server.tsx, then run npm test"_   | Prompt contains `Server.tsx` exactly, and the comma (SC-011)                  |
| 1.9 | Say _"opencode execute"_ and keep talking through the send | Later speech appears in the _next_ prompt. Never lost, never duplicated       |

Check 1.4 is the one that catches buffer-clearing bugs. Check 1.3 confirms both the label (FR-009) and phrase exclusion (FR-008). Recognition reliability is step 3's job, not a check here.

Check 1.8 is the one that is easy to skip and expensive to miss. If the prompt is cut from a normalised form instead of the original, `Server.tsx` arrives as `servertsx` and every sentence boundary is gone. Ordinary prose still reads perfectly well after normalisation, so this failure is invisible unless the check names an identifier. FR-023 forbids it; `test/wake.test.js` asserts it; this check confirms it end to end.

Check 1.9 exercises the assembly ordering. All buffer mutation completes before the submit is issued, so speech transcribed during the submit lands in the buffer that remains. Getting this wrong loses an utterance or sends it twice, and either way nothing reports it.

### User Story 2 — interrupt and redirect

| #   | Action                                                                                               | Expected                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2.1 | Give the agent a long task. While it works, speak a correction and say _"opencode stop and execute"_ | Agent stops, then acts on the new instruction                               |
| 2.2 | With the agent idle, say the interrupt phrase                                                        | Behaves as a plain submission. No error                                     |
| 2.3 | Say the interrupt phrase and check what was submitted                                                | Interpreted as interrupt, not as plain submission plus stray words (SC-003) |
| 2.4 | With the agent busy, say the plain phrase                                                            | Submits. Does **not** abort (research.md R-105)                             |

Check 2.4 verifies a decision, not an accident: the plain phrase never aborts, whatever the agent is doing.

### User Story 3 — visibility and control

| #   | Action                                       | Expected                                                             |
| --- | -------------------------------------------- | -------------------------------------------------------------------- |
| 3.1 | Toggle listening on, then off, then on again | Every transition announced as it happens (SC-007)                    |
| 3.2 | Run the status command                       | Active state, duration, segment count, buffer size, oldest entry age |
| 3.3 | Run it again while a segment is transcribing | Answers correctly and immediately. Does not block or race (SC-007)   |
| 3.4 | Accumulate speech, run the status command    | Accumulated text shown, nothing submitted (FR-013)                   |
| 3.5 | Discard the buffer, then submit              | Nothing sent; buffer was empty                                       |
| 3.6 | Toggle off, then restart opencode            | Listening off. Never resumes automatically (FR-011)                  |
| 3.7 | With listening on, `kill -9` opencode        | No recorder survives; no audio left behind (FR-020)                  |

There is deliberately no check for glancing at the screen and seeing microphone state. The host's notification call returns nothing that can be updated or dismissed, so a persistent indicator is not merely unbuilt, it is unrepresentable in the API. Check 3.3 is what replaces it: the developer must be able to ask at the moment they are most likely to wonder, which is while something is happening.

### Buffer bounds

| #                                                                                                                                                                                                                                                         | Action | Expected |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| Both bounds default to about an hour, so these checks require temporary overrides. That is the point of them: the bounds keep memory and prompt size finite, and are not the mechanism for discarding stale speech — the status and discard commands are. |

| #   | Action                                                              | Expected                                    |
| --- | ------------------------------------------------------------------- | ------------------------------------------- |
| 4.1 | Set `listenMaxBufferAgeMs` to `30000`. Speak, wait 45s, then submit | Old speech absent from the prompt (SC-009)  |
| 4.2 | Speak, wait past the bound, speak again, submit                     | Only the recent speech submitted            |
| 4.3 | Set `listenMaxBufferChars` low, exceed it, submit                   | Oldest entries dropped whole, newest intact |
| 4.4 | With a low char bound, check a retained entry's text                | Never truncated mid-entry                   |

Check 4.2 is the substantive one: expiry must be enforced on submission, not only on append. A buffer can sit untouched during silence and then be submitted by a wake phrase.

Check 4.4 guards whole-entry eviction. Token spans index into the entry text they came from, so trimming characters off the front of a retained entry leaves those spans pointing at text that has moved.

### Cost and noise gates

| #   | Action                                                    | Expected                                                     |
| --- | --------------------------------------------------------- | ------------------------------------------------------------ |
| 5.1 | Listen for 10 minutes in a quiet room, saying nothing     | Zero transcription requests (SC-005)                         |
| 5.2 | Type loudly, close a door, cough                          | Zero or near-zero requests — below the minimum-duration gate |
| 5.3 | Have a normal technical conversation avoiding the phrases | Zero unintended submissions (SC-004)                         |

Check 5.1 is the one to run first in a real session. A segmentation misconfiguration that transcribes silence is a continuous, silent cost.

### Resilience

| #   | Action                                                                     | Expected                                                 |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| 6.1 | Break the transcription endpoint mid-session for one segment, then restore | Session continues; one segment lost (FR-019, SC-008)     |
| 6.2 | Break it persistently                                                      | Escalated after repeated failures, not silently absorbed |
| 6.3 | During a session, `ls -la` the plugin's capture directory repeatedly       | At most one segment's audio at a time (SC-006)           |
| 6.4 | Stop listening, check again                                                | Nothing remains                                          |

### Mutual exclusion

| #   | Action                                                  | Expected                                                      |
| --- | ------------------------------------------------------- | ------------------------------------------------------------- |
| 7.1 | With listening on, press the dictation key              | Refused, naming listening and the command to stop it (SC-010) |
| 7.2 | Stop listening, then dictate                            | Works normally                                                |
| 7.3 | While holding the dictation key, try to start listening | Refused, naming dictation                                     |
| 7.4 | Throughout, `pgrep -a sox`                              | Never more than one recorder (SC-010)                         |

Check 7.4 is the substantive one. The refusal messages are the visible behaviour, but the property that matters is that two recorders never contend for the microphone. There is no suspend-and-resume path to test here and no overlap to discard: FR-017 refuses the second mode outright rather than coordinating both.

---

## Repository checks

```bash
cd /home/logan/opencode-voice
npm run test
npm run check
```

`test/wake.test.js` carries the highest-value assertions in the feature. Treat a failure there as blocking regardless of what else passes.

---

## Troubleshooting

| Symptom                              | Cause                                         | Fix                                                                            |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Wake phrase never fires              | Mis-transcribed                               | Run the status command to see the transcribed form; add it to `variants`       |
| Fires only sometimes                 | Split across segments, or threshold too tight | Confirm matching runs against the buffer, not segments (FR-004). Retune        |
| Interrupt read as plain submission   | Longest-wins broken                           | SC-003 violation. Blocking. Check the compiled set sorts by token count        |
| Identifiers lowercased in the prompt | Slice taken from normalised text              | FR-023 violation. Blocking. Check 1.8                                          |
| Punctuation missing from the prompt  | Same cause                                    | Same. The slice must come from the original text, at token spans               |
| An utterance sent twice, or lost     | Buffer replaced after the submit, not before  | Check 1.9. All mutation must precede the first `await`                         |
| Recorder survives `kill -9`          | Capture not in the shared registry            | FR-020 violation. Blocking. See plan.md Phase A0                               |
| Whole session as one segment         | Threshold too high for the room               | Lower `listenSilenceThreshold`. Retune with step 1                             |
| Constant requests during silence     | Threshold too low                             | Raise it. Check 5.1                                                            |
| Old speech in a submission           | Expiry not enforced on submission             | Check 4.2                                                                      |
| Dictation refused unexpectedly       | A listening session is still active           | Expected behaviour (FR-017). Stop listening first                              |
| Two recorders running                | Exclusion check not wired, or a stale process | SC-010 violation. Check 7.4                                                    |
| No announcements at all              | Transition signalling not wired               | FR-012. There is no indicator to fall back to; announcements are the mechanism |
| Listening on at startup              | State persisted                               | FR-011 violation. Listening state must never be persisted                      |
