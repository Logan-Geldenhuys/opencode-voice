# Feature Specification: Enterprise Gateway Speech-to-Text

**Feature Branch**: `001-enterprise-gateway-stt`

**Created**: 2026-09-06

**Status**: Draft

**Input**: User description: "Set up the opencode-voice fork to work with opencode on WSL using the enterprise AI gateway for transcription, reusing the identity credential that opencode already holds."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Dictate a prompt instead of typing it (Priority: P1)

A developer working in the opencode TUI holds a key, speaks a request that contains code identifiers and file paths, and releases. Within a few seconds the spoken request appears as editable text in the prompt box. They read it, fix anything that is wrong, and press enter to send it.

**Why this priority**: This is the entire point of the feature. Every other story exists to make this one dependable. On its own it is a complete, useful product: hands-free composition of long technical prompts, which are slow and error-prone to type.

**Independent Test**: Hold the record key, say a sentence containing a file path and a technical term, release, and confirm the correct text appears in the prompt box without being sent.

**Acceptance Scenarios**:

1. **Given** the plugin is configured and the microphone is available, **When** the user holds the record key, speaks, and releases, **Then** the spoken text appears in the prompt box as editable text and is **not** submitted to the agent.
2. **Given** a transcript contains spoken technical terms such as a slash-separated file path or a spelled-out identifier, **When** the transcript is inserted, **Then** those terms appear in their written technical form rather than their literal spoken form.
3. **Given** the user has already typed text in the prompt box, **When** a dictation completes, **Then** the existing text is preserved and the dictated text is added to it rather than replacing it.
4. **Given** the user releases the record key having said nothing, **When** processing completes, **Then** the prompt box is left unchanged and the user is told nothing was captured.

---

### User Story 2 - Credentials work without manual maintenance (Priority: P2)

The developer's access credential is issued by corporate single sign-on and is replaced regularly. They re-authenticate as part of normal work. Voice dictation continues to work afterwards without them copying a credential anywhere, editing a configuration file, or restarting the editor.

**Why this priority**: Without this the feature works on day one and silently breaks by day two. It is the difference between a usable tool and a demo. It is P2 only because P1 can be demonstrated first with a freshly issued credential.

**Independent Test**: Dictate successfully, re-authenticate so a new credential is issued, then dictate again in the same editor session without restarting anything and confirm it still works.

**Acceptance Scenarios**:

1. **Given** the developer re-authenticates and a new credential is issued, **When** they dictate in an editor session that started before the re-authentication, **Then** dictation succeeds using the new credential.
2. **Given** the credential has expired and has not been renewed, **When** the user attempts to dictate, **Then** they are told that authentication failed and what action to take, rather than seeing a raw error.
3. **Given** the credential store is unreadable or absent, **When** the user attempts to dictate, **Then** the system uses the configured fallback credential source if one is available, and otherwise reports clearly that no credential could be found.

---

### User Story 3 - Diagnose and configure audio on a virtualised Linux desktop (Priority: P3)

The developer runs Linux under a Windows virtualisation layer, where microphone access is routed through a host audio bridge that can be absent or stale. When dictation cannot capture audio, they get a message that names the actual cause and the corrective action, and they can pick which microphone to use and which transcription quality tier to apply.

**Why this priority**: Audio on this platform fails in ways that produce silent or empty recordings rather than obvious errors. Without diagnostics the failure mode is "it just doesn't work". It is P3 because on a healthy machine it is never exercised.

**Independent Test**: Stop the host audio bridge, attempt to dictate, and confirm the resulting message identifies the audio bridge as the cause and states the remedy.

**Acceptance Scenarios**:

1. **Given** the host audio bridge is not reachable, **When** the user attempts to dictate, **Then** the error message identifies the audio subsystem as the cause and states the corrective action.
2. **Given** multiple microphones are present, **When** the user opens the microphone selector, **Then** all available capture devices are listed and the chosen one persists across editor restarts.
3. **Given** the transcription service offers several quality tiers, **When** the user opens the transcription model selector, **Then** every tier the service actually offers is listed, not an arbitrary subset.

---

### Edge Cases

