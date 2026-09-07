# Data Model: Enterprise Gateway Speech-to-Text

**Feature**: 001-enterprise-gateway-stt | **Date**: 2026-09-06

This plugin has no database and no persisted domain objects. The entities below are in-memory values and one on-disk artefact with a deliberately short life. What matters for each is its lifetime and its disposal rule, not its shape.

---

## Credential

The developer's corporate SSO identity token.

| Field      | Type                 | Notes                                                              |
| ---------- | -------------------- | ------------------------------------------------------------------ |
| `value`    | string               | Opaque bearer token. Never logged, never persisted, never rendered |
| `source`   | `"store"` \| `"env"` | Which resolution path produced it. Reportable; the value is not    |
| `attempts` | Attempt[]            | One entry per source consulted, in order. Carries no token         |

**Validation**

- A resolved credential MUST be a non-empty string.
- Resolution MUST be attempted in order: credential store, then environment fallback.
- Every source consulted MUST be recorded, whether it succeeded or failed, because FR-006 requires the user be told what was tried. A source that failed records why.

The attempt log replaced an earlier design that classified failures into four distinguished reasons. The classification was only ever rendered when every source had failed, and in that case what the developer needs is the state of each source rather than a single label for the collection. The log is the more informative encoding and costs one code path instead of a union.

**Lifetime**

Resolved per request, and not retained between requests. There is no cache. The store is a local file of a few kilobytes; reading it costs roughly three orders of magnitude less than the network request it authorises, and a cache is the only mechanism by which this module could serve a token it had already been told was superseded. That is the failure this feature exists to remove.

**Disposal**

Never written anywhere. Not to logs, not to disk, not to any request other than the authorization header of the configured service. This is FR-007 and SC-004.

**State transitions**

```text
per request: --resolve()--> resolved(store)          [store readable, key present]
             --resolve()--> resolved(env)            [store failed, variable set]
             --resolve()--> failed(attempts)         [no source produced a value]
```

There is no transition out of `resolved`, because nothing survives the request. Each call begins from nothing. This is the whole of FR-005, and it is the reason the state diagram has no edges between states.

---

## Capture

One recording, from key press to key release.

| Field     | Type         | Notes                                                                               |
| --------- | ------------ | ----------------------------------------------------------------------------------- |
| `process` | ChildProcess | Handle to the spawned recorder. The **only** legitimate termination target (FR-016) |
| `path`    | string       | Temp file receiving audio. Owner-only permissions (FR-014)                          |
| `active`  | boolean      | At most one capture may be active (FR-017)                                          |

The three fields belong to one object with one owner, and this is the substance of the capture work rather than an incidental detail. They currently live as separate module-level mutable variables, which is the shared cause of all four lifecycle defects: a stale process handle is killed by pattern match because no handle is reliably held, and a fixed file path is reused because no capture owns its file. An object that owns its process and its file makes the four fixes one fix.

The same object is what feature 002 records a second instance of, for a differently-shaped capture that segments continuously rather than ending on a key release. That reuse is a consequence of the shape, not additional work.

**Validation**

- At most one capture active at a time. A second trigger while one is active MUST be handled deterministically — rejected or queued — never permitted to run concurrently.
- A capture producing no audio, or audio below a usable threshold, MUST NOT produce a transcription request and MUST NOT insert text (FR-002's empty case, and the spec's _recording with no speech_ edge case).

**Lifetime**

Bounded by the transcription attempt. A capture that has been transcribed, or has failed to transcribe, is finished.

**Disposal**

The audio file is deleted on **both** success and failure. On editor exit, including abnormal exit, the process is terminated and the file removed (FR-015, FR-020 of the sibling feature). SC-006 asserts zero files remain after a session.

Each capture writes a distinct file inside a directory created once per plugin load and restricted to its owner at creation time. Uniqueness per capture is not cosmetic: it is what lets two captures exist without one truncating the other's audio, which is the condition feature 002 introduces.

**State transitions**

```text
idle --trigger--> recording --release--> stopping --> transcribing --> done
                                                            |
                                                            +--> failed

any state --editor exit--> terminated (process killed, file removed)
```

`done` and `failed` both delete the audio file. There is no state in which a capture's audio outlives its transcription attempt.

---

## Transcript

Text produced from a capture. Exists in two forms.

| Field       | Type           | Notes                                                           |
| ----------- | -------------- | --------------------------------------------------------------- |
| `raw`       | string         | Direct output of the transcription service                      |
| `corrected` | string \| null | Output of the correction pass. Null if correction failed        |
| `presented` | string         | What reaches the prompt. `corrected` when available, else `raw` |

**Validation**

- An empty or whitespace-only `presented` value MUST NOT be inserted (FR-002).
- `presented` is appended to existing prompt content, never substituted for it (FR-003).
- `presented` is never submitted automatically (FR-002).

**Rationale for the fallback**

If correction fails, the raw transcript is still useful and the user is reviewing it anyway. Degrading to raw text is strictly better than losing the utterance. This mirrors existing upstream behaviour and is retained deliberately.

---

## Service configuration

Split by whether the developer changes it at runtime.

### Static — supplied via plugin `options`

| Field                                   | Notes                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| Transcription endpoint                  | Defaults to the correction endpoint when only one is given (FR-008)   |
| Correction endpoint                     | Defaults to the transcription endpoint. Independent if both are given |
| Correction model                        | Default `gpt-4.1` (research.md R-004)                                 |
| Credential store path and property path | Where to find the token, and where inside it                          |
| Credential environment variable         | Fallback source name (FR-006)                                         |
| Vocabulary bias terms                   | Passed to transcription to improve identifier recognition             |
| Request timeout                         | Bound on transcription and correction (FR-018)                        |

Endpoint values may be written into configuration as `{env:NAME}`, which the editor substitutes from the environment before the plugin sees them (research.md R-008). This is a host facility, not a plugin one: there is no paired `...Env` option and no resolution code, which is how FR-009 is satisfied without adding a mechanism.

The credential is deliberately excluded from that facility and named by variable instead. Host substitution happens once, when configuration is read; the credential must be read at each request, because the token this deployment uses is replaced daily. Substituting it would pin a value for the lifetime of the editor session and reintroduce exactly the staleness FR-005 removes.

### Runtime — held in `api.kv`, persisted by the host

| Field              | Notes                                                      |
| ------------------ | ---------------------------------------------------------- |
| Microphone         | Selected capture device. Persists across restarts (FR-012) |
| Transcription tier | Selected from the server-reported catalogue (FR-011)       |

**Validation**

- A tier the user has selected may still be rejected at request time; the catalogue is not the entitlement list (research.md R-006). Rejection MUST be reported as a tier problem, distinguishable from an authentication problem.
- A previously selected microphone that no longer exists MUST NOT prevent startup.

---

## Relationships

```text
Credential ──used by──> transcription request
           └─used by──> correction request

Capture ──produces──> Transcript.raw ──correction──> Transcript.corrected
                                                          │
                                                          v
                                                    prompt (appended, not submitted)

Service configuration ──parameterises──> Capture, transcription request, correction request
```

No entity references another persistently. There is no shared mutable state between captures beyond the single-capture guard.

---

## Notable non-entities

**Session title.** Upstream includes the active session's title in the correction prompt as context. It is read from the host per request and not stored. It is called out here because it is an outbound data flow that is not obvious from reading the entity list: the title of whatever the developer is working on is sent to the correction service alongside the transcript.

**Audio content.** Never held in memory as an entity. It goes from the recorder to a file to a multipart request body, and is deleted. It is not buffered, not accumulated, and not inspectable.
