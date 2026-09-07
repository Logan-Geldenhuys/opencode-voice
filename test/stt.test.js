import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildAudioHint,
  buildCapturePath,
  buildOpenRouterTranscriptionRequest,
  buildRecordArgs,
  buildWhisperArgs,
  createCapture,
  isOpenRouterEndpoint,
  isWSL,
  parsePactlSources,
  parsePactlSourcesShort,
} from "../lib/stt.js";

test("detects OpenRouter STT endpoints", () => {
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouterEndpoint("https://api.openai.com/v1"), false);
});

test("builds OpenRouter STT requests as JSON with base64 audio", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildOpenRouterTranscriptionRequest(
    "openai/whisper-large-v3-turbo",
    audioBuffer,
    "secret",
  );

  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });

  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "openai/whisper-large-v3-turbo",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  });
});

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source (RDPSource)" },
    { name: "alsa_input.usb-mic", label: "alsa_input.usb-mic" },
  ]);
});

test("parses pactl short sources and filters out monitors", () => {
  const short = [
    "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED",
    "2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED",
    "",
  ].join("\n");
  assert.deepEqual(parsePactlSourcesShort(short), [{ name: "RDPSource", label: "RDPSource" }]);
});

test("builds sox record args per audio backend", () => {
  assert.deepEqual(buildRecordArgs("pulseaudio", "RDPSource"), ["-t", "pulseaudio", "RDPSource"]);
  assert.deepEqual(buildRecordArgs("pulseaudio", null), ["-t", "pulseaudio", "default"]);
  assert.deepEqual(buildRecordArgs("coreaudio", "USB Microphone"), [
    "-t",
    "coreaudio",
    "USB Microphone",
  ]);
  assert.deepEqual(buildRecordArgs("coreaudio", null), ["-d"]);
  assert.deepEqual(buildRecordArgs("default", null), ["-d"]);
});

test("builds audio hints per backend and server state", () => {
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: true }),
    /wsl --shutdown/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: false }),
    /PipeWire\/PulseAudio/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: true, isWsl: false }),
    /input source configuration/,
  );
  assert.equal(
    buildAudioHint({ backend: "coreaudio", serverOk: false, isWsl: false }),
    "No input devices found",
  );
});

test("detects WSL via environment variables", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;
  try {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    assert.equal(isWSL(), false);
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    assert.equal(isWSL(), true);
  } finally {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  }
});

test("builds whisper-cli args with language", () => {
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "zh"), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "zh",
    "-np",
    "-nt",
  ]);
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", null), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "auto",
    "-np",
    "-nt",
  ]);
});

// ---- Capture object: path allocation and termination (T025) ----
//
// The capture object is exercised against ordinary long-lived child processes
// rather than sox, so the lifecycle guarantees in FR-014 through FR-018 are
// testable on a machine with no microphone.

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-test-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Spawns a child that outlives the assertions unless something kills it, and
// guarantees it is reaped even when an assertion throws.
async function withChild(argv, run, { stdio = ["ignore", "ignore", "pipe"] } = {}) {
  const child = spawn(argv[0], argv.slice(1), { stdio });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    return await run(child);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

test("allocates a distinct audio path per capture inside the capture directory", () => {
  const first = buildCapturePath("/tmp/opencode-voice-abc", 1);
  const second = buildCapturePath("/tmp/opencode-voice-abc", 2);

  assert.notEqual(first, second);
  assert.equal(path.dirname(first), "/tmp/opencode-voice-abc");
  assert.equal(path.dirname(second), "/tmp/opencode-voice-abc");
  assert.equal(path.extname(first), ".wav");
  assert.equal(path.basename(first), "capture-001.wav");
  assert.equal(path.basename(second), "capture-002.wav");
});

test("sorts capture files in creation order up to a thousand captures", () => {
  const dir = "/tmp/d";
  const names = [1, 2, 10, 100].map((n) => path.basename(buildCapturePath(dir, n)));
  assert.deepEqual([...names].sort(), names);
});

test("stop() ends the recorder and reports how it exited", async () => {
  await withChild(["sleep", "30"], async (child) => {
    const capture = createCapture({ process: child, path: "/tmp/unused.wav" });
    assert.equal(capture.running, true);
    assert.equal(capture.state, "recording");

    const info = await capture.stop();

    assert.notEqual(info, null);
    assert.equal(capture.running, false);
    assert.equal(capture.state, "stopping");
    assert.equal(isAlive(child.pid), false);
  });
});

test("terminate() escalates to SIGKILL for a recorder that ignores SIGTERM", async () => {
  await withChild(["sh", "-c", 'trap "" TERM; exec sleep 30'], async (child) => {
    const capture = createCapture({ process: child, path: "/tmp/unused.wav" });

    const info = await capture.terminate();

    assert.notEqual(info, null, "the child must not survive terminate()");
    assert.equal(info.signal, "SIGKILL", "SIGTERM was ignored, so SIGKILL is what ended it");
    assert.equal(capture.state, "terminated");
    assert.equal(isAlive(child.pid), false);
  });
});

test("terminate() leaves an unrelated process whose command line mentions sox alive", async () => {
  // The predecessor ran `pkill -9 -f 'sox.*opencode-stt'`, which kills by
  // command-line pattern and so kills any process the same user happens to be
  // running that matches. This decoy's own argv matches that pattern (FR-016).
  //
  // The decoy inherits no pipes: killing the shell orphans its `sleep`, and an
  // orphan holding a pipe open would stall the test runner until it expired.
  await withChild(
    ["sh", "-c", "sleep 30", "sox-opencode-stt-decoy"],
    async (decoy) => {
      await withChild(["sleep", "30"], async (child) => {
        const capture = createCapture({ process: child, path: "/tmp/unused.wav" });

        await capture.terminate();

        assert.equal(isAlive(child.pid), false, "the tracked recorder must be gone");
        assert.equal(isAlive(decoy.pid), true, "an unrelated process must be untouched");
      });
    },
    { stdio: "ignore" },
  );
});

test("terminate() is idempotent once the recorder has already exited", async () => {
  await withChild(["sh", "-c", "exit 0"], async (child) => {
    const capture = createCapture({ process: child, path: "/tmp/unused.wav" });
    await capture.exited;

    const info = await capture.terminate();

    assert.equal(info.code, 0);
    assert.equal(capture.running, false);
  });
});

test("removeAudio() deletes the capture file and tolerates it already being gone", async () => {
  await withTempDir(async (dir) => {
    const audioPath = buildCapturePath(dir, 1);
    fs.writeFileSync(audioPath, "not really audio", { mode: 0o600 });

    await withChild(["sh", "-c", "exit 0"], async (child) => {
      const capture = createCapture({ process: child, path: audioPath });
      await capture.exited;

      capture.removeAudio();
      assert.equal(fs.existsSync(audioPath), false);

      capture.removeAudio();
    });
  });
});

test("collects the recorder's stderr for diagnostics", async () => {
  await withChild(["sh", "-c", "echo 'sox: cannot open device' >&2; exit 1"], async (child) => {
    const capture = createCapture({ process: child, path: "/tmp/unused.wav" });
    const info = await capture.exited;

    assert.equal(info.code, 1);
    assert.match(capture.stderr, /cannot open device/);
  });
});
