// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, append to the TUI prompt.
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via tui.jsonc plugin options. The host substitutes
// {env:NAME} into option values before the plugin is handed them, so the
// gateway location never appears in tracked configuration:
//   ["/path/to/opencode-voice", { "sttApiEndpoint": "{env:MY_GATEWAY}" }]
//
// `endpoint` and `sttApiEndpoint` each default to the other, so a working
// configuration names the gateway once. See
// specs/001-enterprise-gateway-stt/contracts/plugin-options.md.
//
// Runtime state (model, mic, voice, tts mode) persisted via api.kv.
//
// Commands:
//   /stt-record (ctrl+r)  - start/stop recording + transcribe
//   /stt-submit (leader+r)- stop recording + transcribe + submit
//   /stt-stop             - cancel recording
//   /stt-model            - select whisper model
//   /stt-language         - select transcription language
//   /stt-mic              - select microphone
//   /tts-speak (leader+s)- read last response aloud
//   /tts-mode (leader+v) - toggle auto TTS on/off
//   /tts-stop (escape)   - stop playback
//   /tts-voice           - select TTS voice

import fs from "node:fs";
import os from "node:os";
import { registerSTT } from "./lib/stt.js";
// Teardown binds to the capture layer directly rather than to whichever mode
// happens to re-export it, so a capture created by continuous listening is
// reachable by the same hooks as one created by dictation (FR-020).
import { disposeCapturesSync, removeCaptureDir, stopActiveCapture } from "./lib/capture.js";
import { registerTTS } from "./lib/tts.js";
import { registerListen } from "./lib/listen.js";
import { compilePhrases, DEFAULT_WAKE_PHRASES } from "./lib/wake.js";
import { createClient } from "./lib/llm-client.js";
import { createCredentialResolver } from "./lib/auth.js";
import { createLogger } from "./lib/logger.js";

// Defaults from the plugin options contract. Transcription and correction
// models are the tiers research.md measured as both fastest and accurate
// (R-001, R-004); the timeouts bound a single request (FR-018).
const OPTION_DEFAULTS = {
  sttApiModel: "gpt-transcribe",
  sttVocabulary: [],
  // Empty by default. A style instruction is only worth sending to a model
  // that honours it, and which models do is a property of the deployment
  // rather than of the plugin: on the gateway this was built against,
  // `whisper-1` follows an instruction and `gpt-transcribe` ignores it. A
  // default here would therefore be a claim about someone else's service.
  sttApiInstruction: "",
  sttTimeoutMs: 15000,
  model: "gpt-4.1",
  maxTokens: 400,
  temperature: 0.2,
  llmTimeoutMs: 15000,
  credentialStorePath: "~/.local/share/opencode/auth.json",
  credentialStoreKeyPath: ["anthropic", "key"],
  trimSilence: true,
};

// Continuous listening. Defaults from
// specs/002-continuous-wake-phrase/contracts/listen-options.md.
//
// The two bounds are sized to coincide: 64,000 characters is about an hour of
// speech at a fast conversational rate, so the size bound is what fires when
// the developer has been talking and the age bound is the backstop for a
// session left running through a long silence. Neither is a staleness policy;
// inspecting or discarding the buffer is (FR-013).
const LISTEN_DEFAULTS = {
  listenSilenceDurationMs: 700,
  // Measured rather than guessed, and the measurement moved it down by a factor
  // of four. On a quiet room the noise floor peaks around 0.07% in 20ms
  // windows, while the quietest dips inside continuous speech - inter-word gaps
  // and unvoiced consonants - bottom out around 0.83%. The threshold has to sit
  // in that valley. A threshold of 2% is above the speech dips, which made a
  // fifth of an uninterrupted eight-second monologue read as silence and left
  // the 700ms duration requirement as the only thing preventing mid-word cuts.
  // Much below 0.3% risks the opposite failure, where room noise never counts
  // as silence and every utterance runs to listenMaxSegmentMs instead.
  //
  // This is one room and one microphone, so it is a starting point, not a
  // constant. The tuning procedure is in the README.
  listenSilenceThreshold: "0.5%",
  listenMinSegmentMs: 400,
  listenMaxSegmentMs: 30000,
  listenMaxBufferAgeMs: 3600000,
  listenMaxBufferChars: 64000,
  listenAutoSubmit: true,
  // The label is the entire substitute for a correction pass, and it is also
  // what makes the retained wake phrase legible. The transcript is a stretch of
  // thinking aloud with a direct instruction somewhere inside it; naming the
  // agent is what lets it tell the two apart, because the phrase the developer
  // says out loud is an address. The phrases themselves are deliberately not
  // listed here: they are present in the transcript, they are configurable, and
  // a list repeated in prose would eventually disagree with the configuration.
  //
  // The mis-transcription is called out because the name is the one part of
  // the phrase that is not stable: it has come back as "node" and as "norm"
  // from the same speaker on the same microphone. Both are words a developer
  // could mean literally, so an agent reading one has no way to tell a
  // mangled address from a topic unless told. The tokens around the name are
  // transcribed reliably and need no explanation.
  //
  // This label belongs to continuous listening only. Held-key dictation
  // transcribes and returns text; it has no wake phrase to explain and no
  // reason to tell the agent anything about how the words arrived.
  listenTranscriptLabel:
    "The following is a voice transcript and may contain speech recognition errors, " +
    "particularly in code identifiers, file paths and technical terms. Treat unfamiliar " +
    "identifiers with suspicion and verify them against the project before acting on them. " +
    "The developer speaks to you as Nome. A phrase addressing you by name is how they mark " +
    "a direct instruction; the surrounding speech is them thinking aloud, and is context " +
    "rather than a request. Act on the instruction, and use the rest to inform how. " +
    'Speech recognition renders "Nome" inconsistently, most often as "node" or "noam". ' +
    'So "hey node" and "hey noam" are this address mis-transcribed rather than a reference ' +
    "to Node.js or to a colleague. The address usually opens the request it belongs to, as " +
    'in "hey node, what\'s on the fourth page?" - read it as the developer speaking to you, ' +
    "act on the request that follows it, and do not remark on the mis-transcription.",
};

