import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  buildListenArgs,
  createListener,
  evictExpired,
  formatStatus,
  LISTENING,
  wavDurationMs,
} from "../lib/listen.js";
import {
  createCapture,
  disposeCapturesSync,
  liveCaptureCount,
  liveCaptureOwner,
  registerCapture,
  resetCaptureStateForTests,
} from "../lib/capture.js";
import { compilePhrases, DEFAULT_WAKE_PHRASES } from "../lib/wake.js";

const CONFIG = {
  listenSilenceDurationMs: 700,
  listenSilenceThreshold: "2%",
  listenMinSegmentMs: 400,
  listenMaxSegmentMs: 30000,
  listenMaxBufferAgeMs: 3600000,
  listenMaxBufferChars: 64000,
  listenAutoSubmit: true,
  listenTranscriptLabel: "VOICE TRANSCRIPT.",
  compiledWakePhrases: compilePhrases(DEFAULT_WAKE_PHRASES),
};

// ---- Harness ---------------------------------------------------------------

/**
 * A recorder stand-in that writes a WAV of a given duration and exits, which
 * is the whole of what the session depends on a recorder doing.
 */
function fakeRecorder(durationsMs) {
  const spawned = [];
  const queue = [...durationsMs];
  const spawnRecorder = (args, audioPath) => {
    spawned.push({ args, audioPath });
    const ms = queue.length ? queue.shift() : 0;
    if (ms === "fail") {
      return spawn(process.execPath, [
        "-e",
        "process.stderr.write('sox: no such device\\n'); process.exit(2)",
      ]);
    }
    writeWav(audioPath, ms);
    // Exits immediately, having produced the file, exactly as sox does when the
    // speaker pauses.
    return spawn(process.execPath, ["-e", ""]);
  };
  return { spawnRecorder, spawned };
}

function writeWav(target, durationMs) {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;
  const dataBytes = Math.round((durationMs / 1000) * byteRate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(target, Buffer.concat([header, Buffer.alloc(dataBytes)]));
}

function harness({
  config = {},
  durations = [],
  transcripts = [],
  autoSubmit = true,
  sessionID = "ses_test",
  abortFails = false,
} = {}) {
  const toasts = [];
  const appended = [];
  const submitted = [];
  const aborted = [];
  const requested = [];
  const { spawnRecorder, spawned } = fakeRecorder(durations);
  const queue = [...transcripts];

  const transcribe = async (_kv, audioPath) => {
    requested.push(audioPath);
    const next = queue.length ? queue.shift() : { text: "" };
    return next;
  };

  const api = {
    client: {
      tui: {
        appendPrompt: async (body) => appended.push(body),
        submitPrompt: async () => submitted.push(true),
      },
      session: {
        abort: async (params) => {
          aborted.push(params);
          if (abortFails) throw new Error("the agent would not stop");
        },
      },
    },
    route: sessionID ? { current: { params: { sessionID } } } : { current: null },
    ui: { toast: () => {} },
  };

  const listener = createListener({
    api,
    kv: { get: (_key, fallback) => fallback },
    config: { ...CONFIG, listenAutoSubmit: autoSubmit, ...config },
    logger: null,
    toast: (message, variant = "info") => toasts.push({ message, variant }),
    backend: "pulseaudio",
    spawnRecorder,
    transcribe,
  });

  return { listener, api, toasts, appended, submitted, aborted, requested, spawned };
}

// setTimeout rather than setImmediate: the session waits on real child
// processes exiting, and a setImmediate spin never yields to the poll phase
// where those exits are delivered.
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await tick();
}

/** Let everything that follows the last transcription settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await tick();
}

/**
 * Run the session until it has transcribed `requests` segments and everything
 * that follows from the last one has settled, then stop it.
 *
 * The wait is on requests rather than on recorders because a recorder's exit
 * only starts the work a test is looking for.
 */
