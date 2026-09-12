[![CI](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)

# opencode-voice

Speech-to-text and text-to-speech plugin for [OpenCode](https://opencode.ai/).

Record voice prompts with local whisper transcription, hear assistant responses
spoken aloud via Piper TTS. Both directions use an LLM to normalize text for
natural speech (fixing homophones, splitting camelCase identifiers, summarizing
code-heavy responses, etc.).

There is also a hands-free mode: leave it listening, think aloud across as many
pauses as you like, and say a wake phrase to send everything you have said to
the agent. See [Continuous listening](#continuous-listening-optional).

## Install

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't
exist). You must configure at least `endpoint` and `model`:

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r` for voice
> recording, but OpenCode assigns it to session rename by default. Session
> rename is not used frequently and is still accessible via `/rename`, so we
> clobber the factory default to let the plugin use `ctrl+r` properly. See
> the `keybinds` section in the config below.

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "session_rename": "none"
  },
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

### Refresh cached plugin after updates

If OpenCode keeps using an older published version of the plugin after an
update, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/@renjfk/
```

## Prerequisites

### Speech-to-text

The plugin uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via a
`whisper-cli` binary and `sox` for microphone capture. Follow the subsection
for your OS to install the binary and verify your microphone, then run the
shared **Download model & smoke test** step at the end.

#### macOS

Install the `whisper-cpp` bottle (ships a `whisper-cli` with Metal enabled on
Apple Silicon) and `sox`:

```bash
brew install whisper-cpp sox
```

Verify your microphone by recording a 3-second clip and playing it back. The
first `sox -d` invocation triggers a macOS microphone permission prompt —
grant it in **System Settings → Privacy & Security → Microphone**, then rerun.
Remove the temp file once you've heard yourself clearly:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

#### Linux (including WSL2)

Install `sox` with its PulseAudio driver (a separate package on Debian/Ubuntu),
the PulseAudio tools so the plugin can enumerate input devices via `pactl`,
and the build tools for whisper.cpp:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils build-essential cmake
```

On WSL2, make sure [WSLg](https://learn.microsoft.com/windows/wsl/tutorials/gui-apps)
is running — it bridges the Windows microphone into WSL as a PulseAudio source
(typically named `RDPSource`), which you can then pick with `/stt-mic`.

**WSL2 audio troubleshooting.** There is no `/dev/snd` in WSL2 — that is
normal. Audio goes through WSLg's PulseAudio server at `/mnt/wslg/PulseServer`,
so ALSA-only tools like `arecord -l` will never list a device. If `/stt-mic`
finds no devices or `pactl info` fails with `Connection refused`, WSLg's
PulseAudio is stuck; fix it from Windows PowerShell:

```powershell
wsl --shutdown   # then reopen Ubuntu (closes all WSL sessions)
```

If the source list is still empty after a restart, check Windows
**Settings → Privacy & security → Microphone** and enable both "Microphone
access" and "Let desktop apps access your microphone" (WSLg captures audio via
a desktop RDP client), then run `wsl --update` for the latest WSLg.

**A microphone that records silence without erroring.** WSLg loads
`module-rdp-sink` and `module-rdp-source` at boot, and the source can go
missing while the sink stays put. `pactl info` still succeeds, so the server
looks healthy, and recording succeeds too — sox captures digital silence and
exits 0. Nothing reports a failure; transcripts just come back empty or
invented. There are two shapes:

```console
$ pactl info | grep 'Default Source'
Default Source: RDPSource        # names a source that pactl list sources does not show
Default Source: RDPSink.monitor  # exists, but loops back output instead of a microphone
```

Both commands refuse to record when they see this, naming which shape it is.
To repair it in place, without closing your WSL sessions:

```bash
pactl load-module module-rdp-source source_name=RDPSource
pactl set-default-source RDPSource
```

Loading the module is not enough on its own when the default has already been
reassigned to a monitor, which is why the default is claimed back explicitly.
To confirm the device is live rather than merely present, record a couple of
seconds and read the level — a silent room peaks near 0.1%, speech near 50%:

```bash
sox -t pulseaudio default -r 16000 -c 1 -b 16 /tmp/mic.wav trim 0 2
sox /tmp/mic.wav -n stat 2>&1 | grep 'Maximum amplitude'
```

Since this recurs at boot, it is worth making the repair automatic. WSLg's
PulseAudio runs in the WSLg VM rather than in your distro, so there is no local
daemon to configure and no `default.pa` to edit — the module has to be loaded by
a client. A `systemd --user` oneshot that runs the two commands above, guarded
so it does nothing when a real capture source is already the default, covers it
once per boot with no per-shell cost.

Verify your microphone by recording a 3-second clip and playing it back.
Remove the temp file once you've heard yourself clearly; skip building
whisper.cpp until this works, otherwise `/stt-mic` will have nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

`whisper-cli` is not packaged for Linux, so build whisper.cpp from source.
Pick **one** of the two builds below.

**CPU build** — works on any machine, adequate for `tiny`/`base`/`small`
models:

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

**CUDA build** — NVIDIA GPU, ~100× faster encode for `medium`/`large` models.
Check your GPU with `nvidia-smi` and your toolkit with `nvcc --version`, then
pick the arch code from the table:

| GPU family    | Arch      | `CMAKE_CUDA_ARCHITECTURES` | Min. CUDA |
| ------------- | --------- | -------------------------- | --------- |
| RTX 20 / T4   | Turing    | `75`                       | 10.0      |
| RTX 30 / A100 | Ampere    | `86`                       | 11.0      |
| RTX 40 / L40  | Ada       | `89`                       | 11.8      |
| H100          | Hopper    | `90`                       | 12.0      |
| RTX 50 / B100 | Blackwell | `120`                      | 13.0      |

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

If you have multiple CUDA toolkits installed (e.g. Blackwell requires CUDA 13
while the default `nvcc` is 12), also pass `-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc`
to point at the matching `nvcc`. CUDA runtime libraries are resolved via
ldconfig; no `LD_LIBRARY_PATH` is needed.

At runtime the plugin records through sox's `pulseaudio` driver when `pactl`
is available, and falls back to sox's default device otherwise.

#### Download model & smoke test

Download a whisper model to `~/.local/share/whisper-cpp/` (same path on both
OSes):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Smoke-test the install by transcribing a short recording:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
whisper-cli -m ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  -f /tmp/smoke.wav -l auto -nt
rm /tmp/smoke.wav
```

Check the first `system_info:` line in the output to confirm the expected
backend is active:

| Install                        | Expect                  |
| ------------------------------ | ----------------------- |
| macOS Homebrew (Apple Silicon) | `METAL = 1`             |
| Linux CUDA build               | `CUDA : ARCHS = <n>`    |
| CPU-only                       | `METAL = 0` / no `CUDA` |

Reference `encode time` on a 4-second clip: CPU `medium` ≈ 15–30 s; CUDA
`medium` ≈ 100–200 ms; CUDA `large-v3-turbo` ≈ 100–300 ms. Apple Silicon
Metal timings are hardware-dependent but typically sub-second. If your GPU
build shows CPU-level timings, the GPU backend failed to load — on Linux,
re-check `nvidia-smi` and rebuild with the arch code from the table above.

### Text-to-speech

Install [Piper](https://github.com/rhasspy/piper):

```bash
uv tool install piper-tts
```

Or with pip:

```bash
pip install piper-tts
```

The plugin looks for `piper` on your `PATH` (`~/.local/bin` is typically on `PATH`).

Download a voice model to `~/.local/share/piper-voices/`:

```bash
mkdir -p ~/.local/share/piper-voices
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx
curl -L -o ~/.local/share/piper-voices/en_US-ryan-high.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

### LLM endpoint

An OpenAI-compatible LLM endpoint is required for text normalization. For
speech-to-text it cleans up whisper output (punctuation, filler words, software
engineering homophones). For text-to-speech it converts markdown into natural
spoken text.

Configure your endpoint in `tui.json` via plugin options. Any OpenAI-compatible
endpoint works (Anthropic, OpenAI, Ollama, vLLM, LM Studio, etc.). The `apiKeyEnv`
option is optional - omit it for unauthenticated endpoints like Ollama.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

For unauthenticated local endpoints (e.g. Ollama):

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "http://localhost:11434/v1",
        "model": "llama3.2"
      }
    ]
  ]
}
```

- `endpoint` _(required unless `sttApiEndpoint` is set)_ - OpenAI-compatible base URL. Defaults to `sttApiEndpoint` when omitted, so a single gateway serving both services only needs one of the two
- `model` _(optional)_ - model name sent to `/chat/completions` (default: `gpt-4.1`)
- `apiKeyEnv` _(optional)_ - environment variable holding the API key. See [Credentials](#credentials)
- `maxTokens` _(optional)_ - maximum completion tokens for normalization calls (default: `400`)
- `temperature` _(optional)_ - sampling temperature for normalization calls, `0` to `2` (default: `0.2`). Set to `null` to omit the parameter entirely for services that reject it
- `llmTimeoutMs` _(optional)_ - bound on a single normalization request (default: `15000`). A timeout is not retried
- `reasoningEffort` _(optional)_ - reasoning level for models that support it
- `chatTemplateKwargs` _(optional)_ - extra keyword arguments passed to the model's chat template (e.g. `{"enable_thinking": false}` for Qwen models to disable chain-of-thought)
- `retries` _(optional)_ - number of retry attempts for transient LLM failures
- `sttLanguage` _(optional)_ - spoken language passed to local `whisper-cli -l` (default `auto`; any whisper.cpp language code, e.g. `en`, `zh`). Can be changed at runtime via `/stt-language`
- `trimSilence` _(optional)_ - whether to remove leading silence from recordings (default `true`). Set to `false` if your recordings are missing the first word or syllable

Any string option may use OpenCode's `{env:NAME}` form, which the editor
substitutes before the plugin sees it:

```json
{ "sttApiEndpoint": "{env:MY_GATEWAY_URL}" }
```

Recordings are written to a per-session directory created under the system
temporary directory with owner-only permissions. There is no option for it:
each recording is deleted as soon as it has been transcribed, whether that
succeeded or failed, and the directory is removed when the editor exits.

### Logging

The plugin writes diagnostics through OpenCode's structured app logger. If this plugin is not working with your setup, check the OpenCode log file and, optionally, enable debug mode. See the [OpenCode Docs](https://opencode.ai/docs/troubleshooting/#logs) for details.

Routine plugin diagnostics use `debug`; recoverable issues use `warn`; failed
child processes, API calls, or unexpected exceptions use `error`.

### STT API transcription (optional)

Instead of local `whisper-cli`, you can use an OpenAI-compatible speech-to-text
API (e.g. serving a Whisper model). This is useful when you want to run the
plugin on a machine without whisper-cpp installed.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttApiEndpoint": "http://127.0.0.1:8000/v1",
        "sttApiModel": "gpt-transcribe",
        "sttVocabulary": ["opencode", "kubectl", "oxlint"],
        "apiKeyEnv": "MY_STT_API_KEY"
      }
    ]
  ]
}
```

- `sttApiEndpoint` _(optional)_ - OpenAI-compatible base URL with `/audio/transcriptions` support. Defaults to `endpoint` when omitted
- `sttApiModel` _(optional)_ - transcription tier to pass to the API (default: `gpt-transcribe`). Can be changed at runtime via `/stt-model`, which lists what the endpoint's `/models` listing advertises. Tiers that have been measured for both latency and accuracy are grouped first, fastest first; everything else the service offers follows in a second group
- `sttVocabulary` _(optional)_ - array of terms to bias transcription toward, e.g. project names, tool names, or identifiers the service otherwise mishears (default: none). Passed as the transcription request's `prompt` parameter
- `sttTimeoutMs` _(optional)_ - bound on a single transcription request (default: `15000`)
- `apiKeyEnv` _(optional)_ - environment variable holding the API key. See [Credentials](#credentials)

Earlier releases named these `sttEndpoint`, `sttModel` and `sttApiKeyEnv`. The
first two were renamed so the `sttApi*` prefix marks the options that belong to
the transcription service; the third was folded into `apiKeyEnv`, since one
gateway serving both services needs one credential.

OpenRouter note: when `sttApiEndpoint` points at `https://openrouter.ai/api/v1`, the plugin automatically uses OpenRouter's JSON/base64 transcription request format instead of multipart upload. Vocabulary biasing does not apply on that path, which takes a different request shape.