// The host resolves {env:NAME} references in option values before the plugin
// sees them (research.md R-008). When NAME is unset the reference either
// survives verbatim or collapses to an empty string; the first case lets us
// name the variable, which is the whole point of the contract's rule that an
// unset variable must not be reported as a malformed URL.
const ENV_PLACEHOLDER = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function isSupplied(value) {
  return value !== undefined && value !== null;
}

function isAbsoluteUrl(value) {
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.host);
  } catch {
    return false;
  }
}

// Returns an error message when `value` cannot serve as a URL, else null.
// Ordered so the environment-variable diagnosis wins over the URL one.
function urlProblem(option, value) {
  if (typeof value !== "string") {
    return `${option}: expected a URL string, received ${typeof value}`;
  }
  const trimmed = value.trim();
  const placeholder = ENV_PLACEHOLDER.exec(trimmed);
  if (placeholder) {
    return `${option}: environment variable ${placeholder[1]} is not set, so the host left the reference unresolved`;
  }
  if (!trimmed) {
    return `${option}: value is empty. An unset {env:NAME} reference substitutes an empty string, so check the environment variable named for this option in the host configuration`;
  }
  if (!isAbsoluteUrl(trimmed)) {
    return `${option}: "${trimmed}" is not an absolute URL. Supply a scheme and host, for example https://gateway.example/v1`;
  }
  return null;
}

// FR-008: each endpoint defaults to the other, so naming the gateway once is
// a working configuration. A supplied-but-unusable value is reported rather
// than silently replaced by its counterpart.
function resolveEndpoints(opts, errors) {
  const usable = {};
  for (const option of ["endpoint", "sttApiEndpoint"]) {
    if (!isSupplied(opts[option])) continue;
    const problem = urlProblem(option, opts[option]);
    if (problem) errors.push(problem);
    else usable[option] = opts[option].trim();
  }
  if (!isSupplied(opts.endpoint) && !isSupplied(opts.sttApiEndpoint)) {
    errors.push(
      "endpoint and sttApiEndpoint: neither is set. Set either one to the base URL of an OpenAI-compatible gateway; the other defaults to it",
    );
  }
  return {
    endpoint: usable.endpoint ?? usable.sttApiEndpoint ?? null,
    sttApiEndpoint: usable.sttApiEndpoint ?? usable.endpoint ?? null,
  };
}

function resolvePositiveInteger(option, value, fallback, errors) {
  if (!isSupplied(value)) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push(`${option}: expected a positive whole number, received ${JSON.stringify(value)}`);
    return fallback;
  }
  return value;
}

function resolveTemperature(value, errors) {
  if (!isSupplied(value)) return OPTION_DEFAULTS.temperature;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    errors.push(`temperature: expected a number from 0 to 2, received ${JSON.stringify(value)}`);
    return OPTION_DEFAULTS.temperature;
  }
  return value;
}