async function runFor(h, requests) {
  await h.listener.start();
  await until(() => h.requested.length >= requests);
  await settle();
  await h.listener.stop();
}

/** Run until `count` recorders have been spawned, for segments never sent. */
async function runSpawns(h, count) {
  await h.listener.start();
  await until(() => h.spawned.length >= count);
  await settle();
  await h.listener.stop();
}

test.afterEach(() => {
  disposeCapturesSync();
  resetCaptureStateForTests();
});

// ---- buildListenArgs -------------------------------------------------------

test("the recorder is told to stop after the configured pause", () => {
  const args = buildListenArgs(["-t", "pulseaudio", "default"], "/tmp/a.wav", {
    silenceDurationMs: 700,
    silenceThreshold: "2%",
  });
  assert.deepEqual(args, [
    "-t",
    "pulseaudio",
    "default",
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    "/tmp/a.wav",
    "silence",
    "1",
    "0.1",
    "2%",
    "1",
    "0.70",
    "2%",
  ]);
});

test("leading silence is trimmed, which is what hides the gap between recorders", () => {
  const args = buildListenArgs(["-d"], "/tmp/a.wav", {
    silenceDurationMs: 1500,
    silenceThreshold: "3%",
  });
  const at = args.indexOf("silence");
  // The first clause discards silence before speech; the second ends the take.
  assert.deepEqual(args.slice(at, at + 4), ["silence", "1", "0.1", "3%"]);
  assert.deepEqual(args.slice(at + 4), ["1", "1.50", "3%"]);
});

// ---- wavDurationMs ---------------------------------------------------------