- **Credential rotates mid-request**: a dictation is in flight when the credential expires. The request fails; the user is told authentication failed and the next attempt picks up the renewed credential without a restart.
- **Recording with no speech**: the user triggers and releases the record key immediately, or the microphone is muted. The result is an empty or near-empty audio capture; the system must not send an empty request nor insert empty text.
- **Transcription service rejects the requested quality tier**: entitlement to a given tier can be withdrawn independently of it being advertised. The failure must name the tier and be distinguishable from an authentication failure.
- **Two dictations overlap**: the user triggers a second recording while the first is still being transcribed. Exactly one recording may be active; the second trigger must be rejected or queued, never allowed to corrupt the first.
- **Network stalls**: the transcription request neither succeeds nor fails promptly. It must time out and surface an error rather than leaving the user watching an indicator forever.
- **Editor exits while recording**: capture must stop and temporary audio must be removed rather than left running or left on disk.
- **Microphone disappears mid-recording**: a device unplugged during capture must produce a clear failure rather than a hang.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST let the user start and stop an audio capture from within the editor using a single held key, and MUST transcribe what was captured when the key is released.
- **FR-002**: The system MUST insert the resulting transcript into the prompt as editable text and MUST NOT submit it to the agent automatically. Review before sending is the required default because a misheard instruction sent to an agent with file-modifying tools is materially harder to undo than a mistyped one.
- **FR-003**: The system MUST append to any text already in the prompt rather than replacing it, so dictation can be mixed with typing.
- **FR-004**: The system MUST resolve the access credential from the credential store that the editor itself already maintains, so that the developer has exactly one place to authenticate.
- **FR-005**: The system MUST read the credential at the moment of each request rather than caching it for the lifetime of the editor process, so that a credential renewed after the editor started is picked up without a restart. This is the specific failure this requirement exists to prevent: the previously used configuration file had drifted months out of date from the live credential while appearing correct.
- **FR-006**: The system MUST support a configurable fallback credential source for environments where the editor credential store is not present, and MUST report clearly when no credential can be resolved from any source.
- **FR-007**: The system MUST NOT write credential material to logs, to disk, or to any destination other than the authorization header of the configured service request.
- **FR-008**: The system MUST allow the transcription service and the text-correction service to be configured independently of the agent's own service, because the agent's service does not accept the same request format. Where transcription and correction are hosted at the same location, configuring one location MUST be sufficient: independent configuration MUST remain possible but MUST NOT be required in order to reach a working state.
- **FR-009**: The system MUST be configurable such that tracked configuration files contain no environment-specific identifiers, in particular no tenant identifiers and no gateway hostnames, so that configuration can be shared or published without disclosure. Where the editor already provides a mechanism for supplying such values from the environment, the system MUST use it rather than introducing a second one.
- **FR-010**: The system MUST correct spoken renderings of technical language into their written form — spoken file paths, spelled-out identifiers, spoken numbers used as line references, and words that are homophones of programming terms — before the transcript is presented for review.
- **FR-011**: The system MUST NOT hide transcription quality tiers from the selector by filtering the service's catalogue against a hardcoded name pattern. The current behaviour does exactly this and conceals valid options, including the fastest available tier. Because the catalogue a service reports can be far larger than the set the user is entitled to use, the selector MUST make the tiers known to work immediately reachable, and MUST keep the remainder reachable rather than removing them.
- **FR-012**: The system MUST let the user select a capture device from those available and MUST persist that choice across editor restarts.
- **FR-013**: When audio capture fails, the system MUST report the specific cause — no device, audio service unreachable, permission denied — together with the corrective action, rather than a generic failure.
- **FR-014**: The system MUST delete captured audio once transcription completes or fails, and MUST NOT leave recordings readable by other users of the machine while they exist.
- **FR-015**: The system MUST stop any active capture and remove temporary audio when the editor exits, including when it exits abnormally.
- **FR-016**: The system MUST terminate only capture processes it started itself. The current behaviour matches processes by command-line pattern and can terminate unrelated processes belonging to the same user.
- **FR-017**: The system MUST permit at most one capture at a time and MUST handle a second trigger deterministically rather than allowing concurrent captures to interfere.
- **FR-018**: The system MUST bound the time it waits for the transcription and correction services and MUST surface a timeout as a distinct, actionable error.

### Key Entities

- **Credential**: the developer's corporate identity token. Short-lived, renewed regularly, held in the editor's credential store. Its value never leaves the machine except as an authorization header to the configured service.
- **Capture**: one recording, from key press to key release. Has audio content, a lifetime bounded by the transcription attempt, and must not outlive it on disk.
- **Transcript**: the text produced from a capture. Exists in a raw form and a corrected form; the corrected form is what the user reviews.
- **Service configuration**: the locations and quality tiers for transcription and text correction, plus the capture device choice. Split between static configuration and user-adjustable runtime settings that persist across restarts.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A spoken request of roughly six seconds becomes reviewable text in the prompt within 3 seconds of the user releasing the record key, for at least half of attempts, and within 5 seconds for at least 95% of attempts.
- **SC-002**: Over a period spanning at least seven credential renewals, dictation continues to work with zero manual credential steps — no file edits, no copying, no editor restarts attributable to credentials.
- **SC-003**: Across a fixed benchmark of spoken technical phrases containing file paths, spelled-out identifiers, spoken line numbers and programming homophones, at least 90% of the target terms appear in correct written form, and no term is replaced with a plausible-but-wrong identifier that a reader would not notice.
- **SC-004**: Credential material appears zero times in application logs, in temporary files, and in any request to any destination other than the configured service.
- **SC-005**: For each of the identified audio failure modes — no capture device, audio service unreachable, device removed mid-capture — the user receives a message naming the cause and the corrective action, in 100% of occurrences.
- **SC-006**: After a dictation session ends, zero captured audio files remain on disk.
- **SC-007**: Zero transcription tiers are excluded from the selector by client-side name filtering. Every tier measured to work is reachable within one keystroke of opening the selector, and every other tier the service reports is reachable without leaving it.
- **SC-008**: No transcription or correction request remains outstanding for longer than its configured bound; every request either returns or surfaces a timeout.

## Assumptions

- The developer works on a single machine running Linux under Windows virtualisation, with microphone access routed through the host audio bridge.
- Sending captured audio and prompt text to the corporate AI gateway is acceptable, on the basis that the same gateway already receives all prompts and file content the agent handles. Audio is not treated as more sensitive than the text it becomes.
- The corporate gateway remains reachable and the developer's entitlement to transcription is stable. Entitlement to any specific quality tier is not assumed and is discovered at runtime.
- The editor's credential store remains the single source of truth for authentication and continues to be renewed by the developer's normal sign-in flow.
- Transcription is performed by a remote service. On-device transcription is out of scope for this feature: the target machine has no discrete graphics acceleration, so an on-device model would be both slower and less accurate than the remote service.
- Text correction of transcripts is performed by a remote language model, and the small additional latency it costs is worth the accuracy gain on technical vocabulary.
- The developer reviews dictated text before sending it. Automatic submission is deliberately excluded from this feature.
- Only one person uses the machine, but the machine is not assumed to be private: temporary audio is treated as sensitive and is not left readable to other accounts.