### Credentials

The plugin reads a credential for every request rather than caching one at
startup, so a token that is renewed mid-session is picked up without restarting
the editor. Two sources are tried in order:

1. `credentialStorePath` - a JSON file, read at `credentialStoreKeyPath`.
   Defaults to `~/.local/share/opencode/auth.json` at `["anthropic", "key"]`,
   which is where OpenCode writes the token it renews when you log in.
2. `apiKeyEnv` - the name of an environment variable holding the token.

The store is tried first because it is the copy the editor keeps current; an
environment variable exported once at shell startup can be days stale.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttApiEndpoint": "{env:MY_GATEWAY_URL}",
        "credentialStorePath": "~/.local/share/opencode/auth.json",
        "credentialStoreKeyPath": ["anthropic", "key"]
      }
    ]
  ]
}
```

- `credentialStorePath` _(optional)_ - JSON file holding the token; `~` is expanded
- `credentialStoreKeyPath` _(optional)_ - array of keys locating the token inside that file
- `apiKeyEnv` _(optional)_ - fallback environment variable name

Neither source is required. An endpoint that needs no credential, such as a
local Ollama or vLLM server, works with both left unset.

When no source yields a token, the plugin reports each source it tried and why
it failed, rather than a generic authentication error:

```
No credential found.
  ~/.local/share/opencode/auth.json — file not found
  $ANTHROPIC_API_KEY — not set