test("segment duration comes from the audio, not from the recorder's lifetime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listen-test-"));
  const file = path.join(dir, "a.wav");
  writeWav(file, 1500);
  assert.equal(wavDurationMs(file), 1500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a header-only or missing file measures as no audio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listen-test-"));
  const empty = path.join(dir, "empty.wav");
  writeWav(empty, 0);
  assert.equal(wavDurationMs(empty), 0);
  assert.equal(wavDurationMs(path.join(dir, "absent.wav")), 0);
  fs.writeFileSync(path.join(dir, "junk.wav"), "not a wav file at all, but long enough");
  assert.equal(wavDurationMs(path.join(dir, "junk.wav")), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- evictExpired ----------------------------------------------------------

test("speech older than the age bound never survives to be submitted", () => {
  const now = 10_000_000;
  const kept = evictExpired(
    [
      { text: "old", capturedAt: now - 5000 },
      { text: "recent", capturedAt: now - 100 },
    ],
    { maxAgeMs: 1000, maxChars: 64000, now },
  );
  assert.deepEqual(
    kept.map((e) => e.text),
    ["recent"],
  );
});

test("the size bound evicts whole utterances, oldest first, and never part of one", () => {
  const now = 10_000_000;
  const kept = evictExpired(
    [
      { text: "aaaaa", capturedAt: now - 300 },
      { text: "bbbbb", capturedAt: now - 200 },
      { text: "ccccc", capturedAt: now - 100 },
    ],
    { maxAgeMs: 3600000, maxChars: 12, now },
  );
  // Two entries fit in twelve characters; the oldest goes, intact.
  assert.deepEqual(
    kept.map((e) => e.text),
    ["bbbbb", "ccccc"],
  );
});

test("the newest utterance is kept even when it alone exceeds the size bound", () => {
  const now = 10_000_000;
  const kept = evictExpired([{ text: "x".repeat(50), capturedAt: now }], {
    maxAgeMs: 3600000,
    maxChars: 10,
    now,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text.length, 50);
});

// ---- the duration gate -----------------------------------------------------

test("a sound shorter than the minimum costs nothing", async () => {
  const h = harness({ durations: [100, 100], transcripts: [] });
  await runSpawns(h, 2);
  assert.equal(h.requested.length, 0, "no transcription request may be issued");
  assert.equal(h.listener.status().segments, 0);
});

test("a sound at or above the minimum is transcribed", async () => {
  const h = harness({ durations: [1000], transcripts: [{ text: "hello there" }] });
  await runFor(h, 1);
  assert.equal(h.requested.length, 1);
});

test("the maximum duration stops the recorder through the ordinary stop path", async () => {
  const stopped = [];
  // A recorder that would run forever, so only the duration cap can end it.
  const listener = createListener({
    api: { client: { tui: {}, session: {} }, ui: { toast: () => {} } },
    kv: { get: (_k, f) => f },
    config: { ...CONFIG, listenMaxSegmentMs: 20 },
    logger: null,
    toast: () => {},
    backend: "pulseaudio",
    spawnRecorder: () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
      stopped.push(child);
      return child;
    },
    transcribe: async () => ({ text: "" }),
  });
  await listener.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await listener.stop();
  assert.ok(stopped.length >= 1, "the recorder was started");
  assert.ok(stopped[0].killed || stopped[0].exitCode !== null, "and was stopped, not left running");
});

// ---- audio hygiene ---------------------------------------------------------

test("segment audio is deleted after a successful transcription", async () => {
  const h = harness({ durations: [1000], transcripts: [{ text: "some words" }] });
  await runFor(h, 1);
  assert.ok(h.spawned.length >= 1);
  for (const { audioPath } of h.spawned) assert.equal(fs.existsSync(audioPath), false);
});

test("segment audio is deleted after a failed transcription", async () => {
  const h = harness({ durations: [1000], transcripts: [{ error: "gateway said no" }] });
  await runFor(h, 1);
  assert.equal(fs.existsSync(h.spawned[0].audioPath), false);
});

test("segment audio is deleted when the sound was too short to transcribe", async () => {
  const h = harness({ durations: [50] });
  await runSpawns(h, 1);
  assert.equal(fs.existsSync(h.spawned[0].audioPath), false);
});

test("no capture is left registered once the session has stopped", async () => {
  const h = harness({ durations: [1000], transcripts: [{ text: "words" }] });
  await runFor(h, 1);
  assert.equal(liveCaptureCount(), 0);
});

// ---- failure escalation ----------------------------------------------------

test("one failed segment is not surfaced, but a run of them is", async () => {
  const h = harness({
    durations: [1000, 1000, 1000],
    transcripts: [{ error: "boom" }, { error: "boom" }, { error: "boom" }],
  });
  await runFor(h, 3);
  const errors = h.toasts.filter((t) => t.variant === "error");
  assert.equal(errors.length, 1, "exactly one escalation, not one per failure");
  assert.match(errors[0].message, /3 times in a row/);
});

test("a recovered failure resets the run, so escalation means what it says", async () => {
  const h = harness({
    durations: [1000, 1000, 1000],
    transcripts: [{ error: "boom" }, { text: "recovered" }, { error: "boom" }],
  });
  await runFor(h, 3);
  assert.equal(h.toasts.filter((t) => t.variant === "error").length, 0);
});

test("the session survives a failed segment", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ error: "boom" }, { text: "still going" }],
  });
  await runFor(h, 2);
  assert.equal(h.requested.length, 2, "the loop continued past the failure");
});

// ---- mode exclusion --------------------------------------------------------

test("listening is refused while dictation holds the microphone, and says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listen-test-"));
  const held = registerCapture(
    createCapture({
      process: spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]),
      path: path.join(dir, "held.wav"),
      logger: null,
    }),
    "held-key dictation",
  );
  const h = harness({ durations: [1000] });
  const started = await h.listener.start();
  assert.equal(started, false);
  assert.equal(h.listener.active, false);
  assert.equal(h.spawned.length, 0, "no recorder may be spawned");
  assert.match(h.toasts.at(-1).message, /held-key dictation is using the microphone/);
  assert.match(h.toasts.at(-1).message, /stt-stop/, "the refusal names the way out");
  held.terminate();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("while listening, the shared registry names this mode as the holder", async () => {
  const h = harness({ durations: [1000, 1000], transcripts: [{ text: "a" }, { text: "b" }] });
  await h.listener.start();
  await until(() => h.spawned.length >= 1);
  // This is the value dictation's refusal reads, so asserting it here is
  // asserting the other direction of the exclusion (FR-017).
  assert.equal(liveCaptureOwner(), LISTENING);
  await h.listener.stop();
  assert.equal(liveCaptureOwner(), null);
});

