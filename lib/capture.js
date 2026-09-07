// Audio capture ownership: the temporary directory, the filename sequence, the
// record of what is currently live, and the two teardown drains.
//
// Extracted from lib/stt.js rather than invented here. Feature 001 built the
// capture object correctly but kept the record of what was live as a single
// module-scoped slot inside the dictation module, which made every capture
// created anywhere else invisible to teardown. Two requirements rest on that
// record being shared: FR-020, which says nothing survives editor exit, and
// FR-017, which refuses a second capture mode by consulting one fact rather
// than a flag in each module. See specs/002-continuous-wake-phrase/research.md
// R-108.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SIGINT gives sox the chance to finalise the WAV header, so a normal stop
// leaves a playable file. The escalation windows are bounded rather than
// unbounded because a recorder that will not die must not wedge the editor.
const STOP_GRACE_MS = 2000;
const TERMINATE_GRACE_MS = 1000;

let captureDir = null;
let captureSequence = 0;

// capture -> owner label. A map rather than a set because a refusal has to
// name the mode already holding the microphone, and a set would only be able
// to say that something does.
const live = new Map();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// A distinct file per capture, so a previous recording can never be
// transcribed in place of the current one. Continuous listening makes this
// load-bearing rather than defensive: segments follow each other closely
// enough that a fixed path would let one recorder truncate the audio the
// previous segment is still uploading.
export function buildCapturePath(dir, sequence) {
  return path.join(dir, `capture-${String(sequence).padStart(3, "0")}.wav`);
}

// Created once per plugin load and restricted to the owner by the same syscall
// that creates it: mkdtemp(3) makes the directory 0700 atomically, leaving no
// window in which a recording of the user's voice is readable by other
// accounts on the host.
export function ensureCaptureDir(logger) {
  if (captureDir && fs.existsSync(captureDir)) return captureDir;
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-"), { mode: 0o700 });
  logger?.log("Capture", `Capture directory=${captureDir}`, "debug");
  return captureDir;
}

// The next unused path in the capture directory, creating the directory if it
// does not exist yet. Both capture modes call this rather than composing the
// directory and the sequence themselves, so the sequence cannot be advanced by
// one mode without the other seeing it.
export function nextCapturePath(logger) {
  return buildCapturePath(ensureCaptureDir(logger), ++captureSequence);
}

// Called when the editor disposes the plugin, so the directory does not
// accumulate across sessions.
export function removeCaptureDir(logger) {
  if (!captureDir) return;
  const dir = captureDir;
  captureDir = null;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger?.log("Capture", `Removed capture directory ${dir}`, "debug");
  } catch (err) {
    logger?.log("Capture", `Failed to remove capture directory ${dir}: ${err.message}`, "warn");
  }
}

/**
 * Wrap an already-spawned recorder so the object, not the module, owns it.
 *
 * Exported so the termination path can be exercised against any long-lived
 * child process, with no microphone involved.
 *
 * @param {object} args
 * @param {import("node:child_process").ChildProcess} args.process
 * @param {string} args.path - This capture's own audio file
 * @param {{ log?: Function }} [args.logger]
 */
