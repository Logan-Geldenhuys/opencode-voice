# Quickstart: Enterprise Gateway Speech-to-Text

**Feature**: 001-enterprise-gateway-stt | **Date**: 2026-09-06

Setup and verification for the target machine: Ubuntu under WSL2, opencode TUI 1.18.21.

**This file is tracked in git.** It therefore contains no gateway hostnames, tenant identifiers, or credentials — every environment-specific value is derived at runtime from what is already configured on the machine. Keep it that way when editing.

---

## 1. Install audio prerequisites

None of these are present initially. This step needs elevated privileges, so **the developer must run it** — an agent cannot. Nothing else in this feature can be verified until it is done, which is why it is step 1 and why the plan records it as a prerequisite gate rather than a task.

```bash
sudo apt-get install -y sox libsox-fmt-pulse pulseaudio-utils
```

`libsox-fmt-pulse` is not optional. Without it `sox` cannot use the PulseAudio backend, which is the only route to the microphone under WSLg, and it fails in a way that looks like a missing device rather than a missing codec.

Verify:

```bash
command -v sox play soxi pactl && sox --version
sox --help | sed -n '/AUDIO DEVICE DRIVERS/p'
sox --help | grep -oE '\b(silence|vad)\b' | sort -u
```

The driver line must include `pulseaudio`, and both `silence` and `vad` must be listed. The first is the capture route; the second pair are the effects the recorder relies on for silence trimming, and 002 relies on for segmentation. On the target machine this resolves to SoX 14.4.2 with `libsox-fmt-pulse` 14.4.2+git20190427-4build4 (research.md R-009).

## 2. Verify the audio bridge responds

Installed tools are not sufficient — the WSLg PulseAudio bridge can be present but stale, typically after the Windows host sleeps.

```bash
pactl info && pactl list sources short
```

`pactl info` must connect, not merely run. If it fails or lists no sources, restart the WSL subsystem from Windows:

```
wsl --shutdown
```

Then reopen the terminal. This is the corrective action FR-013 requires the plugin to name.

## 3. Derive the gateway endpoints

The transcription and correction services live on the OpenAI-compatible gateway host. The agent's own configuration already holds the Anthropic host for the same tenant, so derive rather than retype:

```bash
python3 - <<'EOF'
import os
a = os.environ.get("OPENCODE_ANTHROPIC_BASEURL", "")
if not a:
    raise SystemExit("OPENCODE_ANTHROPIC_BASEURL is not set; source your shell env file first")
print(a.replace("anthropic.", "openai.", 1))
EOF
```

Add the result to the gitignored shell environment file (`~/.config/bash/.env`):

```bash
export OPENCODE_VOICE_STT_BASEURL="<derived value>"
```

One variable, because both services resolve to this host and the correction endpoint defaults to the transcription endpoint. FR-008 requires that they _can_ be configured independently, not that they must be; supplying a second value is how you separate them if that ever becomes necessary. Independence from the **agent's** service is the part of FR-008 that is load-bearing here, and that holds regardless: the Anthropic host rejects both audio and chat-completions requests (research.md R-002).

Confirm the host answers and the credential works. The token is read from the editor's credential store — the same source the plugin will use, and deliberately **not** from the environment, whose copy has been observed to run months stale:

```bash
python3 - <<'EOF'
import json, os, pathlib, urllib.request
tok = json.loads(pathlib.Path("~/.local/share/opencode/auth.json").expanduser().read_text())["anthropic"]["key"]
url = os.environ["OPENCODE_VOICE_STT_BASEURL"].rstrip("/") + "/models"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
with urllib.request.urlopen(req, timeout=20) as r:
    ids = [m["id"] for m in json.load(r)["data"]]
print("HTTP", r.status, "models:", len(ids))
print("audio tiers:", sorted(i for i in ids if "transcribe" in i or "whisper" in i))
EOF
```

Expect HTTP 200 and `gpt-transcribe` present. A 403 here means the token has expired — run `opencode auth login` and retry. `jq` is not installed on this machine; use `python3` for JSON, as above.

## 4. Register the plugin

Plugins are declared in `~/.config/opencode/tui.jsonc`. That file currently carries only the `plugin` key; theme and keybinds live in the adjacent `tui.json`. Neither duplicates the other's keys, so add to `tui.jsonc` and leave `tui.json` alone.

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

`{env:NAME}` is resolved by the editor before the plugin is loaded, and it reaches nested values inside plugin option objects — verified by instrumented probe, research.md R-008. The plugin implements no indirection of its own. This is what keeps the tenant identifier and gateway hostname out of this repository and out of `~/.config/opencode`, both of which are public.

No credential option appears here. The token is read from the editor's own credential store at each request; naming it in configuration would either commit it or pin it to a value fixed when the editor started.

A local filesystem path pins the fork. Do **not** reference the upstream package: an unpinned dependency would silently pull upstream changes into `~/.cache/opencode/packages/` and discard the fork's behaviour.

If an endpoint arrives empty, the cause is almost always an unset variable rather than a malformed URL: the editor substitutes an empty string for a variable it cannot find. The plugin is required to say so by name (contracts/plugin-options.md).

Restart opencode and confirm the plugin is listed and active in the plugins dialog.

---

## Verification