// ---- status and discard ----------------------------------------------------

test("status reports the buffer, including its text, so no second command is needed", async () => {
  const h = harness({ durations: [1000], transcripts: [{ text: "refactor the parser" }] });
  await h.listener.start();
  await until(() => h.requested.length >= 1);
  await settle();
  const status = h.listener.status();
  assert.equal(status.active, true);
  assert.equal(status.entries, 1);
  assert.equal(status.text, "refactor the parser");
  assert.equal(status.chars, "refactor the parser".length);
  assert.ok(status.oldestAgeMs !== null);
  await h.listener.stop();
});

test("status is answerable before anything has been said", () => {
  const h = harness();
  const status = h.listener.status();
  assert.equal(status.active, false, "never listening at startup");
  assert.equal(status.entries, 0);
  assert.equal(status.oldestAgeMs, null);
  assert.equal(status.listeningForMs, null);
  // One row per phrase, not one per accepted form: the defaults compile to more
  // forms than phrases, and a status that recited every variant would be
  // unreadable by the time calibration has finished adding to them.
  assert.deepEqual(
    status.phrases.map((p) => p.phrase).sort(),
    DEFAULT_WAKE_PHRASES.map((p) => p.canonical).sort(),
  );
  assert.ok(
    compilePhrases(DEFAULT_WAKE_PHRASES).length > status.phrases.length,
    "defaults must have more accepted forms than phrases for this to be a real check",
  );
});

test("discard empties the buffer and leaves listening alone", async () => {
  const h = harness({ durations: [1000, 1000], transcripts: [{ text: "throw this away" }] });
  await h.listener.start();
  await until(() => h.requested.length >= 1);
  await settle();
  assert.equal(h.listener.discard(), 1);
  assert.equal(h.listener.status().entries, 0);
  assert.equal(h.listener.active, true, "discarding is not stopping");
  await h.listener.stop();
});

test("formatted status distinguishes off from listening", () => {
  const off = formatStatus({
    active: false,
    listeningForMs: null,
    segments: 0,
    entries: 0,
    chars: 0,
    oldestAgeMs: null,
    text: "",
    phrases: [{ phrase: "opencode execute", action: "submit" }],
    transcribing: false,
  });
  assert.match(off, /^Not listening/);
  assert.match(off, /opencode execute/);

  const on = formatStatus({
    active: true,
    listeningForMs: 95_000,
    segments: 3,
    entries: 2,
    chars: 40,
    oldestAgeMs: 30_000,
    text: "hello world",
    phrases: [{ phrase: "opencode stop and execute", action: "interrupt_submit" }],
    transcribing: true,
  });
  assert.match(on, /Listening for 1m 35s/);
  assert.match(on, /3 utterances captured, 2 buffered \(40 characters\)/);
  assert.match(on, /transcription is in flight/);
  assert.match(on, /interrupt and send/);
  assert.match(on, /Buffered: hello world/);
});

// ---- submission ------------------------------------------------------------

test("the wake phrase sends everything since the last submission and nothing else", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "Refactor Server.tsx, please." }, { text: "opencode execute" }],
  });
  await runFor(h, 2);
  assert.equal(h.appended.length, 1);
  const sent = h.appended[0].body.text;
  assert.match(sent, /^VOICE TRANSCRIPT\.\n\n/, "labelled as a transcript");
  assert.equal(sent.split("\n\n")[1], "Refactor Server.tsx, please.");
  assert.doesNotMatch(sent, /opencode execute/, "the phrase itself is not sent");
  assert.equal(h.submitted.length, 1);
});

