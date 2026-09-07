# Research: Continuous Listening with Wake-Phrase Submission

**Feature**: 002-continuous-wake-phrase | **Date**: 2026-09-06

Builds on feature 001's research, which established the gateway, the transcription tier and the credential source. Findings here concern segmentation, wake-phrase handling, and the two host capabilities this feature needs that feature 001 did not.

---

## R-101 — Segmentation

**Decision**: Split at pauses, using the recorder's own silence detection. Not at fixed intervals. **One recorder process per utterance, with completion signalled by the recorder exiting** — not one long-lived recorder writing numbered files.

**Rationale, part one: why pauses.** Fixed-interval chunking cuts words in half. A word split across two requests is mis-transcribed in both, and the damage is not recoverable by concatenation. Worse for this feature specifically, a wake phrase split across a chunk boundary may be recognisable in neither half.

The capture tool already performs silence-based splitting, so this costs no new dependency — which matters given the zero-runtime-dependency invariant.

**Rationale, part two: why one process per utterance.** Transcription is request/response, so something must decide a stretch of speech is over and hand across a complete file. Only the recorder has the samples, so only the recorder can decide. That much is forced by R-102's absence of streaming. What is left is a real choice, and it is narrower than it first appears: **how does the recorder tell the plugin that a file is finished?** A child process has exactly two ways.

1. **Open the next file and leave the previous one to be inferred complete.** This is what `: newfile : restart` does. The signal is a filesystem side effect, and the plugin reconstructs meaning from it.
2. **Exit.** The kernel then closes the descriptor, flushes the buffer, finalises the WAV header and delivers `SIGCHLD`. The signal is an operating-system guarantee.

The second is preferred because a guarantee is worth more than a reconstruction, and because measurement shows it costs nothing in segmentation quality. Both were run against the same fixture — three 5.2s utterances separated by 1.5s of silence, with the effect chain `silence 1 0.1 2% 1 0.7 2%`:

```text
long-lived + ": newfile : restart"   ->  5.204937s  5.204937s  5.620750s
single-shot, no restart              ->  5.204937s  then exit 0
```

Identical to the sample. The single-shot exited on the _detected pause_ at 5.2s rather than running to the end of the 20s input, which is the behaviour that matters: it proves stop-on-silence fires mid-stream rather than at end-of-input, so it will fire on a live device that never ends. This is not surprising on inspection — `restart` re-runs the same effect chain that a fresh process runs from the start. The segmentation logic is the same code in both designs. Only the location of the restart differs.

What differs is the cost on the plugin side. Choosing the filesystem channel means building five mechanisms: a directory watcher, sequence-number parsing, a rule inferring that file _N_ is complete because file _N+1_ appeared, and — measured on the same fixture — classification and cleanup for the empty placeholder the recorder leaves behind:

```text
segC001.wav  166602 bytes  5.204937s
segC002.wav  166602 bytes  5.204937s
segC003.wav      44 bytes  0.000000s   <- bare WAV header, no audio
```

A 44-byte header is indistinguishable _by existence_ from a real segment, so the watcher needs a size or duration test to tell them apart. That test does the same job as the minimum-duration gate in FR-015 while meaning something entirely different — one is a cost control the developer tunes, the other is a parsing detail — and conflating them is how a tuning change silently starts dropping real speech.

Choosing process exit means none of that. `capture.exited` already exists in feature 001 and already resolves from both the `exit` and `error` events. The loop is: spawn, await, transcribe, spawn.

**The cost, stated plainly.** No audio is captured between one recorder exiting and the next being ready. Measured at roughly 130ms on this machine (1.000s of requested audio taking 1.137s and 1.129s of wall time across clean runs), which is process spawn plus audio-server stream setup. This is acceptable rather than negligible, and the reason is structural: the effect chain trims leading silence, so a newly spawned recorder is not recording from its first sample — it is waiting for speech. The gap therefore lands inside a pause by construction. Losing anything at all requires the speaker to resume within 130ms of the 700ms pause that just ended the previous segment, and the worst case is the attack of a single syllable, which FR-004's buffer-wide matching already absorbs.

Two smaller consequences favour the same choice. A crash takes one utterance with it rather than the whole session. And `listenMaxSegmentMs` becomes a `setTimeout` calling the existing `capture.stop()`, which is the path a normal stop already takes, rather than a second termination mechanism reserved for the abnormal case.