Log in to opencode, or set apiKeyEnv to a variable that holds a token.
```

A credential that resolves but is refused by the service reads differently, and
distinguishes a token to renew (401) from a model the account may not use (403).

### Continuous listening (optional)

Held-key dictation records while you hold a key. Continuous listening is the
other shape: it stays on, transcribes whatever you say, and holds the result in
a buffer until you speak a wake phrase. The phrase is what sends the buffer to
the agent, so you can think aloud across as many pauses as you like and then
commit in one breath.

The phrase can fall anywhere in the sentence. "Hey nome execute, fix the
failing test" and "fix the failing test, hey nome execute" both send the whole
thing, so you never have to remember whether it goes first or last.

The phrase stays where you said it. It is not cut out, because it is how you
address the agent directly, and that is the only thing separating an
instruction from the thinking-aloud around it: "the parser is probably fine,
hey nome execute, fix the failing test" is one prompt in which only the second
half is a request. `listenTranscriptLabel` tells the agent it is called Nome and that
speech marked with its name is the instruction, so the retained phrase reads as
an address rather than as a stray word.

It needs `sttApiEndpoint`; the segments are short and frequent, and local
`whisper-cli` is not fast enough to keep up on CPU.

Everything in this section belongs to continuous listening alone. Wake phrases,
the transcript label, the agent's name and the segmentation options exist only
here; held-key dictation has no wake phrase to match and no reason to tell the
agent anything about how the words arrived, so it stays plain transcription
followed by the correction pass described under [LLM endpoint](#llm-endpoint).
Pause sensitivity does not carry over either: dictation stops when you release
the key, so it trims leading silence and nothing more.

What the two modes do share is the transcription service itself -
`sttApiEndpoint`, `sttApiModel`, `sttVocabulary` and the credential. Keep
`sttVocabulary` to terms that help both; biasing it toward a wake word would
skew every dictated sentence toward a word only one mode cares about.

```jsonc
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttApiEndpoint": "{env:MY_GATEWAY_URL}",
        "listenSilenceDurationMs": 700,
        "listenSilenceThreshold": "2%",
        "listenMinSegmentMs": 400,
        "listenAutoSubmit": true,
        "listenWakePhrases": [
          {
            "canonical": "opencode execute",
            "variants": ["open code execute"],
            "action": "submit",
          },
          {
            "canonical": "opencode stop and execute",
            "variants": ["open code stop and execute", "opencode stop execute"],
            "action": "interrupt_submit",
          },
          {
            "canonical": "hey nome execute",
            "variants": ["hey node execute", "hey norm execute", "hey nom execute"],
            "action": "submit",
          },
        ],
      },
    ],
  ],
}
```

Segmentation:

- `listenSilenceDurationMs` _(optional)_ - how long a pause ends an utterance (default: `700`)
- `listenSilenceThreshold` _(optional)_ - what counts as silence, in sox's own notation (default: `"0.5%"`). Passed to the recorder unchanged and deliberately not validated by the plugin
- `listenMinSegmentMs` _(optional)_ - captures shorter than this are discarded without a transcription request (default: `400`). This is the cost gate: a cough should not become a billed request
- `listenMaxSegmentMs` _(optional)_ - upper bound on a single utterance, after which the recorder is stopped normally (default: `30000`)

Buffer:

- `listenMaxBufferAgeMs` _(optional)_ - speech older than this is dropped (default: `3600000`, one hour)
- `listenMaxBufferChars` _(optional)_ - size bound on the buffer (default: `64000`, roughly an hour of speech). When exceeded, whole utterances are evicted oldest first; an utterance is never truncated

The two bounds describe the same envelope from different directions: the size
bound is what fires when you have been talking, the age bound is what fires when
you have not. Neither is a staleness policy - if you have been away from the
desk, `/listen-discard` is the honest answer.

Wake phrases and submission:

- `listenWakePhrases` _(optional)_ - array of `{canonical, variants, action}`, where `action` is `"submit"` or `"interrupt_submit"`. A phrase must be at least two words, and two phrases may not compile to the same words with different actions. When two phrases share a prefix, the longer one wins
- `listenTranscriptLabel` _(optional)_ - text prefixed to every submission, warning the agent that what follows is a voice transcript and telling it the name the developer addresses it by
- `listenAutoSubmit` _(optional)_ - whether the wake phrase submits the prompt or just fills it (default: `true`). With `false`, the buffer still advances and the interrupt phrase still stops the agent; only the final send is left to you. Useful for the first session

#### Choosing a phrase

Length is the whole of the safety margin, and it is what lets an unreliable word
sit inside a reliable phrase. "Nome" is not a word, so the recogniser invents
something different for it from speaker to speaker and even from utterance to
utterance: on one microphone it came back as "node", "norm", "nom", "gnome" and
"no me". No variant list for a two-word phrase can be complete.

So the name is bracketed rather than pinned down. "Hey" and "execute" transcribe
reliably, and only the middle varies, which means a rendering you have not seen
yet is one safe line to add. Measured against eighteen plausible utterances
mentioning node, norm or execute:

| phrase                              | fires when you say it | fires when you did not |
| ----------------------------------- | --------------------- | ---------------------- |
| `hey nome`, accepting `hey node`    | 5 of 6 renderings     | 5 of 18                |
| the same, also accepting `hey norm` | 6 of 6                | 6 of 18                |
| `hey nome execute`                  | 6 of 6                | 0 of 18                |

The two-word phrase is bad in both directions at once. Accepting `hey node`
fires on "hey node is crashing on startup" and still misses "Hey Norm";
accepting `hey norm` too catches that and adds "hey norm reviewed the pull
request". Lengthening the phrase fixed both at no cost to how fast it is to say

- at five syllables `hey nome execute` is shorter than `opencode execute`.

Homophones that are ordinary English stay out of the variants even in the long
form, because they are not renderings the recogniser actually produces:

```
"so I said hey name the function fetchUser and it worked"
"can you rename this hey known issue"
"hey names are hard"
```

A false negative costs you saying the phrase again. A false positive sends
speech to an agent holding file-modifying tools before you had finished
composing it, and with `listenAutoSubmit` on it does so immediately. Lengthen
the phrase rather than accept a form.

There is no LLM correction pass on continuously captured speech. Correcting each
submission would add latency to every one of them, and a correction model that
is confident and wrong substitutes plausible identifiers for the ones you
actually said. Instead `listenTranscriptLabel` tells the agent it is reading a
transcript, and the agent has the project in front of it to check against -
which the correction pass does not. The same label is what makes the retained
wake phrase legible: it names the agent, and says that speech carrying that
name is the instruction while the rest is context.

#### Tuning pause sensitivity

The defaults were measured on one microphone in one quiet room, so treat them as
a starting point. Both values are per-room by nature: the threshold has to sit
above your noise floor but below the quiet parts of your own speech.

Record a few seconds of silence and a few of normal talking, then compare their
amplitudes:

```bash
sox -t pulseaudio default -r 16000 -c 1 -b 16 noise.wav trim 0 5
sox -t pulseaudio default -r 16000 -c 1 -b 16 speech.wav trim 0 8
sox noise.wav -n stat
sox speech.wav -n stat
```

Speech should be two or three orders of magnitude louder than the room. Pick a
threshold a few times above the room's maximum. Then check where the cuts
actually land, speaking a couple of sentences with natural pauses:

```bash
sox -t pulseaudio default -r 16000 -c 1 -b 16 seg.wav \
    silence 1 0.1 0.5% 1 0.7 0.5% : newfile : restart