test("the second submission does not repeat the first", async () => {
  const h = harness({
    durations: [1000, 1000, 1000, 1000],
    transcripts: [
      { text: "first thing" },
      { text: "opencode execute" },
      { text: "second thing" },
      { text: "opencode execute" },
    ],
  });
  await runFor(h, 4);
  assert.equal(h.appended.length, 2);
  assert.match(h.appended[0].body.text, /first thing/);
  assert.doesNotMatch(h.appended[1].body.text, /first thing/);
  assert.match(h.appended[1].body.text, /second thing/);
});

test("the phrase is excised and the rest of the utterance is sent with it", async () => {
  // The phrase introduces an instruction as often as it follows one, so both
  // sides of it are one prompt. Nothing is held back for a later submission.
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "do the thing opencode execute and then this bit" }, { text: "x" }],
  });
  await h.listener.start();
  await until(() => h.appended.length >= 1);
  await settle();
  assert.equal(h.appended[0].body.text.split("\n\n")[1], "do the thing and then this bit");
  await h.listener.stop();
});

test("a phrase opening the utterance sends the instruction it introduces", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "hey nome fix the failing test" }, { text: "x" }],
  });
  await h.listener.start();
  await until(() => h.appended.length >= 1);
  await settle();
  assert.equal(h.appended[0].body.text.split("\n\n")[1], "fix the failing test");
  await h.listener.stop();
});

test("no segment can be transcribed while a submission is being delivered", async () => {
  // The session handles one utterance at a time and delivery happens inside
  // that handling, so the window in which an append could race the assembly
  // does not exist. This asserts that structure rather than a lock, per
  // research.md R-109.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    durations: [1000, 1000, 1000],
    transcripts: [
      { text: "the original plan" },
      { text: "opencode execute and later words" },
      { text: "after the send" },
    ],
  });
  let firstCall = true;
  h.api.client.tui.appendPrompt = async (body) => {
    h.appended.push(body);
    if (firstCall) {
      firstCall = false;
      await held;
    }
  };

  await h.listener.start();
  await until(() => h.appended.length >= 1);
  const duringDelivery = h.requested.length;
  await settle();
  assert.equal(h.requested.length, duringDelivery, "the loop is not transcribing meanwhile");
  assert.equal(h.appended[0].body.text.split("\n\n")[1], "the original plan and later words");

  release();
  await settle();
  // Speech captured after the submission accumulates afresh; nothing from the
  // submitted snippet is carried forward into it or duplicated inside it.
  const text = h.listener.status().text;
  assert.doesNotMatch(text, /the original plan|later words/, "the submitted snippet is gone");
  await h.listener.stop();
});

test("an empty buffer reports rather than sending", async () => {
  const h = harness({ durations: [1000], transcripts: [{ text: "opencode execute" }] });
  await runFor(h, 1);
  assert.equal(h.appended.length, 0);
  assert.equal(h.submitted.length, 0);
  assert.ok(
    h.toasts.some((t) => /Nothing to send/.test(t.message)),
    "the refusal is reported",
  );
});

test("the phrase preserves the transcript character for character", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [
      { text: "Open lib/Server.tsx and check the `parse()` call -- it's wrong." },
      { text: "Opencode, execute!" },
    ],
  });
  await runFor(h, 2);
  assert.equal(
    h.appended[0].body.text.split("\n\n")[1],
    "Open lib/Server.tsx and check the `parse()` call -- it's wrong.",
  );
});

test("a phrase split across a pause still fires", async () => {
  const h = harness({
    durations: [1000, 1000, 1000],
    transcripts: [{ text: "fix the parser" }, { text: "opencode" }, { text: "execute" }],
  });
  await runFor(h, 3);
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].body.text.split("\n\n")[1], "fix the parser");
});