**Rationale, part three: thresholds are configuration.**

Pause thresholds depend on microphone gain, room reverberation and speaking style, and no value chosen at design time will be right on an unseen machine. This is why FR-021 requires a way to tune them outside the editor: without one, tuning means repeatedly restarting the editor to test a threshold.

That way is the recorder itself, not a program written for the purpose. The same tool the plugin drives will segment to numbered files from a shell prompt:

```sh
sox -d seg.wav silence 1 0.1 2% 1 0.7 2% : newfile : restart
soxi -D seg*.wav
```

Speak, stop the recording, and the file count and durations answer the question directly. An earlier draft of this plan specified a Node harness for this. It would have been a new file, in a new directory, excluded from the published package, reimplementing argument construction that already exists in the plugin - and therefore able to be tuned correctly while the plugin remained wrong.

Note that the tuning one-liner uses `newfile : restart` while the plugin does not. That is deliberate and safe, and the measurement above is what makes it safe: the two forms cut at the same sample, so the durations the shell prints are the durations the plugin will see. What is being tuned is the silence effect's parameters, which are identical in both. The procedure observes the plugin's segmentation without reimplementing it.

**Alternatives considered**: Fixed 3-second chunks were the obvious first design and were rejected on the word-splitting problem above. Voice activity detection as a library dependency was rejected against the zero-dependency invariant, and would have required a build step for any native component. A long-lived recorder with `: newfile : restart` and a directory watcher was the design in an earlier draft of this plan; it is rejected above on the evidence, having been carried that far on the unexamined assumption that continuous listening implies a continuous process.

---

## R-102 — Streaming transcription

**Decision**: Unavailable. Segments are transcribed as complete files over HTTP.

**Rationale**: Measured, not assumed. Both realtime paths are blocked at the gateway:

```
GET  {openai-host}/v1/realtime?intent=transcription   (WebSocket upgrade)
  -> 403 "AI Gateway error: The endpoint ... you requested is not allowed"

POST {openai-host}/v1/realtime/transcription_sessions
  -> 403 "AI Gateway error: The endpoint ... you requested is not allowed"
```

This is a gateway policy decision, not a capability gap in the upstream service, and it is not something the plugin can work around.

**Consequence, which propagates into the spec**: a wake phrase cannot be acted upon until the speaker has stopped talking long enough for a pause to be detected and the segment transcribed. There is no partial-hypothesis stream to match against mid-utterance. This sets the floor under SC-001 and is recorded as an assumption in the spec so that the latency is understood as a constraint rather than read as sloppiness.

**Alternatives considered**: Overlapping segment windows to shorten effective detection latency were considered and rejected — they multiply request volume, and deduplicating overlapping transcripts reintroduces the word-boundary problem R-101 exists to avoid.

---

## R-103 — No correction pass on continuous speech

**Decision**: Submit continuous speech uncorrected, labelled as a transcript that may contain recognition errors.

**Rationale**: The user asked for this directly: _"instead of using GPT-4.1-mini to normalize, just say that this is a transcript and may include errors whenever we send it to the agent."_

The measurements support it independently, which is worth recording because it means the requirement is not merely a preference:

- **Latency.** Correction costs 1.62s at p50 (feature 001, R-004). In held-key dictation that is paid once per deliberate act of composition. Here it would be paid on every submission, against a 3s p50 target that already spends 0.75s on transcription and ~0.5s on pause detection.
- **Error character.** Correction can substitute a confident wrong identifier — `gpt-4o-mini` produced `lib/sst.js` from `lib/stt.js`. In held-key dictation the developer reviews before sending, so the error is catchable. Continuous mode auto-submits, so an invented filename reaches the agent unreviewed.
- **Context.** The agent has the project's actual file tree and symbol names. A correction pass has a system prompt and a session title. The agent is strictly better placed to resolve `lib slash s t t dot j s`, provided it is told the text is a transcript.

So the label is not a consolation for skipping correction. It relocates the correction to the component best equipped to do it.

**Alternatives considered**: Correcting only when the buffer is short was rejected as unpredictable — identical-looking submissions would behave differently. Correcting asynchronously after submission was rejected as incoherent: the agent would already be working from the raw text.