soxi -D seg*.wav
```

Each file should be a whole thought. Segments merging is harmless - the buffer
joins them and wake phrases are matched across the whole buffer - so lengthen
`listenSilenceDurationMs` if sentences are being split, rather than shortening it
to force more cuts. The trailing 44-byte file is an artefact of `newfile` and does
not occur in the plugin, which runs one recorder per utterance.

#### Calibrating the wake phrases

Recognition of a two- or three-word phrase varies with voice, microphone and
service. Rather than guess, calibrate once:

1. Start with `"listenAutoSubmit": false` so nothing is sent while you tune
2. Toggle listening on with `/listen-toggle` and speak each phrase ten times, at
   normal speed, quickly, and with a pause in the middle
3. Read the recogniser's actual output from the OpenCode log and add every form
   it produced to that phrase's `variants`
4. Repeat until each phrase triggers the intended action at least nine times out
   of ten, and the interrupt phrase never once behaves as a plain submission
5. Set `"listenAutoSubmit": true`

The output of this procedure is your `variants` lists. Explicit variants fail
predictably and are inspectable; fuzzy matching would trade a known
false-negative rate for an unknown false-positive rate, and a false positive
sends unintended speech to an agent holding file-modifying tools.

### Custom prompts

The LLM system prompts used for normalization can be fully replaced by pointing
to your own prompt files. This lets you fine-tune how transcriptions are cleaned
up or how responses are spoken.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "sttPrompt": "~/.config/opencode/stt-prompt.md",
        "ttsAutoPrompt": "~/.config/opencode/tts-auto-prompt.md",
        "ttsManualPrompt": "~/.config/opencode/tts-manual-prompt.md"
      }
    ]
  ]
}
```