test("without auto-submit the prompt is filled but not sent, and the buffer still advances", async () => {
  const h = harness({
    autoSubmit: false,
    durations: [1000, 1000],
    transcripts: [{ text: "review this" }, { text: "opencode execute" }],
  });
  await runFor(h, 2);
  assert.equal(h.appended.length, 1, "the prompt is filled");
  assert.equal(h.submitted.length, 0, "and not submitted");
  assert.equal(h.listener.status().entries, 0, "the buffer is still replaced");
});

// ---- interrupt -------------------------------------------------------------

test("the interrupt phrase aborts the session and then submits", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "no, do this instead" }, { text: "opencode stop and execute" }],
  });
  await runFor(h, 2);
  assert.deepEqual(h.aborted, [{ sessionID: "ses_test" }]);
  assert.equal(h.appended.length, 1);
  assert.match(h.appended[0].body.text, /no, do this instead/);
  assert.equal(h.submitted.length, 1);
});

test("the plain phrase never aborts, whatever the agent is doing", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "carry on with that" }, { text: "opencode execute" }],
  });
  await runFor(h, 2);
  assert.deepEqual(h.aborted, [], "no abort, ever, from the plain phrase");
  assert.equal(h.appended.length, 1);
});

test("the interrupt phrase wins over the plain one it contains", async () => {
  const h = harness({
    durations: [1000, 1000],
    transcripts: [{ text: "different plan" }, { text: "opencode stop and execute" }],
  });
  await runFor(h, 2);
  assert.equal(h.aborted.length, 1, "resolved as interrupt, not as the shorter phrase");
});

test("interrupting with no session open submits without complaining", async () => {
  const h = harness({
    sessionID: null,
    durations: [1000, 1000],
    transcripts: [{ text: "go" }, { text: "opencode stop and execute" }],
  });
  await runFor(h, 2);
  assert.deepEqual(h.aborted, [], "nothing to abort");
  assert.equal(h.appended.length, 1, "the submission still happens");
  assert.equal(h.toasts.filter((t) => t.variant === "error").length, 0);
});

test("a failed abort still lets the submission through", async () => {
  const h = harness({
    abortFails: true,
    durations: [1000, 1000],
    transcripts: [{ text: "change course" }, { text: "opencode stop and execute" }],
  });
  await runFor(h, 2);
  assert.equal(h.appended.length, 1, "the transcript is sent regardless");
  assert.match(
    h.toasts.find((t) => t.variant === "warning")?.message ?? "",
    /Could not stop the agent/,
  );
});

// ---- teardown --------------------------------------------------------------

test("dispose stops the recorder and leaves nothing registered", async () => {
  const h = harness({ durations: [1000, 1000], transcripts: [{ text: "a" }, { text: "b" }] });
  await h.listener.start();
  await until(() => h.spawned.length >= 1);
  await h.listener.dispose();
  assert.equal(h.listener.active, false);
  assert.equal(liveCaptureCount(), 0);
  for (const { audioPath } of h.spawned) {
    assert.equal(fs.existsSync(audioPath), false, "no recording of the user's voice survives");
  }
});

test("stopping discards the buffer", async () => {
  const h = harness({ durations: [1000, 1000], transcripts: [{ text: "unsent words" }] });
  await h.listener.start();
  await until(() => h.requested.length >= 1);
  await settle();
  await h.listener.stop();
  assert.equal(h.listener.status().entries, 0);
  assert.equal(h.appended.length, 0, "and does not send it on the way out");
});

test("a recorder that fails to start stops the session and says why", async () => {
  const h = harness({ durations: ["fail"] });
  await h.listener.start();
  await until(() => !h.listener.active);
  assert.equal(h.listener.active, false);
  const errors = h.toasts.filter((t) => t.variant === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no such device/);
});