Each check maps to an acceptance scenario or success criterion in the spec. Run them in order; later checks assume earlier ones pass.

### User Story 1 — dictation

| #   | Action                                                                                                        | Expected                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1.1 | Hold the record key, say _\"refactor the JSON parser in lib slash stt dot js and return a boolean\"_, release | Text appears in the prompt, **not submitted**                                          |
| 1.2 | Inspect that text                                                                                             | Reads `lib/stt.js`, `JSON`, `boolean` — not `lib slash stt dot js`, `Jason`, `bullion` |
| 1.3 | Type `check this: `, then dictate                                                                             | Typed text preserved, dictation appended after it                                      |
| 1.4 | Hold and release immediately without speaking                                                                 | Prompt unchanged, told nothing was captured                                            |
| 1.5 | Time 1.1 from release to text                                                                                 | Under 3s typically, under 5s always (SC-001)                                           |

Check 1.2 is the substantive one. Measured component latency for 1.5 is 0.75s transcription plus 1.62s correction.

### User Story 2 — credentials

| #   | Action                                                                                            | Expected                                                              |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2.1 | Dictate successfully                                                                              | Works                                                                 |
| 2.2 | In another terminal run `opencode auth login`, then dictate again **without restarting opencode** | Works, using the new token (FR-005)                                   |
| 2.3 | Temporarily rename the credential store, dictate                                                  | One line per source tried, each with why it failed. Not a stack trace |
| 2.4 | Restore the store, set the fallback environment variable, rename the store again, dictate         | Succeeds from the fallback (FR-006)                                   |
| 2.5 | Search the log for the token                                                                      | Zero occurrences (SC-004)                                             |

Check 2.2 is the whole point of User Story 2. It is what the previously used environment-variable approach could not do.

### User Story 3 — audio and configuration

| #   | Action                                                      | Expected                                                              |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 3.1 | Open the microphone selector                                | All devices from `pactl list sources short` are listed                |
| 3.2 | Select a device, restart opencode, reopen the selector      | Choice persisted (FR-012)                                             |
| 3.3 | Open the tier selector                                      | `gpt-transcribe` reachable without scrolling; nothing hidden (SC-007) |
| 3.4 | In the tier selector, type part of a tier name              | The host's own filtering narrows the list                             |
| 3.5 | Configure a tier known to 403, dictate                      | Error names the tier. Distinct from an authentication error           |
| 3.6 | Run `pulseaudio -k` or `wsl --shutdown`, attempt to dictate | Error names the audio subsystem and states the remedy (SC-005)        |

Check 3.3 fails against unmodified upstream, whose catalogue filter admits only names containing `whisper` — which on this gateway leaves exactly the one tier that mangles file paths. Check 3.4 is what makes removing the filter usable rather than merely correct: the service reports over a thousand tiers, so the measured-working group carries the common case and the host's filter carries the rest.

### Lifecycle

| #   | Action                                                                         | Expected                                                           |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 4.1 | Dictate, then `ls -la` the plugin's capture directory under `$TMPDIR`          | No capture files remain (SC-006)                                   |
| 4.2 | Cause a transcription failure, then check again                                | Still no files — deleted on failure too                            |
| 4.3 | While a capture file exists, check its mode and its directory's mode           | Both owner-only (FR-014)                                           |
| 4.4 | Start recording, then `kill -9` opencode                                       | No `sox` process survives; no audio left behind (FR-015)           |
| 4.5 | Start an unrelated process whose command line contains `sox`, dictate, release | The unrelated process survives (FR-016)                            |
| 4.6 | Point the correction endpoint at an unroutable address, dictate                | Times out within the configured bound and says so (FR-018, SC-008) |

Checks 4.4 to 4.6 all fail against unmodified upstream. Check 4.5 matters beyond hygiene: feature 002 introduces a second capture process, which a command-line pattern kill would destroy.

---

## Repository checks

```bash
cd /home/logan/opencode-voice
npm run test      # node --test
npm run check     # oxlint . && oxfmt --check .
```

Both must be clean. `oxfmt` also formats Markdown and JSON, so spec files are covered; `.prettierignore` excludes the vendored `.specify/` and `.opencode/commands/` trees, which do not conform.

---

## Troubleshooting

| Symptom                       | Cause                                                                   | Fix                                                                      |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Recording produces silence    | `libsox-fmt-pulse` missing, or bridge stale                             | Install the codec; `wsl --shutdown`                                      |
| `pactl info` fails            | Bridge not running                                                      | `wsl --shutdown`, reopen terminal                                        |
| 403 on every request          | Token expired — 24-hour lifetime                                        | `opencode auth login`. No opencode restart needed                        |
| 403 naming an endpoint        | Wrong host — the Anthropic host rejects both audio and chat-completions | Re-derive per step 3                                                     |
| Tier selector nearly empty    | Catalogue filter still applied                                          | FR-011 not implemented                                                   |
| Correction invents a filename | Wrong correction model                                                  | Confirm `gpt-4.1`. `gpt-4o-mini` produced `lib/sst.js` from `lib/stt.js` |
| Plugin absent from dialog     | Path wrong, or `tui.json` edited instead of `tui.jsonc`                 | Check the plugins dialog and the TUI log                                 |