---

## R-104 — Wake-phrase matching

**Decision**: Match phrases as runs of tokens that carry offsets into the original text. Slice the original by those offsets. Longest phrase first. **No normalised string is ever assembled.**

**Rationale**: Exact string matching cannot work. Transcription returns the same spoken phrase with varying capitalisation, trailing punctuation and internal spacing. A literal comparison would fail unpredictably, and unpredictable triggering is worse than no triggering - the developer stops trusting the feature. So comparison happens on a normalised form: case folded, punctuation stripped.

**But the normalised form must not be what gets submitted.** Normalisation is lossy in exactly the dimension that matters to an agent:

```text
"Fix the bug in Server.tsx, then run npm test."
  normalises to
"fix the bug in servertsx then run npm test"
```

`Server.tsx` does not survive. Neither does any sentence boundary across a multi-minute buffer. An earlier draft of this contract concluded that submitting normalised text was "acceptable and arguably preferable" on the grounds that punctuation from a transcript is unreliable anyway. That is wrong, and it is wrong in a way that is invisible in testing: normalised prose still reads perfectly well, so a test written on ordinary sentences passes whether or not the identifiers survived. The feature would corrupt precisely the terms FR-009's transcript label asks the agent to treat with care, and it would do so silently.

**How the original survives: tokens carry their own provenance.** An earlier draft solved this by building a normalised join of the whole buffer, matching inside it, then mapping the resulting character offset back to a `(segmentIndex, charOffset)` pair and slicing the originals. It described that mapping as the one place in the feature that deliberately added code, and estimated it at fifteen lines.

The mapping exists only to recover information the join had just thrown away. Do not throw it away. Tokenise each buffer entry into words, and let each token record the offsets it occupied in **its own original text**:

```text
entry:  "Fix the bug in Server.tsx, then run npm test."
tokens: fix[0,3) the[4,7) bug[8,11) in[12,14) servertsx[15,25) then[27,31) ...
```

Matching is then a search for a contiguous run of tokens whose normalised forms equal the phrase's normalised forms. `before` is the original text up to the first matched token's start offset; `after` is the original text from the last matched token's end offset. Nothing is ever reconstructed from a normalised string, because no normalised string longer than a single token is ever built. There is no offset space to map back _from_.

This is strictly less code than the mapping it replaces, and it makes two other things disappear:

- **Word-boundary alignment stops being a rule.** An earlier draft listed it as a separate matching rule with its own test: a match had to align to word boundaries so that `submitted` could not satisfy a phrase containing `submit`. A token run cannot partially match a token, so the rule has nothing left to constrain. It is deleted rather than tested.
- **Punctuation tolerance stops being a normalisation step.** `opencode, execute!` yields the same two tokens as `opencode execute`, because punctuation is simply not part of a token.

FR-023 requires the original text be submitted and SC-011 measures it character for character. Under this design the requirement holds by construction: the failure it guards against is unreachable rather than forbidden.

Two matching rules remain, neither obvious:

1. **Match against the whole buffer, not each segment** (FR-004). A phrase spoken across a pause lands in two segments and appears in neither alone. Pause placement inside a two-word phrase is not under the speaker's conscious control, so this is a normal case, not an edge case. Token runs cross entry boundaries; the slices come from whichever entries the run touched.
2. **Longest phrase wins** (FR-005). The two configured phrases share a prefix by design - one is the other plus an inserted word. Matching the shorter one first would read the interrupt variant as a plain submission followed by stray words, submitting the wrong thing _and_ failing to interrupt. SC-003 requires zero occurrences of this, which is why the phrase list is sorted by token count at compile time: the guarantee becomes a property of the data structure rather than a code path a caller can bypass.

A third rule was specified and has been removed. An earlier draft resolved multiple matches in the buffer by taking the last occurrence. But FR-004 requires detection after every segment append, so at most one phrase can be present at the moment detection runs - the first would have fired and cleared the buffer before the second was spoken. First-versus-last was unobservable. It has been replaced by the invariant itself, plus a test asserting it.

Transcription-side vocabulary biasing is available and confirmed working on the chosen tier, and is applied to raise the phrase's recognition rate before matching ever runs.