function resolveStringArray(option, value, fallback, errors) {
  if (!isSupplied(value)) return fallback;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${option}: expected a non-empty array of strings`);
    return fallback;
  }
  if (!value.every((entry) => typeof entry === "string" && entry.trim())) {
    errors.push(`${option}: every entry must be a non-empty string`);
    return fallback;
  }
  return value;
}

function resolveString(option, value, fallback, errors) {
  if (!isSupplied(value)) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${option}: expected a non-empty string`);
    return fallback;
  }
  return value;
}

// Continuous-listening options. Every numeric bound is validated; the silence
// threshold deliberately is not. The recorder accepts percentages and decibel
// values with its own grammar, and reimplementing that grammar here would only
// be wrong in a different way than the recorder is — a rejected threshold
// surfaces as the recorder's own error, which names the value.
function resolveListenOptions(opts, errors) {
  const resolved = {};
  for (const option of [
    "listenSilenceDurationMs",
    "listenMinSegmentMs",
    "listenMaxSegmentMs",
    "listenMaxBufferAgeMs",
    "listenMaxBufferChars",
  ]) {
    resolved[option] = resolvePositiveInteger(
      option,
      opts[option],
      LISTEN_DEFAULTS[option],
      errors,
    );
  }
  if (resolved.listenMinSegmentMs >= resolved.listenMaxSegmentMs) {
    errors.push(
      `listenMinSegmentMs (${resolved.listenMinSegmentMs}) must be less than listenMaxSegmentMs (${resolved.listenMaxSegmentMs}); as configured, every segment would be discarded as too short`,
    );
    resolved.listenMinSegmentMs = LISTEN_DEFAULTS.listenMinSegmentMs;
    resolved.listenMaxSegmentMs = LISTEN_DEFAULTS.listenMaxSegmentMs;
  }

  resolved.listenSilenceThreshold = resolveString(
    "listenSilenceThreshold",
    opts.listenSilenceThreshold,
    LISTEN_DEFAULTS.listenSilenceThreshold,
    errors,
  );
  resolved.listenTranscriptLabel = resolveString(
    "listenTranscriptLabel",
    opts.listenTranscriptLabel,
    LISTEN_DEFAULTS.listenTranscriptLabel,
    errors,
  );
  resolved.listenAutoSubmit = isSupplied(opts.listenAutoSubmit)
    ? Boolean(opts.listenAutoSubmit)
    : LISTEN_DEFAULTS.listenAutoSubmit;

  // Phrases are compiled here rather than at first use so a malformed phrase
  // set is reported at startup, when the developer can still read the message,
  // rather than at the moment they first try to talk to the agent.
  const phrases = isSupplied(opts.listenWakePhrases)
    ? opts.listenWakePhrases
    : DEFAULT_WAKE_PHRASES;
  try {
    resolved.listenWakePhrases = phrases;
    resolved.compiledWakePhrases = compilePhrases(phrases);
  } catch (err) {
    errors.push(`listenWakePhrases: ${err.message}`);
    resolved.listenWakePhrases = DEFAULT_WAKE_PHRASES;
    resolved.compiledWakePhrases = compilePhrases(DEFAULT_WAKE_PHRASES);
  }
  return resolved;
}

// Validated once at initialisation. Every message names the option that is
// wrong; nothing here throws, because a stack trace out of plugin init is
// less useful than a running plugin that reports what it cannot do.
function resolveOptions(rawOptions) {
  const opts = rawOptions ?? {};
  const errors = [];
  const resolved = {
    ...resolveEndpoints(opts, errors),
    sttApiModel: resolveString(
      "sttApiModel",
      opts.sttApiModel,
      OPTION_DEFAULTS.sttApiModel,
      errors,
    ),
    sttVocabulary: isSupplied(opts.sttVocabulary)
      ? resolveStringArray("sttVocabulary", opts.sttVocabulary, [], errors)
      : OPTION_DEFAULTS.sttVocabulary,
    sttApiInstruction: resolveString(
      "sttApiInstruction",
      opts.sttApiInstruction,
      OPTION_DEFAULTS.sttApiInstruction,
      errors,
    ),
    sttTimeoutMs: resolvePositiveInteger(
      "sttTimeoutMs",
      opts.sttTimeoutMs,
      OPTION_DEFAULTS.sttTimeoutMs,
      errors,
    ),
    model: resolveString("model", opts.model, OPTION_DEFAULTS.model, errors),
    maxTokens: resolvePositiveInteger(
      "maxTokens",
      opts.maxTokens,
      OPTION_DEFAULTS.maxTokens,
      errors,
    ),
    temperature: resolveTemperature(opts.temperature, errors),
    llmTimeoutMs: resolvePositiveInteger(
      "llmTimeoutMs",
      opts.llmTimeoutMs,
      OPTION_DEFAULTS.llmTimeoutMs,
      errors,
    ),
    credentialStorePath: resolveString(
      "credentialStorePath",
      opts.credentialStorePath,
      OPTION_DEFAULTS.credentialStorePath,
      errors,
    ),
    credentialStoreKeyPath: resolveStringArray(
      "credentialStoreKeyPath",
      opts.credentialStoreKeyPath,
      OPTION_DEFAULTS.credentialStoreKeyPath,
      errors,
    ),
    trimSilence: isSupplied(opts.trimSilence)
      ? Boolean(opts.trimSilence)
      : OPTION_DEFAULTS.trimSilence,
    ...resolveListenOptions(opts, errors),
  };
  // Unrecognised and upstream-only options pass through untouched.
  return { config: { ...opts, ...resolved }, errors };
}