- `sttPrompt` _(optional)_ - system prompt for cleaning up whisper transcriptions
- `ttsAutoPrompt` _(optional)_ - system prompt for auto-speaking assistant responses
- `ttsManualPrompt` _(optional)_ - system prompt for manually reading responses aloud

If a path is not set, the built-in default prompt is used.

## Commands

### Speech-to-text

| Command         | Keybind    | Description                            |
| --------------- | ---------- | -------------------------------------- |
| `/stt-record`   | `ctrl+r`   | Start/stop recording + transcribe      |
| `/stt-submit`   | `leader+r` | Stop recording, transcribe, and submit |
| `/stt-stop`     |            | Cancel recording                       |
| `/stt-model`    |            | Select whisper model                   |
| `/stt-language` |            | Select transcription language          |
| `/stt-mic`      |            | Select microphone                      |

`/stt-mic` lists CoreAudio input devices on macOS, and PulseAudio sources on
Linux (via `pactl`, monitor sources excluded). On systems without a supported
device listing, "System default" uses sox's default device (`sox -d`).

`/stt-language` offers a curated list of common languages (plus auto-detect)
and only affects local `whisper-cli` transcription, not the STT API. Languages
outside the list can be set via the `sttLanguage` plugin option.

### Continuous listening

| Command           | Keybind       | Description                                          |
| ----------------- | ------------- | ---------------------------------------------------- |
| `/listen-toggle`  | `alt+shift+r` | Start or stop continuous listening                   |
| `/listen-status`  |               | Report whether it is listening, and what is buffered |
| `/listen-discard` |               | Throw away the buffer and keep listening             |