export function createCapture({ process: child, path: audioPath, logger }) {
  let stderr = "";
  let exitInfo = null;

  const exited = new Promise((resolve) => {
    const settle = (info) => {
      if (!exitInfo) exitInfo = info;
      resolve(exitInfo);
    };
    child.on("exit", (code, signal) => settle({ code, signal, error: null }));
    child.on("error", (error) => settle({ code: null, signal: null, error }));
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  async function signalAndWait(signal, timeoutMs) {
    if (exitInfo) return exitInfo;
    try {
      child.kill(signal);
    } catch {}
    return await Promise.race([exited, delay(timeoutMs).then(() => null)]);
  }

  const cap = {
    process: child,
    path: audioPath,
    state: "recording",
    exited,
    get stderr() {
      return stderr.trim();
    },
    get exitInfo() {
      return exitInfo;
    },
    get running() {
      return exitInfo === null;
    },

    // Graceful stop, escalating only if the recorder does not take the hint.
    async stop() {
      if (cap.state === "recording") cap.state = "stopping";
      const info = await signalAndWait("SIGINT", STOP_GRACE_MS);
      if (info) return info;
      logger?.log("Capture", `Capture pid=${child.pid} ignored SIGINT`, "warn");
      return await cap.terminate();
    },

    // The tracked handle is the only termination target. Matching on a command
    // line, as `pkill -f 'sox.*opencode-stt'` did, can kill an unrelated
    // process the same user happens to be running.
    async terminate() {
      let info = await signalAndWait("SIGTERM", TERMINATE_GRACE_MS);
      if (!info) {
        logger?.log("Capture", `Capture pid=${child.pid} ignored SIGTERM, sending SIGKILL`, "warn");
        info = await signalAndWait("SIGKILL", TERMINATE_GRACE_MS);
      }
      if (!info) logger?.log("Capture", `Capture pid=${child.pid} survived SIGKILL`, "error");
      cap.state = "terminated";
      return info;
    },

    // Removed on the success path and the failure path alike: an audio file
    // that outlives its capture is a recording of the user's voice left behind
    // on disk.
    removeAudio() {
      try {
        fs.unlinkSync(cap.path);
        logger?.log("Capture", `Removed capture audio ${cap.path}`, "debug");
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger?.log(
            "Capture",
            `Failed to remove capture audio ${cap.path}: ${err.message}`,
            "warn",
          );
        }
      }
    },
  };

  return cap;
}

// ---- The live-capture registry ----
//
// A capture is registered for as long as either its process or its audio file
// still needs cleaning up. That is deliberately wider than "the recorder is
// running": the audio outlives the recorder by the length of a transcription
// request, and a plugin disposed during that window must still remove it.

/**
 * @param {object} cap - A capture from createCapture()
 * @param {string} owner - The mode holding it, used verbatim in refusals
 */
export function registerCapture(cap, owner) {
  live.set(cap, owner);
  return cap;
}

// Harmless when the capture was never registered or was already drained, so
// callers can unregister unconditionally on their own cleanup path.
export function unregisterCapture(cap) {
  return live.delete(cap);
}

export function isRegistered(cap) {
  return live.has(cap);
}

export function liveCaptureCount() {
  return live.size;
}

// The mode currently holding a capture, or null. This is the whole of the
// mode-exclusion check (FR-017): one fact, read by both modes, so they cannot
// disagree about whether the microphone is in use.
export function liveCaptureOwner() {
  for (const owner of live.values()) return owner;
  return null;
}

// The capture belonging to a given mode, or null. Replaces the module-scoped
// slot each mode would otherwise keep for itself.
export function ownedCapture(owner) {
  for (const [cap, label] of live) {
    if (label === owner) return cap;
  }
  return null;
}

// Stop and clean up every live capture. Safe to call when there are none.
export async function stopActiveCapture(logger) {
  const entries = [...live.keys()];
  live.clear();
  for (const active of entries) {
    logger?.log("Capture", `Stopping active capture pid=${active.process.pid}`, "debug");
    await active.terminate();
    active.removeAudio();
  }
}

/**
 * Stop and clean up one mode's capture, leaving any other mode's alone.
 *
 * The indiscriminate drain above is right for teardown, where reaching
 * everything is the point. It is wrong for a user-invoked cancel command,
 * which should not reach past the mode whose command was invoked.
 *
 * @returns {Promise<boolean>} whether there was one to stop
 */
export async function stopOwnedCapture(owner, logger) {
  const active = ownedCapture(owner);
  if (!active) return false;
  live.delete(active);
  logger?.log("Capture", `Stopping ${owner} capture pid=${active.process.pid}`, "debug");
  await active.terminate();
  active.removeAudio();
  return true;
}

// Synchronous counterpart of the drain above, for the process "exit" hook. By
// then the event loop is closing, so a promise will never settle and only
// blocking calls still run: kill outright and unlink in place.
//
// Every live capture, not the most recent one. A continuous session and a
// dictation capture can both be registered, and draining one of them would
// leave the other's recorder running against a dead editor.
export function disposeCapturesSync() {
  const entries = [...live.keys()];
  live.clear();
  for (const active of entries) {
    try {
      active.process.kill("SIGKILL");
    } catch {}
    try {
      fs.unlinkSync(active.path);
    } catch {}
  }
  if (captureDir) {
    const dir = captureDir;
    captureDir = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// Test seam. Nothing in the plugin calls this: the registry and the sequence
// are process-global by design, which is exactly what makes them unusable as
// test fixtures without a way to reset them.
export function resetCaptureStateForTests() {
  live.clear();
  captureDir = null;
  captureSequence = 0;
}
