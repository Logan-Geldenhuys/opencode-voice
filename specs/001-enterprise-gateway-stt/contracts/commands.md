# Contract: Commands and user-facing behaviour

**Feature**: 001-enterprise-gateway-stt

The plugin's interface to the developer. Command names below are logical; the registration mechanism is an implementation choice recorded in the plan, not fixed here.

## Dictation

### Record (held key)

Satisfies FR-001, FR-002, FR-003.

| Aspect                    | Behaviour                                                            |
| ------------------------- | -------------------------------------------------------------------- |
| Trigger                   | Key held. Capture starts on press, stops on release                  |
| While recording           | Recording state is signalled to the user                             |
| On release                | Capture stops, transcription runs, correction runs, text is inserted |
| Insertion                 | **Appended** to existing prompt content. Never replaces it           |
| Submission                | **Never automatic.** The developer reviews and presses enter         |
| Empty capture             | Nothing inserted. User told nothing was captured                     |
| Second trigger while busy | Rejected or queued deterministically. Never concurrent (FR-017)      |

The no-auto-submit rule is the single most important behaviour in this feature. A misheard instruction delivered to an agent holding file-modifying tools is materially harder to undo than a mistyped one. Feature 002 deliberately inverts this for continuous mode, where the wake phrase serves as the confirming act.

### Cancel

Abandons an in-progress capture or transcription. Deletes the audio, inserts nothing.

## Selection

### Select microphone

Satisfies FR-012.

Lists available capture devices. Selection persists across editor restarts. When enumeration fails, the error names the audio subsystem as the cause and states the corrective action rather than presenting an empty list (FR-013).

### Select transcription tier

Satisfies FR-011.

**No client-side name filtering.** The current substring filter hides the fastest tier and leaves only the one that mangles file paths (research.md R-001, R-006). Removing it is the whole of FR-011.

Removing the filter alone would replace one bad selector with another, because the catalogue reported by this service runs to four figures and is mostly other tenants' artefacts. The selector therefore presents two groups:

| Group     | Contents                                                                 |
| --------- | ------------------------------------------------------------------------ |
| Measured  | Tiers observed to work against the configured service, fastest first     |
| Remainder | Everything else the service reports, in the order the service reports it |

Nothing is removed, so SC-007 holds. The developer reaches a working tier without scrolling, and reaches any other tier by typing part of its name, because the host's selection dialog supplies its own filtering (research.md R-006). The plugin groups; the host filters. Building a second filter inside the plugin would recreate the defect this requirement exists to remove.

Because the catalogue is not the entitlement list, a listed tier may still be rejected at request time. That rejection is reported as a tier problem naming the tier, and is distinguishable from an authentication problem.

## Diagnostics

Satisfies FR-013 and supports SC-005.

Reports, without ever revealing credential material:

- Audio backend detected, and whether the host audio bridge actually responds
- Capture devices enumerated
- Selected microphone and tier
- Resolved endpoints
- Which credential source resolved, via `describe()` — never the value
- Whether the capture binary is present

## Error message contract

Every failure below MUST name a cause and a corrective action. A generic failure is a defect, not a degraded experience — this is FR-013 and SC-005.

| Condition                  | Must convey                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| Capture binary absent      | Which binary, and that it must be installed                        |
| Audio bridge unreachable   | The audio subsystem is the cause, plus the remedy                  |
| No capture device          | No device found, and how to check                                  |
| Device removed mid-capture | The device disappeared. Not a hang                                 |
| Credential unresolvable    | Every source tried, in order, and why each failed. Never the value |
| Service rejects credential | Authentication failed, re-authenticate. Distinct from unresolvable |
| Service rejects tier       | Which tier was rejected. Distinct from an authentication failure   |
| Request timed out          | Which request, and that it exceeded its bound (FR-018)             |
| Empty capture              | Nothing was captured. Not an error state                           |

The two credential cases are separated because their remedies differ: one is fixed by re-authenticating, the other by correcting configuration. Collapsing them sends the developer to the wrong place.

The unresolvable case renders the resolver's attempt log directly, one line per source, rather than a single summarising sentence:

```text
No credential found.
  ~/.local/share/opencode/auth.json — file not found
  $ANTHROPIC_API_KEY — not set
Log in to opencode, or set apiKeyEnv to a variable that holds a token.
```

This is the reason the resolver returns a log rather than a classification (contracts/credential-store.md). A developer who has two possible sources needs to know the state of both, not which one the resolver decided to name.

## Lifecycle guarantees

| Event                   | Guarantee                                                                   |
| ----------------------- | --------------------------------------------------------------------------- |
| Transcription succeeds  | Audio file deleted (FR-014)                                                 |
| Transcription fails     | Audio file deleted (FR-014)                                                 |
| Editor exits normally   | Capture terminated, audio removed (FR-015)                                  |
| Editor exits abnormally | Same, via the host disposal hook (FR-015)                                   |
| Termination             | Only the tracked child process. Never a command-line pattern match (FR-016) |

While a capture file exists it is readable only by its owner (FR-014). Audio is written into a directory created once per plugin load, restricted to the owner at creation, beneath the operating system's temporary directory. The location is not configurable: the guarantee is what FR-014 asks for, and a fixed shared path is what makes the guarantee hard to keep once feature 002 adds a second capture path writing concurrently. SC-006 asserts zero files remain after a session.

## Non-goals

Spoken output remains in the codebase but is dormant in this deployment — the developer asked for no text-to-speech. It is not removed, so as to keep the fork's divergence from upstream small.

Continuous listening, wake phrases and agent interruption belong to feature 002 and are not registered by this feature.
