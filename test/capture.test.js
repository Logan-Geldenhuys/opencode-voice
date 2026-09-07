import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildCapturePath,
  createCapture,
  disposeCapturesSync,
  ensureCaptureDir,
  isRegistered,
  liveCaptureCount,
  liveCaptureOwner,
  nextCapturePath,
  ownedCapture,
  registerCapture,
  removeCaptureDir,
  resetCaptureStateForTests,
  stopActiveCapture,
  stopOwnedCapture,
  unregisterCapture,
} from "../lib/capture.js";

// A process that outlives the test unless something kills it, standing in for
// a recorder. No microphone is involved: what is under test is ownership, not
// audio.
function spawnSleeper() {
  return spawn("sleep", ["30"], { stdio: ["ignore", "ignore", "pipe"] });
}

function makeCapture(dir, sequence, owner) {
  const audioPath = buildCapturePath(dir, sequence);
  fs.writeFileSync(audioPath, "", { mode: 0o600 });
  const cap = createCapture({ process: spawnSleeper(), path: audioPath });
  return owner ? registerCapture(cap, owner) : cap;
}

test.afterEach(() => {
  disposeCapturesSync();
  resetCaptureStateForTests();
});

test("capture directory is owner-only from the syscall that creates it", () => {
  const dir = ensureCaptureDir();
  try {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    // Same directory on a second call rather than a fresh one per capture.
    assert.equal(ensureCaptureDir(), dir);
  } finally {
    removeCaptureDir();
  }
  assert.equal(fs.existsSync(dir), false);
});

test("the filename sequence advances across callers rather than per module", () => {
  const first = nextCapturePath();
  const second = nextCapturePath();
  assert.notEqual(first, second);
  assert.equal(path.basename(first), "capture-001.wav");
  assert.equal(path.basename(second), "capture-002.wav");
  removeCaptureDir();
});

// The defect Phase A0 exists to fix: feature 001 kept the live-capture record
// inside lib/stt.js, so anything created elsewhere was invisible to teardown.
test("a capture created outside the dictation module is drained by the same teardown", async () => {
  const dir = ensureCaptureDir();
  const cap = makeCapture(dir, 1, "continuous listening");

  assert.equal(liveCaptureCount(), 1);
  assert.equal(fs.existsSync(cap.path), true);

  await stopActiveCapture();

  assert.equal(cap.running, false);
  assert.equal(fs.existsSync(cap.path), false);
  assert.equal(liveCaptureCount(), 0);
});

test("the synchronous drain kills every live capture rather than the most recent", () => {
  const dir = ensureCaptureDir();
  const first = makeCapture(dir, 1, "held-key dictation");
  const second = makeCapture(dir, 2, "continuous listening");
  const pids = [first.process.pid, second.process.pid];

  assert.equal(liveCaptureCount(), 2);

  disposeCapturesSync();

  assert.equal(liveCaptureCount(), 0);
  // The audio and the directory go with them.
  assert.equal(fs.existsSync(dir), false);
  for (const pid of pids) {
    // A killed child is a zombie until reaped, so signal 0 can still succeed.
    // What matters is that the kill was delivered, which the exit below shows.
    assert.equal(typeof pid, "number");
  }
  return Promise.all([first.exited, second.exited]).then(([a, b]) => {
    assert.equal(a.signal, "SIGKILL");
    assert.equal(b.signal, "SIGKILL");
  });
});

test("the registry is empty after a drain", async () => {
  const dir = ensureCaptureDir();
  makeCapture(dir, 1, "continuous listening");
  makeCapture(dir, 2, "continuous listening");
  assert.equal(liveCaptureCount(), 2);
  await stopActiveCapture();
  assert.equal(liveCaptureCount(), 0);
  assert.equal(liveCaptureOwner(), null);
});

test("unregistering a capture that already exited is harmless", async () => {
  const dir = ensureCaptureDir();
  const cap = makeCapture(dir, 1, "held-key dictation");

  await cap.terminate();
  assert.equal(unregisterCapture(cap), true);
  // Second and third calls are the ones that would throw if this were not
  // idempotent. Cleanup paths call it unconditionally.
  assert.equal(unregisterCapture(cap), false);
  assert.equal(unregisterCapture(cap), false);
  assert.equal(isRegistered(cap), false);

  cap.removeAudio();
  // Removing audio twice is also harmless: ENOENT is expected, not an error.
  cap.removeAudio();
});

test("the owner label is what a refusal names, and it survives the drain", async () => {
  const dir = ensureCaptureDir();
  const cap = makeCapture(dir, 1, "continuous listening");

  assert.equal(liveCaptureOwner(), "continuous listening");
  assert.equal(ownedCapture("continuous listening"), cap);
  assert.equal(ownedCapture("held-key dictation"), null);

  await stopActiveCapture();
  assert.equal(liveCaptureOwner(), null);
});

test("the targeted stop leaves another mode's capture alone", async () => {
  const dir = ensureCaptureDir();
  const dictation = makeCapture(dir, 1, "held-key dictation");
  const listening = makeCapture(dir, 2, "continuous listening");

  assert.equal(await stopOwnedCapture("held-key dictation"), true);

  assert.equal(dictation.running, false);
  assert.equal(fs.existsSync(dictation.path), false);
  assert.equal(listening.running, true);
  assert.equal(fs.existsSync(listening.path), true);
  assert.equal(liveCaptureCount(), 1);

  // Nothing left of that owner to stop, reported rather than thrown.
  assert.equal(await stopOwnedCapture("held-key dictation"), false);
});

test("each capture gets its own file, so one recorder cannot truncate another's upload", () => {
  const dir = ensureCaptureDir();
  const first = makeCapture(dir, 1, "continuous listening");
  const second = makeCapture(dir, 2, "continuous listening");
  assert.notEqual(first.path, second.path);
  disposeCapturesSync();
});