**Alternatives considered**: Fuzzy matching with an edit-distance threshold was rejected - it trades a known false-negative rate for an unknown false-positive rate, and false positives here submit unintended text to an agent with file-modifying tools. An explicit variant list fails predictably and is inspectable.

A configurable per-word homophone map was specified and has been removed. Variants (FR-022) already express everything it could, and strictly more: the motivating example was `opencode` recognised as the two words `open code`, which is a distortion spanning a word boundary that whole-word substitution cannot represent at all. Keeping both would mean the weaker mechanism running first, on text the stronger one is about to match, with the ability to corrupt it before matching begins. One mechanism means one place to look when a phrase misfires.

---

## R-105 — Agent interruption

**Decision**: Abort the session, then submit. The plain phrase submits regardless of agent state.

**Rationale**: The host exposes both a session abort and a prompt submission path, so the interrupt variant is abort-then-submit.

The behaviour that needs deciding is what the _plain_ phrase does when the agent is busy — the spec's _agent is busy when a plain submission fires_ edge case. The requirement is that behaviour be defined and consistent rather than timing-dependent. Decision: **the plain phrase always submits and never aborts.** The developer chose the phrase without the interrupt word; interpreting it as an interrupt because of the agent's incidental state would make the two phrases indistinguishable in exactly the situation where the distinction matters. If the host queues the prompt behind current work, that is the host's normal behaviour for a prompt submitted while busy, and matches what typing would do.

The converse is also fixed: the interrupt phrase with an idle agent submits normally and raises no error (FR-007). There is nothing wrong with asking to stop something that has already stopped.

**Alternatives considered**: Making the plain phrase abort when busy was rejected on the indistinguishability argument above. Rejecting the plain phrase while busy was rejected because it silently loses a buffer the developer intended to send.

---

## R-106 — Reporting listening state

**Decision**: Announce every transition as it happens, and provide a command that reports state and buffer contents on demand. No persistent indicator.

**Rationale**: Three findings, and together they leave one option.

- **Transient notifications cannot be made persistent.** The host's notification call returns nothing - no handle, no dismiss, no update. It is fire-and-forget by construction. A notification that stays on screen while the microphone is live is not merely awkward to build, it is unrepresentable in the API.
- **A persistent slot surface exists, and built-in plugins use it.** Confirmed by reading the shipped binary: a built-in plugin registers `app`, `app_bottom` and `home_bottom` renderers and builds element trees through the host's element factory.
- **Whether an _external_ plugin can reach it is unproven.** Built-in plugins are compiled into the binary and resolve the rendering runtime internally. An external plugin would have to resolve it itself; the packages concerned are declared as optional peer dependencies and are not installed. No external plugin on this machine calls the slot API, so there is no working example to copy. The ergonomic form of that API is JSX, which would require a build step and therefore violate an `AGENTS.md` invariant outright.

An earlier draft resolved this with a runtime capability probe: try the element factory without JSX, fall back to signalling if it fails. That was a reasonable hedge, and it has been dropped for two reasons. First, it makes an unproven surface a load-bearing part of the design, with a second code path that only executes on machines where the probe succeeds - which is the hardest kind of behaviour to test. Second, FR-012's own stated minimum turns out to be sufficient: the developer's requirement is not to see the microphone state continuously, it is to not lose track of it. _"As long as the plugin displays something in opencode it should be good."_

So signalling is the design rather than the fallback. Every transition is announced at the moment it occurs, and `listen.status` answers on demand. Neither depends on an unproven API, neither needs a build step, and there is one code path instead of two.

The cost is honest and worth naming: there is no way to glance at the screen and see that the microphone is live. An earlier success criterion asked for exactly that within two seconds, and has been removed rather than restated more weakly, because a `void`-returning notification call cannot deliver it.

**Alternatives considered**: A terminal-multiplexer status indicator was researched in depth and is entirely feasible - the developer's existing configuration already drives status styling from user options set by external processes, so this would be idiomatic rather than novel. It was dropped on explicit instruction: _"Look forget the TMUX piece for now."_ It remains the best answer if a persistent indicator is ever wanted, and is recorded here for that reason. It has one real drawback: it spans two repositories, since the plugin sets the option but the multiplexer configuration must render it.

If a persistent indicator is wanted later, the way in is a throwaway spike against `slots.register` with a non-JSX element factory, promoted to a feature only if it works. That is a separate increment with its own evidence, not a branch inside this one.

