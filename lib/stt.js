// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { getActiveSessionTitle } from "./session.js";
import { createCredentialResolver, describeRejection, formatCredentialError } from "./auth.js";
import {
  buildCapturePath,
  createCapture,
  disposeCapturesSync,
  liveCaptureOwner,
  nextCapturePath,
  ownedCapture,
  registerCapture,
  removeCaptureDir,
  stopActiveCapture,
  stopOwnedCapture,
  unregisterCapture,
} from "./capture.js";

// Re-exported so callers that already import the capture lifecycle from here
// keep working. lib/capture.js is where it lives; this is where 001 published
// it.
export {
  buildCapturePath,
  createCapture,
  disposeCapturesSync,
  removeCaptureDir,
  stopActiveCapture,
};

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;
let sttVocabulary = [];
let credentials = null;

// Resolve the gateway credential for a single request.
//
// Called from inside each request function, never hoisted to module scope: the
// token rotates every 24 hours and an editor session outlives it, so a value
// captured once is a value that goes stale in place (FR-005).
function resolveApiCredential() {
  const resolver = credentials ?? createCredentialResolver({ envVar: sttApiKeyEnv });
  const result = resolver.resolve();
  return {
    ok: result.ok,
    value: result.ok ? result.value : null,
    label: result.ok ? result.attempts.find((a) => a.outcome === "ok")?.label : null,
    attempts: result.attempts,
    configured: resolver.isConfigured(),
  };
}

// A canonical WAV header is 44 bytes, so a file no larger than that carries a
// header and no samples. With silence trimming on, that is exactly what a
// capture of nothing produces, which is why it reads as an empty capture rather
// than a failure (contracts/commands.md).
const WAV_HEADER_BYTES = 44;

let sttTimeoutMs = 15000;

// Local decode is not a network round trip: whisper-cli on CPU routinely needs
// far longer than a gateway responds in, so the configured bound acts as a
// lower limit on this path rather than the limit itself.
const LOCAL_DECODE_MIN_TIMEOUT_MS = 60000;

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

// Terms the transcriber would otherwise guess at phonetically: product names,
// tool names, and anything else absent from a general language model. The
// transcription API biases decoding towards the contents of its `prompt`
// parameter, which was confirmed working on `gpt-transcribe` (research.md
// R-001). A comma-separated list is the idiom the parameter expects.
//
// Returns an empty string when there is nothing to bias, so the caller can omit
// the parameter rather than send a blank one.
export function buildVocabularyPrompt(terms) {
  if (!Array.isArray(terms)) return "";
  const seen = new Set();
  const kept = [];
  for (const term of terms) {
    if (typeof term !== "string") continue;
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
  }
  return kept.join(", ");
}

export function buildMultipartTranscriptionRequest(
  model,
  audioBuffer,
  apiKey,
  vocabularyPrompt = "",
) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (vocabularyPrompt) form.append("prompt", vocabularyPrompt);

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

export function detectAudioBackend() {
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
export function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Pre-flight message for a fault that would otherwise record silence without
// complaining. Returns null when there is nothing to say, so a caller can use
// it as a guard. Only consulted when the default device is in play: an
// explicitly chosen source is passed to sox by name and does not go through
// the server's default-source indirection at all.
export function describeAudioFault(backend, mic) {
  if (backend !== "pulseaudio" || mic) return null;
  const fault = defaultSourceFault();
  if (!fault) return null;
  const cause =
    fault.reason === "missing"
      ? `The audio server's default source "${fault.name}" does not exist`
      : `The audio server's default source "${fault.name}" is a sink monitor, which records output rather than a microphone`;
  // The remedy has to hold for anyone running this plugin, so it names only
  // tools that ship with WSLg itself. Reloading the module repairs it in place;
  // the shutdown is the fallback for when the audio bridge is wedged rather
  // than merely missing a module.
  const remedy = isWSL()
    ? 'run "pactl load-module module-rdp-source source_name=RDPSource && pactl set-default-source RDPSource", or "wsl --shutdown" on Windows to rebuild the audio bridge'
    : "reconnect the input device, or choose one with /stt-mic";
  return `${cause}, so recording would capture no speech. To fix it, ${remedy}.`;
}

// Input device descriptors: name is the value passed to sox, label is shown in the UI.
export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name,
      label: s.description ? `${s.description} (${s.name})` : s.name,
    }));
}