function reportOptionErrors(errors, api, logger) {
  for (const message of errors) {
    logger?.log("plugin", `Configuration problem — ${message}`, "error");
    try {
      api?.ui?.toast?.({ message, variant: "error", duration: 8000 });
    } catch {
      // A failed toast must not prevent the rest of initialisation.
    }
  }
}

function loadPromptFile(filePath, logger, name) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger?.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger?.log("Plugin", `Failed to load ${name} prompt ${resolved}: ${err.message}`, "warn");
    return null;
  }
}

export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    const { kv } = api;
    const logger = createLogger(api.client);
    logger.log("plugin", "Initializing", "debug");

    const { config, errors } = resolveOptions(options);
    reportOptionErrors(errors, api, logger);

    // One resolver, shared by the correction and transcription paths, so the
    // credential is read from a single configured source. It holds no token:
    // every request calls resolve() again (FR-005, research.md R-003).
    const credentials = createCredentialResolver({
      storePath: config.credentialStorePath,
      storeKeyPath: config.credentialStoreKeyPath,
      envVar: config.apiKeyEnv,
    });
    logger.log("plugin", `Credential sources — ${credentials.describe()}`, "debug");

    const { complete } = createClient(config, logger, credentials);

    const prompts = {
      stt: loadPromptFile(config.sttPrompt, logger, "STT"),
      ttsAuto: loadPromptFile(config.ttsAutoPrompt, logger, "TTS auto"),
      ttsManual: loadPromptFile(config.ttsManualPrompt, logger, "TTS manual"),
    };

    const sttCommands = registerSTT(api, kv, complete, prompts, config, logger, credentials);
    const ttsCommands = registerTTS(api, kv, complete, prompts, logger);
    const listen = registerListen(api, kv, config, logger);

    api.command.register(() => [...sttCommands, ...ttsCommands, ...listen.commands]);

    // Capture cleanup on the way out: no recorder and no recording of the
    // user's voice may survive the editor (FR-018).
    //
    // Two registrations, because they cover different exits. The editor's own
    // dispose hook can await a graceful stop. The process "exit" hook cannot
    // await anything, so it kills and unlinks synchronously, and it still runs
    // when the editor tears the plugin down without calling dispose, and on an
    // uncaught exception.
    //
    // The listening session is stopped before the drain rather than left to
    // it. Killing its recorder is not enough: the session's loop would see the
    // exit as an ordinary segment boundary and spawn the next recorder.
    const disposeCaptures = async () => {
      await listen.dispose();
      await stopActiveCapture(logger);
      removeCaptureDir(logger);
    };
    if (typeof api.lifecycle?.onDispose === "function") {
      api.lifecycle.onDispose(disposeCaptures);
    } else {
      logger.log(
        "PLUGIN",
        "Host exposes no lifecycle.onDispose; capture cleanup rests on the process exit hook",
        "debug",
      );
    }
    process.once("exit", disposeCapturesSync);

    // A terminated signal is not covered by the hook above. Node's default
    // disposition for SIGTERM, SIGINT and SIGHUP ends the process without
    // running "exit" handlers, and a SIGTERM to the editor was measured to
    // leave both the capture directory and an orphaned recorder behind.
    //
    // Adding a signal listener suppresses that default disposition, so each
    // handler restores it by re-raising the signal on itself after cleaning
    // up, which preserves the exit code the host would otherwise have had. If
    // another listener is already installed, the host has taken charge of its
    // own shutdown and this one only cleans up, leaving the decision alone.
    //
    // SIGKILL cannot be handled by anyone and is therefore not covered here.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      const onSignal = () => {
        disposeCapturesSync();
        if (process.listenerCount(signal) === 1) {
          process.removeListener(signal, onSignal);
          process.kill(process.pid, signal);
        }
      };
      process.on(signal, onSignal);
    }
  },
};