Listening is never on at startup, and nothing about it is persisted - reopening
the editor to a live microphone is the failure this avoids.

`/listen-status` reports how long it has been listening, how many utterances are
buffered, their size and the age of the oldest, the configured phrases, and the
buffered text itself. It answers correctly while a transcription is in flight.

The two capture modes are alternatives, not layers. Starting one while the other
holds the microphone is refused, and the refusal names the mode that has it and
the command that stops it.

### Text-to-speech

The `leader` key in OpenCode is `ctrl+x`. So `leader+s` means press `ctrl+x`
then `s`.

| Command      | Keybind    | Description              |
| ------------ | ---------- | ------------------------ |
| `/tts-speak` | `leader+s` | Read last response aloud |
| `/tts-mode`  | `leader+v` | Toggle auto TTS on/off   |
| `/tts-stop`  | `escape`   | Stop playback            |
| `/tts-voice` |            | Select TTS voice         |

## How it works

### STT pipeline

1. `sox` records audio from your microphone (CoreAudio on macOS, PulseAudio on
   Linux when `pactl` is available, sox default device otherwise)
2. `whisper-cli` transcribes locally using a ggml model, or an OpenAI-compatible
   API endpoint if `sttApiEndpoint` is configured
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt, or submitted immediately
   when `/stt-submit` is used. If normalization fails (e.g. LLM endpoint
   unreachable), the raw transcription is used as a fallback so you never lose
   your input