export function parsePactlSourcesShort(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

// A reachable PulseAudio server can still be unable to hear anything, and it
// fails without saying so: sox records digital silence and exits 0, so the
// server is up, the recorder succeeded, and the transcript is merely empty or
// invented. This is the one audio fault worth detecting before recording
// rather than reporting afterwards, because it is the only one that produces
// no error at all.
//
// WSLg produces both shapes when `module-rdp-source` goes missing, depending on
// how it went:
//
//   missing - the default still names the departed source. Observed on this
//             machine: `Default Source: RDPSource` with RDPSource absent.
//   monitor - the server reassigned the default to a sink monitor, which is a
//             real source that loops back output. Observed by unloading the
//             module by hand, after which the default became RDPSink.monitor.
//
// A monitor is only a fault when nobody asked for it; capturing one on purpose
// is a legitimate thing to do, which is why the caller suppresses this check
// once a device has been chosen explicitly.
export function findDefaultSourceFault(infoText, sourcesText) {
  const named = /^\s*Default Source:\s*(\S+)\s*$/m.exec(infoText || "");
  if (!named) return null;
  const name = named[1];
  if (name === "@DEFAULT_SOURCE@") return null;
  const existing = new Set(
    (sourcesText || "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean),
  );
  if (!existing.has(name)) return { reason: "missing", name };
  if (name.endsWith(".monitor")) return { reason: "monitor", name };
  return null;
}

// Runs the two commands behind findDefaultSourceFault. Returns null when the
// check cannot be made, so an unavailable pactl never blocks a recording.
function defaultSourceFault() {
  try {
    const info = execSync("pactl info 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
    const sources = execSync("pactl list sources short 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    return findDefaultSourceFault(info, sources);
  } catch {
    return null;
  }
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Capture: one object owning one recording ----
//
// The child process handle, the audio file path and the "am I recording" flag
// used to live as three independent module-level variables. Every lifecycle
// defect in this area traced back to that single cause: any one of them could
// change without the others, so a handle could outlive its file, a file could
// outlive its handle, and the flag could disagree with both.
//
// A capture is now one object. It is either active or it is null, and whoever
// holds it holds everything needed to stop it and to clean up after it. See the
// Capture entity in specs/001-enterprise-gateway-stt/data-model.md, FR-014 to
// FR-018.

// The record of what is live, the temporary directory, the filename
// sequence and the two teardown drains now belong to lib/capture.js, so a
// capture created by continuous listening is reachable by the same teardown
// as one created here (specs/002-continuous-wake-phrase/research.md R-108).
// This module keeps only its own claim on the microphone, and it keeps it in
// that shared registry rather than in a slot of its own.
const DICTATION = "held-key dictation";

let processing = false;

function startRecording(kv, backend, toast, logger, trimSilence = true) {
  // At most one capture is active across the whole plugin, not just this mode.
  // A second trigger is refused by name rather than starting a competing
  // recorder that would fight for the microphone and leave two files behind
  // (FR-017). The owner label comes from the registry, so the refusal names
  // whichever mode actually holds it.
  const holder = liveCaptureOwner();
  if (holder === DICTATION) {
    logger?.log("STT", "Start recording refused: a capture is already active", "debug");
    toast("Already recording. Trigger transcribe to stop it, or cancel the recording.", "warning");
    return null;
  }
  if (holder) {
    logger?.log("STT", `Start recording refused: ${holder} holds the microphone`, "debug");
    toast(`${holder} is using the microphone. Stop it first (/listen-toggle).`, "warning");
    return null;
  }

  const fault = describeAudioFault(backend, kv.get("stt.mic", "") || null);
  if (fault) {
    logger?.log("STT", `Start recording refused: ${fault}`, "warn");
    toast(fault, "error");
    return null;
  }

  let audioPath;
  try {
    audioPath = nextCapturePath(logger);
    // Pre-created 0600 so the file is owner-only from the moment it exists.
    // sox truncates an existing file and leaves its mode alone (FR-014).
    fs.writeFileSync(audioPath, "", { mode: 0o600 });
  } catch (err) {
    logger?.log("STT", `Could not prepare capture file: ${err.message}`, "error");
    toast(`Cannot start recording: ${err.message}`, "error");
    return null;
  }

  const mic = kv.get("stt.mic", "") || null;
  const inputArgs = buildRecordArgs(backend, mic);
  logger?.log(
    "STT",
    `Starting capture backend=${backend} mic=${mic || "system default"} file=${audioPath}`,
    "debug",
  );

  const silenceArgs = trimSilence ? ["silence", "1", "0.1", "1%"] : [];
  const child = spawn(
    "sox",
    [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", audioPath, ...silenceArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );

  const active = registerCapture(
    createCapture({ process: child, path: audioPath, logger }),
    DICTATION,
  );

  child.on("error", (err) => {
    logger?.log("STT", `Capture failed to start: ${err.message}`, "error");
    if (unregisterCapture(active)) {
      active.removeAudio();
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  child.on("exit", (code) => {
    logger?.log(
      "STT",
      `sox exited code=${code} stderr=${active.stderr}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    // Still in the recording state means the recorder died on its own rather
    // than being stopped, so nothing downstream is going to report it. This
    // covers the microphone being unplugged mid-capture.
    if (active.state === "recording" && code !== 0 && code !== null && unregisterCapture(active)) {
      active.removeAudio();
      const errLine = active.stderr.split("\n").pop();
      toast(
        `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
        "error",
      );
    }
  });

  return active;
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

function getLanguage(kv) {
  return kv.get("stt.language") || sttDefaultLanguage;
}

export function buildWhisperArgs(modelPath, wavFile, language) {
  return ["-m", modelPath, "-f", wavFile, "-l", language || DEFAULT_LANGUAGE, "-np", "-nt"];
}

function transcribe(kv, wavFile, logger) {
  const mp = getModelPath(kv);
  const lang = getLanguage(kv);
  logger?.log("STT", `Local transcription requested model=${mp} language=${lang}`, "debug");
  if (!fs.existsSync(mp)) {
    logger?.log("STT", `Whisper model missing: ${mp}`, "error");
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= WAV_HEADER_BYTES) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ empty: true });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", buildWhisperArgs(mp, wavFile, lang), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeoutMs = Math.max(sttTimeoutMs, LOCAL_DECODE_MIN_TIMEOUT_MS);
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", `whisper-cli timed out after ${timeoutMs}ms`, "error");
      resolve({
        error: `Local transcription exceeded its ${timeoutMs}ms bound and was abandoned. Raise sttTimeoutMs, or select a smaller whisper model.`,
      });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(complete, rawText, sessionTitle, systemPrompt, logger) {
  const contextLine = sessionTitle ? ` The user is currently working on: "${sessionTitle}"` : "";
  const system = `${systemPrompt}${contextLine}`;

  logger?.log("STT", `Normalizing transcription chars=${rawText.length}`, "debug");
  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
  return result;
}

// ---- Transcription tiers ----
//
// The tiers below were timed against an identical clip and checked for whether
// they convert spoken punctuation and paths into what a developer meant
// (research.md R-001), listed fastest first. The order is deliberate: it is the
// order a user should try them in.
//
// `whisper-1` sits in this group because it was measured, not because it did
// well. It was the only tier that left a spoken file path unconverted, and it
// was also the only tier the old `/whisper/i` catalogue filter admitted, so the
// plugin used to offer exactly one option and it was the wrong one.
const MEASURED_TIERS = [
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "whisper-1",
  "gpt-4o-mini-transcribe",
];

const MEASURED_CATEGORY = "Measured";
const REMAINDER_CATEGORY = "Remainder";

// The gateway advertises well over a thousand models, most of them other
// tenants' fine-tunes, so a flat list is unusable and a substring filter throws
// away the tiers that work (research.md R-006). Grouping is the compromise the
// host supports: it renders categories and filters as the user types, so the
// measured tiers sit at the top and nothing is hidden.
export function groupTranscriptionTiers(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const available = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    available.push(trimmed);
  }

  const measured = MEASURED_TIERS.filter((tier) => seen.has(tier));
  const measuredSet = new Set(measured);
  const remainder = available.filter((id) => !measuredSet.has(id));

  return [
    ...measured.map((id) => ({ value: id, label: id, category: MEASURED_CATEGORY })),
    ...remainder.map((id) => ({ value: id, label: id, category: REMAINDER_CATEGORY })),
  ];
}

const CATALOGUE_TIMEOUT_MS = 5000;

// Returns `{options, error}` rather than a bare array so the caller can say why
// a list is short or missing. A selector that silently shows one stale entry
// teaches the user nothing (FR-009).
async function getApiModels(logger) {
  if (!sttApiEndpoint) {
    return {
      options: [],
      error:
        "No transcription service is configured. Set sttApiEndpoint to an OpenAI-compatible gateway.",
    };
  }

  const url = sttApiEndpoint.endsWith("/") ? `${sttApiEndpoint}models` : `${sttApiEndpoint}/models`;
  const headers = {};
  const credential = resolveApiCredential();
  let credentialError = null;
  if (credential.ok) {
    headers["Authorization"] = "Bearer " + credential.value;
  } else if (credential.configured) {
    // Held rather than returned straight away: some gateways serve the
    // catalogue unauthenticated, and a list is more useful than a refusal. If
    // the request does fail, this is the reason the user needs to see.
    credentialError = formatCredentialError(credential.attempts);
    logger?.log(
      "STT",
      `Model catalogue request unauthenticated: ${credentialError.replace(/\n\s*/g, " ")}`,
      "warn",
    );
  }

  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
    logger?.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) {
      if (credentialError) return { options: [], error: credentialError };
      if (resp.status === 401 || resp.status === 403) {
        return {
          options: [],
          error:
            `The service refused the model catalogue (${resp.status}) with the credential from ${credential.label}. ` +
            "Re-authenticate in opencode, or confirm the account may list models.",
        };
      }
      return {
        options: [],
        error: `The service refused the model catalogue (${resp.status}). Confirm sttApiEndpoint points at an OpenAI-compatible gateway.`,
      };
    }
    const data = await resp.json();
    const options = groupTranscriptionTiers((data.data || []).map((m) => m?.id));
    if (options.length === 0) {
      return {
        options,
        error:
          credentialError ??
          "The service advertised no models. Confirm sttApiEndpoint points at an OpenAI-compatible gateway.",
      };
    }
    logger?.log("STT", `Grouped ${options.length} transcription tiers`, "debug");
    return { options, error: credentialError };
  } catch (err) {
    logger?.log("STT", `Failed to fetch STT API models: ${err.message}`, "error");
    if (credentialError) return { options: [], error: credentialError };
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      options: [],
      error: timedOut
        ? `The model catalogue request exceeded its ${CATALOGUE_TIMEOUT_MS}ms bound. The service may be unreachable.`
        : `The model catalogue could not be read: ${err.message}`,
    };
  }
}

// Exported so continuous listening transcribes down exactly this path rather
// than a parallel one: same endpoint, same tier, same credential resolution,
// same error classification. `signal` composes a caller's lifetime with the
// per-request timeout, so a session torn down mid-request abandons it instead
// of waiting out the bound (FR-020).
export async function transcribeApi(kv, wavFile, logger, signal) {
  if (!sttApiEndpoint || !sttApiModel) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  const model = kv.get("stt.api.model") || sttApiModel;
  logger?.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= WAV_HEADER_BYTES) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { empty: true };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const credential = resolveApiCredential();
    if (!credential.ok && credential.configured) {
      logger?.log("STT", "STT API transcription skipped: credential unresolved", "error");
      return { error: formatCredentialError(credential.attempts) };
    }
    const apiKey = credential.value;
    const useOpenRouterFormat = isOpenRouterEndpoint(sttApiEndpoint);

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    // OpenRouter's transcription payload is a different shape with no prompt
    // parameter, so vocabulary biasing applies to the OpenAI-compatible path
    // only. Sending an unrecognised field there would be a request the service
    // is entitled to reject.
    const vocabularyPrompt = buildVocabularyPrompt(sttVocabulary);
    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey, vocabularyPrompt);
    if (vocabularyPrompt && !useOpenRouterFormat) {
      logger?.log("STT", `Biasing recognition with ${sttVocabulary.length} terms`, "debug");
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(sttTimeoutMs)])
        : AbortSignal.timeout(sttTimeoutMs),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      let detail = null;
      try {
        const err = JSON.parse(responseBody);
        detail = err?.error?.message || null;
        msg = detail || msg;
      } catch {}
      // A rejected-but-resolved credential is a different fault from one that
      // never resolved, and the two must not read alike.
      if (resp.status === 401 || resp.status === 403) {
        return { error: describeRejection(resp.status, credential.label, model, detail) };
      }
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    // A caller that has gone away is not a fault to report: distinguishing it
    // from the timeout keeps a torn-down session from claiming the gateway was
    // slow (FR-020).
    if (signal?.aborted) return { aborted: true };
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return {
        error: `The transcription request exceeded its ${sttTimeoutMs}ms bound (sttTimeoutMs). Raise sttTimeoutMs, or set sttApiEndpoint to a service that responds faster.`,
      };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

async function appendTranscription(client, text, submit) {
  let appendResult = await client.tui.appendPrompt({ body: { text } });

  if (appendResult?.error?.data?.message === "Expected object, got undefined") {
    appendResult = await client.tui.appendPrompt({ text });
  }

  if (appendResult?.error) {
    throw new Error(
      `appendPrompt failed: ${appendResult.error.data?.message || appendResult.error.name}`,
    );
  }

  if (submit) {
    await client.tui.submitPrompt();
  }
}

async function doTranscribePipeline(
  kv,
  complete,
  client,
  toast,
  systemPrompt,
  submit = false,
  logger,
) {
  // The pipeline takes ownership of the capture for its whole duration, so a
  // trigger arriving mid-transcription cannot stop a recorder that has already
  // stopped or delete a file that is being read.
  const active = ownedCapture(DICTATION);
  if (!active) {
    toast("No recording in progress", "warning");
    return;
  }

  processing = true;
  try {
    logger?.log("STT", `Pipeline started submit=${submit}`, "debug");
    await active.stop();
    active.state = "transcribing";

    toast("Transcribing...");
    const result = sttApiEndpoint
      ? await transcribeApi(kv, active.path, logger)
      : await transcribe(kv, active.path, logger);

    // Errors first: a failed result carries no text either, so testing for
    // emptiness before testing for failure would report every failure as
    // silence and hide its cause.
    if (result.error) {
      logger?.log("STT", `Transcription failed: ${result.error}`, "error");
      active.state = "failed";
      toast(result.error, "error");
      return;
    }
    // An empty capture is not a failure, and is reported differently on purpose
    // (contracts/commands.md). Nothing is inserted, and in the empty-file case
    // no request was spent on it either.
    if (result.empty || !result.text) {
      logger?.log("STT", "Nothing captured", "warn");
      active.state = "done";
      toast("Nothing was captured. Hold the key while speaking, then release.", "warning");
      return;
    }

    toast("Normalizing...");
    const sessionTitle = await getActiveSessionTitle(client);
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      sessionTitle,
      systemPrompt,
      logger,
    );

    if (!llmResult.text) {
      logger?.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      await appendTranscription(client, result.text, submit);
      return;
    }

    await appendTranscription(client, llmResult.text, submit);
    active.state = "done";
    logger?.log("STT", `Pipeline completed normalizedChars=${llmResult.text.length}`, "debug");
    toast(submit ? "Transcription submitted" : "Transcription added to prompt", "success");
  } catch (err) {
    logger?.log("STT", `Pipeline error: ${err.message}`, "error");
    active.state = "failed";
    toast(`STT error: ${err.message}`, "error");
  } finally {
    // One exit for every path through the pipeline, so the audio is removed
    // and the capture slot released whether the transcription succeeded, was
    // empty, errored, or threw (FR-015).
    active.removeAudio();
    unregisterCapture(active);
    processing = false;
  }
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, prompts, opts, logger, credentialResolver) {
  const client = api.client;
  const systemPrompt = prompts?.stt || STT_SYSTEM_PROMPT;
  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // Assigned unconditionally: the resolver is how every request obtains a
  // credential, whether or not an upstream transcription endpoint is set.
  credentials = credentialResolver || null;

  if (opts?.sttApiEndpoint) {
    sttApiEndpoint = opts.sttApiEndpoint;
    sttApiModel = opts.sttApiModel || "gpt-transcribe";
    sttApiKeyEnv = opts.apiKeyEnv || opts.sttApiKeyEnv || null;
    logger?.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (Array.isArray(opts?.sttVocabulary)) {
    sttVocabulary = opts.sttVocabulary;
    const biased = buildVocabularyPrompt(sttVocabulary);
    if (biased) logger?.log("STT", `Vocabulary terms=${biased}`, "debug");
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger?.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  if (Number.isInteger(opts?.sttTimeoutMs) && opts.sttTimeoutMs > 0) {
    sttTimeoutMs = opts.sttTimeoutMs;
  }
  logger?.log("STT", `Transcription timeout=${sttTimeoutMs}ms`, "debug");

  // The capture directory is created on first use rather than at load, so an
  // editor session that never dictates leaves nothing behind at all.

  return [
    {
      title: sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      value: "stt.record",
      description: sttApiEndpoint
        ? "Toggle recording; press again to stop and transcribe via API"
        : "Toggle recording; press again to stop and transcribe",
      keybind: "ctrl+r,alt+r",
      slash: { name: "stt-record" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (ownedCapture(DICTATION)) {
          toast("Stopping, transcribing...");
          doTranscribePipeline(kv, complete, client, toast, systemPrompt, false, logger);
        } else if (startRecording(kv, backend, toast, logger, opts?.trimSilence)) {
          toast("Recording... press again to transcribe");
        }
      },
    },
    {
      title: sttApiEndpoint ? "STT: submit recording (API)" : "STT: submit recording",
      value: "stt.submit",
      description: sttApiEndpoint
        ? "Stop recording, transcribe via API, and submit prompt"
        : "Stop recording, transcribe, and submit prompt",
      // alt+shift+r moved to listen.toggle. The two capture modes are mutually
      // exclusive, so adjacent chords for both would invite the mistake the
      // exclusion check then has to refuse.
      keybind: "<leader>r",
      slash: { name: "stt-submit" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!ownedCapture(DICTATION)) {
          toast("No recording in progress", "warning");
          return;
        }
        toast("Stopping, transcribing...");
        doTranscribePipeline(kv, complete, client, toast, systemPrompt, true, logger);
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      async onSelect() {
        // Only this mode's capture. The all-capture drain is for teardown,
        // where indiscriminate is the point; here it would reach past the
        // command the user actually invoked.
        if (!(await stopOwnedCapture(DICTATION, logger))) return;
        logger?.log("STT", "Recording cancelled", "debug");
        toast("Recording cancelled");
      },
    },
    {
      title: sttApiEndpoint ? "STT: select tier" : "STT: select model",
      value: "stt.model",
      description: sttApiEndpoint ? "Choose transcription tier" : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        if (sttApiEndpoint) {
          const current = kv.get("stt.api.model") || sttApiModel;
          const { options: tiers, error } = await getApiModels(logger);
          // Told, not merely logged: a one-entry list with no explanation looks
          // like the service only offers one tier (T032).
          if (error) toast(error, "warning");
          const options =
            tiers.length > 0 ? tiers : [{ value: current, label: current, category: "Configured" }];
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select transcription tier",
              current,
              options: options.map((m) => ({
                title: m.label,
                value: m.value,
                category: m.category,
                onSelect() {
                  kv.set("stt.api.model", m.value);
                  toast(`Transcription tier: ${m.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        } else {
          const current = getModelName(kv);
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model",
              current,
              options: Object.entries(MODELS).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  kv.set("stt.model", key);
                  toast(`Whisper model: ${v.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
    {
      title: "STT: select language",
      value: "stt.language",
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      onSelect() {
        const current = getLanguage(kv);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select transcription language",
            current,
            options: Object.entries(LANGUAGES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                kv.set("stt.language", key);
                toast(`Whisper language: ${v.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const current = kv.get("stt.mic", "");
        const devices = listInputDevices(backend);
        if (devices.length === 0) {
          const serverOk = backend !== "pulseaudio" || pulseServerHealth().ok;
          const hint = buildAudioHint({ backend, serverOk, isWsl: isWSL() });
          logger?.log("STT", `No input devices: ${hint}`, "warn");
          toast(hint);
          return;
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select microphone",
            current,
            options: [
              {
                title: "System default",
                value: "",
                onSelect() {
                  kv.set("stt.mic", "");
                  toast("Mic: system default");
                  api.ui.dialog.clear();
                },
              },
              ...devices.map((d) => ({
                title: d.label,
                value: d.name,
                onSelect() {
                  kv.set("stt.mic", d.name);
                  toast(`Mic: ${d.label}`);
                  api.ui.dialog.clear();
                },
              })),
            ],
          }),
        );
      },
    },
  ];
}
