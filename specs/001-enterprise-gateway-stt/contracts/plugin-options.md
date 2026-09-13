# Contract: Plugin options

**Feature**: 001-enterprise-gateway-stt

Static configuration passed as the second argument to the plugin's `tui` export, supplied by the host as `plugin: [[spec, { ...options }]]`.

Satisfies FR-008 and FR-009.

## Environment values

FR-009 requires that tracked configuration contain no tenant identifiers and no gateway hostnames. **The plugin implements nothing to achieve this.** The editor already substitutes `{env:NAME}` into configuration values before the plugin is handed its options, including values nested inside objects, so the user writes:

```jsonc
"sttApiEndpoint": "{env:OPENCODE_VOICE_STT_BASEURL}"
```

and the plugin receives an ordinary URL string. Measured, not assumed: research.md R-008 records the probe.

Consequently there are **no `*Env` options for URLs**. An earlier revision of this contract defined a paired-option convention with a precedence rule and a warning when both forms were supplied; it was removed as a duplicate of a working host mechanism, which FR-009 now explicitly forbids.

**`apiKeyEnv` is the sole survivor of that pattern, and is not an inconsistency.** Substitution happens once, when configuration is loaded. The credential rotates every 24 hours, so a substituted credential would be frozen for the life of the editor process — exactly the failure FR-005 exists to prevent. `apiKeyEnv` therefore names a variable to be read on every request, rather than supplying a value once. The rule is: values that are static for the session are substituted by the host; values that change under the session are named and read.

## Options

### Transcription

| Option              | Type     | Default          | Meaning                                                                                                       |
| ------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `sttApiEndpoint`    | string   | `endpoint`       | Base URL of the transcription service. Requests go to `${base}/audio/transcriptions` and `${base}/models`     |
| `sttApiModel`       | string   | `gpt-transcribe` | Transcription tier. Overridable at runtime via `api.kv`                                                       |
| `sttVocabulary`     | string[] | `[]`             | Terms biased into recognition. Applied as the request's prompt parameter                                      |
| `sttApiInstruction` | string   | `""`             | Style instruction composed ahead of the vocabulary in the same prompt parameter. Honoured only by some models |
| `sttTimeoutMs`      | number   | `15000`          | Bound on a transcription request (FR-018)                                                                     |

When no transcription endpoint resolves, the plugin falls back to upstream's on-device path. On this machine that path is unavailable, and the resulting error must say so rather than reporting a missing model file.

### Correction

| Option         | Type   | Default          | Meaning                                                                       |
| -------------- | ------ | ---------------- | ----------------------------------------------------------------------------- |
| `endpoint`     | string | `sttApiEndpoint` | Base URL of the correction service. Requests go to `${base}/chat/completions` |
| `model`        | string | `gpt-4.1`        | Correction model (research.md R-004)                                          |
| `maxTokens`    | number | `400`            | Ceiling on correction output                                                  |
| `temperature`  | number | `0.2`            | Low, because correction is not a creative task. See the note below            |
| `llmTimeoutMs` | number | `15000`          | Bound on a correction request (FR-018)                                        |

**On `temperature` being 0.2 rather than 0.** R-004 held temperature at 0.2 while
comparing models, so 0.2 is a benchmark condition in that study and not a result
of it. Measured separately, 8 runs per setting across two hard transcripts, 0 and
0.2 are indistinguishable: identical trap-term accuracy, latency within noise,
and identical non-determinism — each produced two distinct outputs in 8 runs,
because batched inference on a shared gateway is not reproducible at any
temperature. `0` is therefore not preferable, and defaulting to it would imply a
reproducibility guarantee the service does not offer. The variation observed was
paraphrase, not invention, which is the failure mode SC-003 is written against.

**Each of `endpoint` and `sttApiEndpoint` defaults to the other**, so supplying either one alone yields a working configuration — FR-008. Supplying both, with different values, is supported and is the case where transcription and correction live on separate services. Supplying neither is a validation error naming both options.