---

## R-107 — Mutual exclusion with held-key dictation

**Decision**: The two modes are mutually exclusive. Attempting one while the other is active is refused.

**Rationale**: Both paths capture from the same microphone. Left alone, speech intended for held-key dictation is also captured continuously, transcribed twice, and reaches the agent twice - once as reviewed dictation and once inside a later buffer.

An earlier draft solved this by coordination: held-key dictation would suspend the listening session, whatever continuous capture recorded during the overlap would be discarded, and the session would resume afterwards. That is a state machine over a long-lived child process, with a discard window, verified across twenty alternating exchanges.

Refusal is the cheaper answer and loses nothing. The developer asked for both modes to exist - _"I probably want both push-to-talk and continuous modes"_ - which is a requirement about what the plugin offers, not about what can be armed simultaneously. And the two are functionally redundant while both are running: during a listening session the wake phrase already performs the submission that the held key exists to perform. Suspending one mode to run a second mode that does the same job is machinery in service of nothing.

So the second attempt is refused, with a message naming what is active and how to stop it. There is no suspend state, no discard window, no resume path, and no overlap to test. FR-017 states the exclusion and SC-010 measures the refusal.

This depended on feature 001's capture-object work, which is now complete: termination is by tracked handle rather than command-line pattern match, so the two paths can no longer kill each other's recorder, and each capture owns its own audio path, so segments following each other closely within one listening session cannot truncate one another.

One part of that dependency is _not_ satisfied, and it is the part the exclusion itself rests on. The refusal is enforced by the plugin, not by the operating system, so it needs a single answer to the question "is anything capturing right now". Feature 001 keeps that answer private to `lib/stt.js`. See R-108.

---

---

## R-108 — Capture ownership

**Decision**: Move the registry of live captures out of `lib/stt.js` into a `lib/capture.js` that both modes register with. Generalise it from one nullable slot to a set.

**Rationale**: Feature 001 built the right object and gave it the wrong home. `createCapture` is a pure factory that touches no module state, so this feature can create captures freely. But everything _around_ it is private to `lib/stt.js`: the temp-directory helper is not exported, the filename sequence counter is module-scoped, and the record of what is currently capturing is a single module-level variable that only `stt.js` can see. The teardown functions act on that one variable, and `index.js` wires them to the plugin disposal callback and to `process.once("exit")`.

The consequence is that a capture created by `listen.js` would be invisible to every teardown path in the plugin. That is not a tidiness concern; two requirements fail outright:

- **FR-020** requires that abnormal exit leave no recorder running and no audio on disk. The exit hook reaches one variable, so an abnormal exit during a listening session leaves a live recorder holding the microphone and a recording of the developer's voice in a temp directory.
- **FR-017** requires that the two modes never both be active. Without a shared record, the check compares a flag in `listen.js` against a variable in `stt.js` — two facts that can disagree. Feature 001's own source comments identify that exact pattern as the cause of every capture lifecycle defect it set out to fix, which is why repeating it here would be a regression rather than a shortcut.

A set rather than a slot, because this feature creates one capture per utterance and the synchronous exit-time drain must terminate whichever one is live at that instant, not the one some variable last happened to hold.

This is the only place where feature 001's code is modified rather than called, and the scope is relocation: roughly twenty lines moved, one type widened, `stt.js` importing what it previously declared and behaving identically.

**Alternatives considered**: Duplicating teardown inside `listen.js` and registering a second exit hook was rejected — two independent cleanup paths over one microphone is the defect being avoided, not a way of avoiding it. Exporting the existing singleton from `stt.js` unchanged was rejected because a single slot cannot hold a per-utterance capture and a held-key capture even transiently, and the exclusion check needs to read the same value both modes write.

---

## R-109 — Submission assembly and the append race

**Decision**: Order the submission steps so every buffer mutation completes before the first `await`. No lock, no guard, no queue.

**Rationale**: Speech transcribed while a submission is being assembled must land in the _next_ buffer — neither dropped nor duplicated into both. An earlier draft required assembly to run "under a guard that blocks appends", and described this as the one place in the feature where a race produces silently wrong behaviour rather than an error.

