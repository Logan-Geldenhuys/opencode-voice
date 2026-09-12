// Continuous listening: one recorder per utterance, a buffer of what was said,
// and a spoken phrase that hands the buffer to the agent.
//
// See specs/002-continuous-wake-phrase/. The design decision this file is
// organised around is that each recorder captures exactly one utterance and
// then exits. A long-lived recorder writing a new file at each pause was the
// obvious alternative and was measured against this one: the two cut the audio
// at the identical sample, but the long-lived form signals completion by
// opening the next file, which means inferring that the previous one is
// finished, and it leaves a 44-byte bare-header placeholder that is
// indistinguishable by existence from a real segment (research.md R-101).
//
// A process that exits says the same thing with a guarantee behind it: the
// kernel closes the descriptor, flushes the buffer and finalises the header
// before the exit is delivered. So the recorder's exit is the segment
// boundary, and this file contains no directory watcher, no sequence-number
// parsing, and no rule about a file having stopped growing.

import fs from "node:fs";
import { spawn } from "node:child_process";

import {
  createCapture,
  liveCaptureOwner,
  nextCapturePath,
  ownedCapture,
  registerCapture,
  stopOwnedCapture,
  unregisterCapture,
} from "./capture.js";
import {
  audioFailureSuffix,
  buildRecordArgs,
  describeAudioFault,
  detectAudioBackend,
  transcribeApi,
} from "./stt.js";
import { findWake, INTERRUPT_SUBMIT } from "./wake.js";

export const LISTENING = "continuous listening";

// Enough consecutive failures to mean the microphone is producing nothing
// usable rather than that one request was unlucky. Dropping every segment in
// silence satisfies FR-019 to the letter while leaving the developer talking
// to a recording that is going nowhere, so the run is escalated even though
// each individual failure is not (contracts/commands.md).
const FAILURE_ESCALATION = 3;

// ---- Segmentation ----------------------------------------------------------

/**
 * sox arguments for one utterance.
 *
 * The trailing `silence` clause does two jobs in one pass. `1 0.1 <threshold>`
 * discards leading silence, so the recorder waits for speech and the file
 * starts at the first word. `1 <duration> <threshold>` ends the recording once
 * the speaker has been quiet for that long, at which point sox exits.
 *
 * Because leading silence is trimmed, the gap between one recorder exiting and
 * the next reaching its first sample lands inside a pause the speaker is
 * already taking. The gap was measured at roughly 130ms against a configured
 * pause of 700ms.
 */
export function buildListenArgs(inputArgs, audioPath, { silenceDurationMs, silenceThreshold }) {
  const seconds = (silenceDurationMs / 1000).toFixed(2);
  return [
    ...inputArgs,
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    audioPath,
    "silence",
    "1",
    "0.1",
    silenceThreshold,
    "1",
    seconds,
    silenceThreshold,
  ];
}

/**
 * Duration of a captured WAV in milliseconds, from its header.
 *
 * Reading the header rather than timing the recorder measures the audio that
 * exists rather than how long the process lived, which differ by the pause the
 * recorder sat through before the speaker started.
 */