Neither may be defaulted from the agent's own provider configuration, which points at a host that rejects this request shape (research.md R-002). Independence from the agent's service is the part of FR-008 that is load-bearing; independence of these two from each other is available but is not required to reach a working state, which is what the mutual default expresses.

### Credentials

| Option                   | Type     | Default                             | Meaning                                     |
| ------------------------ | -------- | ----------------------------------- | ------------------------------------------- |
| `credentialStorePath`    | string   | `~/.local/share/opencode/auth.json` | Editor credential store. `~` expanded       |
| `credentialStoreKeyPath` | string[] | `["anthropic", "key"]`              | Property path to the token within the store |
| `apiKeyEnv`              | string   | none                                | Fallback environment variable name (FR-006) |

Defaults point at the editor's own store, so the working configuration for this deployment supplies no credential options at all.

### Capture

| Option        | Type    | Default      | Meaning                                                     |
| ------------- | ------- | ------------ | ----------------------------------------------------------- |
| `mic`         | string  | host default | Initial capture device. Overridable at runtime via `api.kv` |
| `trimSilence` | boolean | `true`       | Trim leading silence from captures                          |

**There is no option for the capture directory.** The guarantee FR-014 asks for — audio unreadable by other accounts and removed after the transcription attempt — is cheap and is kept. Making the location configurable is what costs: path expansion, create-if-absent, permission-check-if-present, and validation, all to let the user choose something they have no reason to choose. Capture instead uses a per-run directory created beneath the OS temporary directory with owner-only permissions. This is also strictly more correct than upstream's fixed path, because it removes the collision between the held-key capture and the second capture path feature 002 introduces.

### Prompt overrides

| Option      | Type   | Meaning                                                                      |
| ----------- | ------ | ---------------------------------------------------------------------------- |
| `sttPrompt` | string | Path to a file replacing the built-in correction system prompt. `~` expanded |

Retained from upstream unchanged. This is an existing read-only file access predating this feature.

## Runtime settings

Held in `api.kv`, persisted by the host across restarts. Not configurable through options because they are per-machine choices the user makes interactively.

| Key                         | Meaning                 | Requirement |
| --------------------------- | ----------------------- | ----------- |
| Selected microphone         | Overrides `mic`         | FR-012      |
| Selected transcription tier | Overrides `sttApiModel` | FR-011      |

A persisted microphone that no longer exists MUST NOT prevent startup — the plugin falls back to the host default and reports the substitution.

## Validation

Validated once at initialisation. A malformed option MUST produce a message naming the option, not a stack trace.

- Timeouts: positive integers.
- `temperature`: 0 to 2.
- Endpoints: after the mutual default is applied, the effective value MUST parse as an absolute URL. Neither supplied is an error naming both options.
- `credentialStoreKeyPath`: non-empty array of strings.

An empty string resulting from a `{env:NAME}` reference to an unset variable MUST be reported as an unset environment variable naming `NAME`, not as a malformed URL. The host substitutes the empty string for a missing variable, so this is the most likely misconfiguration and the least self-explanatory.

## Reference configuration

Placed in the host's `tui.jsonc`. Contains no hostnames, no tenant identifiers, no credentials:

```jsonc
{
  "plugin": [
    "./herdr-tui-session.js",
    [
      "/home/logan/opencode-voice",
      {
        "sttApiEndpoint": "{env:OPENCODE_VOICE_STT_BASEURL}",
        "sttApiModel": "gpt-transcribe",
        "model": "gpt-4.1",
        "sttVocabulary": ["opencode", "oxlint", "oxfmt", "WSL", "PulseAudio"],
      },
    ],
  ],
}
```

One endpoint is named, and the correction endpoint defaults from it. The environment variable is set in the developer's gitignored shell environment file, and the editor resolves the `{env:...}` reference before the plugin sees it. Credential options are omitted so the defaults apply, which means the token is read from the editor's own store on every request.