### Continuous listening pipeline

1. `sox` records one utterance, stopping itself when you pause for
   `listenSilenceDurationMs`. The recorder's exit _is_ the segment boundary, so
   nothing has to work out when a segment finished
2. Captures shorter than `listenMinSegmentMs` are discarded without a request.
   The rest are transcribed by the STT API, and the audio is deleted either way
3. The text is appended to the buffer, and the next recorder starts. Only one
   utterance is ever on disk, and only for as long as its request takes
4. After every append, the buffer is searched for a wake phrase. The search runs
   across the whole buffer rather than one utterance, so a phrase split by a
   pause still matches
5. On a match, the whole buffer is sent as one prompt, wake phrase included and
   in the position it was spoken, and the buffer is left empty. The phrase is
   kept because it is what marks the direct instruction; the label tells the
   agent as much. Nothing is sent when the buffer holds nothing but the phrase.
   What is sent is the text exactly as transcribed - the plugin matches on a
   normalised copy but never sends one, so `Server.tsx` arrives as `Server.tsx`

The plain phrase always submits and never stops the agent, whatever the agent
happens to be doing; the interrupt phrase stops it first, and is not an error
when there is nothing to stop. Reading the agent's state to decide would make
the two phrases indistinguishable in the one situation where the distinction
matters.

A single failed transcription is logged and dropped, costing you one utterance.
Three consecutive failures are surfaced, because a session that silently drops
every segment leaves you talking to a microphone that is recording nothing.

### TTS pipeline

1. When the assistant finishes responding (or on manual trigger), the response
   text is sent to the LLM for speech normalization
2. The LLM decides how to handle it: narrate simple answers, summarize
   code-heavy responses, or briefly notify for confirmations
3. Piper synthesizes speech locally, piped through sox for playback

### Auto TTS

When enabled (`/tts-mode`), the plugin automatically speaks:

- Assistant responses when a session goes idle after work
- Permission requests
- Questions that need your answer

## Contributing

opencode-voice is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run check        # lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Test local plugin in OpenCode

To test unpublished changes in the OpenCode TUI, point `~/.config/opencode/tui.json`
at the local repo path, not the npm package name:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/your-user/opencode-voice"]
}
```

### Optional macOS Hammerspoon integration

If you use macOS, [Hammerspoon](https://www.hammerspoon.org/), and
[Ghostty](https://ghostty.org/), see
[`examples/hammerspoon/ghostty-fn.lua`](examples/hammerspoon/ghostty-fn.lua)
for an optional global `Fn` key setup.

Behavior:

- Press `Fn` to send `ctrl+r` and start recording.
- Hold `Fn` for at least 0.5 seconds and release to send `leader+r`, which
  stops recording, normalizes, and submits the prompt.

Notes:

- It assumes OpenCode is using the default leader key, `ctrl+x`.
- It assumes OpenCode is running in Ghostty terminal `1`.
- It is best used as a push-to-talk flow: hold `Fn` while speaking, then
  release to submit.
- Adjust `APP_NAME`, `TARGET_TERMINAL`, and `LONG_PRESS_THRESHOLD_SECONDS` to
  fit your setup.

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