export function wavDurationMs(audioPath) {
  let fd;
  try {
    fd = fs.openSync(audioPath, "r");
    const header = Buffer.alloc(44);
    if (fs.readSync(fd, header, 0, 44, 0) < 44) return 0;
    if (header.toString("ascii", 0, 4) !== "RIFF") return 0;
    const byteRate = header.readUInt32LE(28);
    const dataBytes = fs.fstatSync(fd).size - 44;
    if (!byteRate || dataBytes <= 0) return 0;
    return Math.round((dataBytes / byteRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---- Buffer ----------------------------------------------------------------

/**
 * Drop entries until both bounds hold, oldest first.
 *
 * Eviction removes whole entries and never part of one. An entry is the unit
 * the tokeniser works on and its token spans index into its own text, so
 * trimming characters off the front would leave those spans pointing at text
 * that is no longer there (FR-014).
 *
 * @param {{text: string, capturedAt: number}[]} entries
 */
export function evictExpired(entries, { maxAgeMs, maxChars, now = Date.now() }) {
  let kept = entries.filter((entry) => now - entry.capturedAt <= maxAgeMs);
  let chars = kept.reduce((total, entry) => total + entry.text.length, 0);
  while (kept.length > 1 && chars > maxChars) {
    chars -= kept[0].text.length;
    kept = kept.slice(1);
  }
  return kept;
}

// ---- Session ---------------------------------------------------------------

/** Spawn the recorder. The default, and the only one production uses. */
function spawnSox(args) {
  return spawn("sox", args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
}

/**
 * Create the listening session. One per plugin load; it is turned on and off
 * rather than constructed and discarded, so the commands have something stable
 * to talk to.
 *
 * `spawnRecorder` and `transcribe` are the session's two external effects, and
 * they are parameters so that the loop's own rules — the duration gate, the
 * failure escalation, the buffer ordering, the promise that audio is deleted on
 * both paths — can be tested without a microphone or a network. Production
 * passes neither.
 */
export function createListener({
  api,
  kv,
  config,
  logger,
  toast,
  backend,
  spawnRecorder = spawnSox,
  transcribe = transcribeApi,
}) {
  const client = api.client;
  const abort = new AbortController();

  let active = false;
  let startedAt = null;
  let loop = null;
  let entries = [];
  let segments = 0;
  let consecutiveFailures = 0;
  // Guards the window between deciding to submit and having replaced the
  // buffer. Nothing awaits inside it; see submit().
  let submitting = false;

  const bounds = () => ({
    maxAgeMs: config.listenMaxBufferAgeMs,
    maxChars: config.listenMaxBufferChars,
  });

  function announce(message, variant = "info") {
    logger?.log("Listen", message, variant === "error" ? "error" : "debug");
    toast(message, variant);
  }

  // --- one utterance --------------------------------------------------------

  async function captureOne() {
    const audioPath = nextCapturePath(logger);
    // Pre-created 0600 so the recording is owner-only from the moment the file
    // exists; sox truncates it and leaves the mode alone.
    fs.writeFileSync(audioPath, "", { mode: 0o600 });

    const mic = kv.get("stt.mic", "") || null;
    const args = buildListenArgs(buildRecordArgs(backend, mic), audioPath, {
      silenceDurationMs: config.listenSilenceDurationMs,
      silenceThreshold: config.listenSilenceThreshold,
    });
    const child = spawnRecorder(args, audioPath);
    const capture = registerCapture(
      createCapture({ process: child, path: audioPath, logger }),
      LISTENING,
    );

    // The maximum duration is one timer calling the ordinary stop, so the
    // recorder exits down the same path a pause would have taken it. It is not
    // a second segmentation mechanism and needs no separate completion
    // handling.
    const cap = setTimeout(() => {
      if (capture.running) {
        logger?.log("Listen", `Segment reached ${config.listenMaxSegmentMs}ms; stopping`, "debug");
        capture.stop();
      }
    }, config.listenMaxSegmentMs);
    cap.unref?.();

    try {
      await capture.exited;
    } finally {
      clearTimeout(cap);
    }
    return capture;
  }

  async function handleSegment(capture) {
    const capturedAt = Date.now();
    try {
      if (abort.signal.aborted) return;

      const durationMs = wavDurationMs(capture.path);
      if (durationMs < config.listenMinSegmentMs) {
        // The cost gate. Nothing below the threshold becomes a paid request,
        // which is what makes a cough free (FR-015, SC-005).
        logger?.log("Listen", `Segment ${durationMs}ms below minimum; discarded`, "debug");
        return;
      }

      segments += 1;
      const result = await transcribe(kv, capture.path, logger, abort.signal);
      if (result.aborted) return;

      if (result.error) {
        consecutiveFailures += 1;
        logger?.log(
          "Listen",
          `Segment transcription failed (${consecutiveFailures} in a row): ${result.error}`,
          "warn",
        );
        // A single failure costs one segment and is not worth breaking
        // concentration for. A run of them means the developer is talking to
        // nothing, which they cannot discover any other way.
        if (consecutiveFailures === FAILURE_ESCALATION) {
          announce(
            `Transcription has failed ${consecutiveFailures} times in a row; speech is not reaching the agent. ${result.error}`,
            "error",
          );
        }
        return;
      }

      consecutiveFailures = 0;
      const text = (result.text || "").trim();
      if (!text) return;

      append(text, capturedAt);
      await detect();
    } finally {
      // Both paths, always: the recording of a developer's voice does not
      // outlive the request it was made for (FR-018).
      capture.removeAudio();
      unregisterCapture(capture);
    }
  }

  async function run() {
    while (active && !abort.signal.aborted) {
      let capture;
      try {
        capture = await captureOne();
      } catch (err) {
        if (!active) break;
        announce(`Listening stopped: ${err.message}${audioFailureSuffix(backend)}`, "error");
        active = false;
        break;
      }

      const { code, signal } = capture.exitInfo ?? {};
      // A recorder stopped by us exits on a signal; one that failed to start or
      // died on its own exits non-zero with nothing recorded.
      if (code !== 0 && code !== null && capture.state === "recording") {
        capture.removeAudio();
        unregisterCapture(capture);
        if (!active || abort.signal.aborted) break;
        const errLine = capture.stderr.split("\n").filter(Boolean).pop();
        announce(
          `Listening stopped: ${errLine || `the recorder exited (code=${code}${signal ? `, ${signal}` : ""})`}${audioFailureSuffix(backend)}`,
          "error",
        );
        active = false;
        break;
      }

      await handleSegment(capture);
    }
  }

  // --- buffer and submission ------------------------------------------------

  function append(text, capturedAt) {
    entries.push({ text, capturedAt });
    entries = evictExpired(entries, bounds());
  }

  async function detect() {
    if (submitting) return;
    const texts = entries.map((entry) => entry.text);
    const hit = findWake(texts, config.compiledWakePhrases);
    if (!hit) return;
    await submit(hit);
  }

  async function submit(hit) {
    submitting = true;
    let prompt;
    try {
      // Everything that mutates the buffer happens here, before the first
      // await, in one synchronous run. Appends only ever happen in a
      // continuation after an await, so by the time anything can be appended
      // the buffer is already empty and `prompt` is a value that no longer
      // aliases it. The window a lock would have guarded does not exist
      // (research.md R-109).
      const now = Date.now();
      const kept = evictExpired(entries, { ...bounds(), now });
      const expired = kept.length !== entries.length;
      entries = kept;

      const texts = entries.map((entry) => entry.text);
      const found = findWake(texts, config.compiledWakePhrases) ?? hit;

      // The buffer is sent verbatim, wake phrase and all. The phrase is how
      // the developer addresses the agent directly, so leaving it in is what
      // distinguishes an instruction from the thinking-aloud around it: "the
      // parser is probably fine, hey nome execute, fix the failing test" is one
      // prompt in which only the second half is a request. Cutting the phrase out
      // would destroy that marker and leave the agent to guess.
      //
      // `before` and `after` are still what says whether anything was said
      // besides the phrase itself.
      const spoken = texts.join(" ").trim();
      const besidesPhrase = `${found.before} ${found.after}`.trim();

      entries = [];

      if (!besidesPhrase) {
        announce(
          expired
            ? "Nothing to send: the buffered speech was dropped by a buffer bound before the phrase was spoken."
            : "Nothing to send: no speech has been buffered since the last submission.",
          "warning",
        );
        return;
      }
      prompt = `${config.listenTranscriptLabel}\n\n${spoken}`;

      if (found.action === INTERRUPT_SUBMIT) {
        // Ordered before the prompt reaches the editor so the agent is already
        // stopping when the new instruction lands. An idle agent is not an
        // error: the phrase means "stop if you are working", not "you must be
        // working".
        interrupt();
      }
    } finally {
      submitting = false;
    }

    if (!prompt) return;
    await deliver(prompt);
  }

  function interrupt() {
    const sessionID = api.route?.current?.params?.sessionID;
    if (!sessionID) {
      logger?.log("Listen", "Interrupt skipped: no active session", "debug");
      return;
    }
    // Not awaited: the abort is a request to the agent, and the prompt must
    // not wait on it. A failed abort still leaves the submission to make.
    Promise.resolve(client.session.abort({ sessionID }))
      .then(() => logger?.log("Listen", "Aborted the active session", "debug"))
      .catch((err) => {
        logger?.log("Listen", `Abort failed: ${err.message}`, "warn");
        toast(
          `Could not stop the agent: ${err.message}. Sending the transcript anyway.`,
          "warning",
        );
      });
  }

  async function deliver(prompt) {
    try {
      let result = await client.tui.appendPrompt({ body: { text: prompt } });
      if (result?.error?.data?.message === "Expected object, got undefined") {
        result = await client.tui.appendPrompt({ text: prompt });
      }
      if (config.listenAutoSubmit) {
        await client.tui.submitPrompt();
        announce("Sent the transcript to the agent.");
      } else {
        announce("Transcript placed in the prompt; press enter to send it.");
      }
    } catch (err) {
      // The buffer is already gone, so say what happened to it rather than
      // pretending the text can be recovered.
      announce(`Could not deliver the transcript: ${err.message}`, "error");
    }
  }

  // --- control --------------------------------------------------------------

  async function start() {
    if (active) return false;
    const holder = liveCaptureOwner();
    if (holder && holder !== LISTENING) {
      // One shared record of what is capturing, so this refusal and dictation's
      // cannot disagree with each other or with the operating system (FR-017).
      toast(`${holder} is using the microphone. Stop it first (/stt-stop).`, "warning");
      return false;
    }
    // Checked once per session rather than once per utterance. The fault is a
    // missing device, which does not appear and disappear between sentences,
    // and a server round-trip before every segment would buy nothing.
    const fault = describeAudioFault(backend, kv.get("stt.mic", "") || null);
    if (fault) {
      logger?.log("Listen", `Listening refused: ${fault}`, "warn");
      toast(fault, "error");
      return false;
    }
    active = true;
    startedAt = Date.now();
    consecutiveFailures = 0;
    announce("Listening. Say your wake phrase to send what you have said to the agent.");
    loop = run().catch((err) => {
      active = false;
      logger?.log("Listen", `Listening loop failed: ${err.message}`, "error");
      toast(`Listening stopped: ${err.message}`, "error");
    });
    return true;
  }

  async function stop({ announceStop = true } = {}) {
    if (!active) return false;
    active = false;
    startedAt = null;
    await stopOwnedCapture(LISTENING, logger);
    await loop;
    loop = null;
    entries = [];
    segments = 0;
    if (announceStop) announce("Stopped listening. Buffered speech discarded.");
    return true;
  }

  return {
    get active() {
      return active;
    },
    start,
    stop,
    async toggle() {
      return active ? stop() : start();
    },
    discard() {
      const had = entries.length;
      entries = [];
      return had;
    },
    status() {
      const kept = evictExpired(entries, bounds());
      const oldest = kept[0]?.capturedAt ?? null;
      return {
        active,
        listeningForMs: startedAt === null ? null : Date.now() - startedAt,
        segments,
        entries: kept.length,
        chars: kept.reduce((total, entry) => total + entry.text.length, 0),
        oldestAgeMs: oldest === null ? null : Date.now() - oldest,
        text: kept.map((entry) => entry.text).join(" "),
        // The canonical form of each phrase, not every accepted variant. The
        // variants exist so the recogniser's mistakes still match; reciting
        // them back would answer a question nobody asked.
        phrases: [...new Map(config.compiledWakePhrases.map((p) => [p.canonical, p.action]))].map(
          ([phrase, action]) => ({ phrase, action }),
        ),
        transcribing: Boolean(ownedCapture(LISTENING)),
      };
    },
    // Teardown aborts in-flight requests rather than awaiting them, and stops
    // the recorder through the registry's handle (FR-020).
    async dispose() {
      abort.abort();
      await stop({ announceStop: false });
    },
  };
}

// ---- Presentation ----------------------------------------------------------

function formatDuration(ms) {
  if (ms === null) return "unknown";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * The status command's whole output, from the session's own report.
 *
 * There is no separate command to inspect the buffer. The difference between
 * the two was one field, and two commands reading the same state can disagree
 * about it (contracts/commands.md).
 */
export function formatStatus(status) {
  const phrases = status.phrases
    .map((p) => `"${p.phrase}" (${p.action === INTERRUPT_SUBMIT ? "interrupt and send" : "send"})`)
    .join(", ");

  if (!status.active) {
    return `Not listening. Wake phrases: ${phrases}.`;
  }

  const lines = [
    `Listening for ${formatDuration(status.listeningForMs)}.`,
    `${status.segments} utterance${status.segments === 1 ? "" : "s"} captured, ${status.entries} buffered (${status.chars} characters).`,
  ];
  if (status.oldestAgeMs !== null) {
    lines.push(`Oldest buffered speech: ${formatDuration(status.oldestAgeMs)} ago.`);
  }
  if (status.transcribing) lines.push("A transcription is in flight.");
  lines.push(`Wake phrases: ${phrases}.`);
  if (status.text) lines.push(`Buffered: ${status.text}`);
  return lines.join("\n");
}

/**
 * Build the listening session and the commands that drive it.
 *
 * Mirrors registerSTT: the caller passes the plugin surface in and gets
 * commands back, plus the teardown hook, because the session owns a loop that
 * has to be told to stop rather than merely having its recorder killed.
 */
export function registerListen(api, kv, config, logger) {
  const toast = (message, variant = "info") => api.ui.toast({ message, variant, duration: 3000 });
  const listener = createListener({
    api,
    kv,
    config,
    logger,
    toast,
    backend: detectAudioBackend(),
  });

  const commands = [
    {
      title: "Listen: toggle continuous listening",
      value: "listen.toggle",
      description:
        "Transcribe continuously; a spoken wake phrase sends the transcript to the agent",
      category: "Voice",
      keybind: "alt+shift+r",
      slash: { name: "listen-toggle" },
      onSelect: () => {
        listener.toggle();
      },
    },
    {
      title: "Listen: status",
      value: "listen.status",
      description: "Whether listening is active, and what is buffered",
      category: "Voice",
      slash: { name: "listen-status" },
      onSelect: () => {
        toast(formatStatus(listener.status()));
      },
    },
    {
      title: "Listen: discard buffer",
      value: "listen.discard",
      description: "Throw away buffered speech without sending it; keep listening",
      category: "Voice",
      slash: { name: "listen-discard" },
      onSelect: () => {
        const dropped = listener.discard();
        toast(
          dropped
            ? `Discarded ${dropped} buffered utterance${dropped === 1 ? "" : "s"}.${listener.active ? " Still listening." : ""}`
            : "Nothing buffered to discard.",
        );
      },
    },
  ];

  return { commands, listener, dispose: () => listener.dispose() };
}