The race is real but it is created by the step order, not by concurrency. Appends happen only in continuations that resume after `await transcribe(...)`. JavaScript runs those continuations on the same thread as everything else, so no append can interleave with a _synchronous_ run of statements. The earlier draft put the buffer mutation after the asynchronous submission, which opens a window, and then proposed a lock to close it.

Doing the mutation first closes it without a mechanism:

```text
1. drop expired entries          |
2. locate the phrase             |  synchronous: one tick, no await
3. slice before / after          |
4. replace the buffer with `after`  |
--- first await below this line ---
5. prefix the transcript label
6. submit (and, for the interrupt phrase, abort first)
```

By the time anything can be appended, the buffer already _is_ the retained tail, and the text being submitted is a value held in a local variable that no longer aliases it. The requirement is satisfied by choosing an order. There is nothing to lock, nothing to test for contention, and no window to reason about.

**Alternatives considered**: A mutex or a boolean guard was the earlier draft's answer and is rejected as unnecessary given the above. Draining the transcription queue before assembling was rejected as strictly worse: it delays submission by up to a full request in order to add speech the developer had already finished saying when they spoke the wake phrase, which is the opposite of what FR-008 asks for.

---

## R-110 — Wake-phrase recognition rate

**Decision**: Treat recognition fidelity as a one-time calibration whose output is configuration. Do not build an audio benchmark, and do not gate continuous integration on speech.

**Rationale**: An earlier success criterion asked for at least 95% correct action "across a fixed set of recorded utterances of each wake phrase — spoken at varying speed, with and without a pause inside the phrase". Read as a test obligation, that is an audio fixture corpus plus a harness that drives it through the gateway — the same kind of artifact R-101 and FR-021 already declined to build for segmentation, arrived at by a different route.

Two different questions were folded together in it, and they have different answers:

- **Does the matcher act correctly on text containing a phrase?** A property of this feature, deterministic, and exhaustively testable as a pure function over strings. The target is therefore 100%, not 95% — a sampled tolerance on a deterministic function only measures how many cases the test author wrote. This is now SC-002.
- **Does the transcription service return the phrase in a form the matcher accepts?** A property of the gateway, the microphone, the room and the speaker's accent. It is not a constant, cannot be established at design time, and its correct answer _is_ the `variants` list. Measuring it produces configuration, not a verdict.

So the second becomes a calibration step in [quickstart.md](./quickstart.md): speak each phrase several times, read back what the service actually returned, and add any recurring form to `variants`. Its acceptance check is SC-012, performed once by the developer. This is the same shape as pause-threshold tuning, and for the same reason — inputs that live in a room rather than in the repository.

**Alternatives considered**: Committing audio fixtures to the repository was rejected: they would encode one voice in one room, so passing would say nothing about the developer's, and they cannot be regenerated without that voice. Mocking the transcription response was rejected as circular — it would assert that the matcher accepts forms the test author already knew it accepted, which is SC-002 with extra machinery.

---

## Resolved unknowns

| Unknown                                                 | Resolution                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Streaming transcription available?                      | No. 403 on both realtime endpoints (R-102)                                   |
| How to segment continuous audio                         | Recorder's silence detection, thresholds configurable (R-101)                |
| How the plugin learns a segment is complete             | The recorder exits. One process per utterance, measured equivalent (R-101)   |
| Whether to correct continuous speech                    | No. Label as transcript (R-103)                                              |
| How to match phrases reliably                           | Token runs, longest first (R-104)                                            |
| What text reaches the agent                             | The original, sliced by token offsets. No normalised string is built (R-104) |
| Plain phrase behaviour while agent busy                 | Always submits, never aborts (R-105)                                         |
| Persistent indicator reachable from an external plugin? | Unproven, and no longer needed. Announce transitions (R-106)                 |
| Preventing double capture                               | Modes are exclusive; the second attempt is refused (R-107)                   |
| Where the "is anything capturing" answer lives          | One registry in `lib/capture.js`, joined by both modes (R-108)               |
| Losing or duplicating speech during assembly            | Mutate the buffer before the first await. No lock (R-109)                    |
| How reliably the service returns the phrase             | Calibrated once into `variants`; not a CI gate (R-110)                       |
| How to tune pause thresholds outside the editor         | Two lines of shell against the recorder itself (R-101)                       |
| Buffer bounds                                           | Age and size, both evicting whole oldest entries (data-model.md)             |
