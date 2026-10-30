import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultMotion, loadConfig } from "../src/config.js";
import { isDecodeError } from "../src/motion.js";
import { MotionRecorder } from "../src/recorder.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * A stand-in for ffmpeg that behaves like it does with a bad link to the camera:
 * it writes the gray motion frames to stdout (alternating frames that differ in 30% of the pixels,
 * which looks like plenty of motion), can print decoder complaints to stderr, and can freeze for good.
 */
function fakeFfmpeg(dir: string, opts: { decodeErrors?: boolean; stallFirstRun?: boolean }): { path: string; runs: () => number } {
  const marker = join(dir, "runs.txt");
  const path = join(dir, "fake-ffmpeg.py");
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import sys, time
W, H = 160, 90
n = W * H
still = bytes(n)
busy = bytes([255]) * (n * 3 // 10) + bytes(n - n * 3 // 10)
with open(${JSON.stringify(marker)}, "a") as f:
    f.write("run\\n")
runs = len(open(${JSON.stringify(marker)}).read().split())
STALL = ${opts.stallFirstRun ? "True" : "False"}
stall = STALL and runs == 1
t0 = time.time()
i = 0
while True:
    # run 1 (and every run in the other tests) alternates busy and still frames; a restarted run after a stall stays still
    frame = busy if (i % 2 == 1 and (runs == 1 or not STALL)) else still
    sys.stdout.buffer.write(frame)
    sys.stdout.buffer.flush()
    ${opts.decodeErrors ? 'sys.stderr.write("[hevc @ 0x1] Skipping invalid undecodable NALU: 1\\n"); sys.stderr.flush()' : "pass"}
    i += 1
    if stall and time.time() - t0 > 1.5:
        time.sleep(3600)  # frozen: no frames, no exit
    time.sleep(0.25)
`,
  );
  chmodSync(path, 0o755);
  return { path, runs: () => readFileSync(marker, "utf8").split("\n").filter(Boolean).length };
}

function recorderFor(dir: string, ffmpegPath: string, logs: string[], grace = 0) {
  const cfg = loadConfig({ API_TOKEN: "x".repeat(20), DATA_DIR: dir, FFMPEG_PATH: ffmpegPath, RTSP_URL: "unused" });
  cfg.motion = defaultMotion({ threshold: 0.02, fps: 4, width: 160, height: 90, quietSec: 1, settleMs: 1500, stallSec: 1, startupGraceSec: grace });
  return new MotionRecorder(cfg, (m) => logs.push(m));
}

describe("isDecodeError", () => {
  it("recognises ffmpeg's complaints about a damaged video stream", () => {
    for (const line of [
      "[hevc @ 0x9c2805c00] Skipping invalid undecodable NALU: 1",
      "[h264 @ 0x1] error while decoding MB 12 3, bytestream -5",
      "[hevc @ 0x1] Could not find ref with POC 12",
      "[hevc @ 0x1] PPS id out of range: 0",
      "[hevc @ 0x1] Invalid NAL unit size",
    ]) {
      assert.equal(isDecodeError(line), true, line);
    }
  });

  it("leaves ordinary messages alone", () => {
    for (const line of ["Connection refused", "Input #0, rtsp, from 'rtsp://127.0.0.1:8554/cam'", "frame=  100 fps=4.0"]) {
      assert.equal(isDecodeError(line), false, line);
    }
  });
});

describe("MotionRecorder with a bad link to the camera", { timeout: 30_000 }, () => {
  it("control: frames that change a lot do start an event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-fault-"));
    dirs.push(dir);
    const rec = recorderFor(dir, fakeFfmpeg(dir, {}).path, []);
    await rec.start();
    let recording = false;
    for (const deadline = Date.now() + 5000; Date.now() < deadline && !recording; await sleep(100)) recording = rec.status().recording;
    await rec.stop();
    assert.equal(recording, true, "the fake stream must look like motion, or the next test proves nothing");
  });

  it("ignores motion while ffmpeg reports a damaged picture (packet loss makes the frames flicker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-fault-"));
    dirs.push(dir);
    const logs: string[] = [];
    const rec = recorderFor(dir, fakeFfmpeg(dir, { decodeErrors: true }).path, logs);
    await rec.start();
    await sleep(2500);
    const status = rec.status();
    const health = rec.health();
    await rec.stop();
    assert.equal(status.recording, false, "garbage frames are not motion");
    assert.ok(health.damagedLastMinute > 5, `decoder warnings are counted for the system panel (${health.damagedLastMinute})`);
    assert.ok(health.frameAgeSec !== null && health.frameAgeSec < 2, "frames are still flowing");
    assert.ok(!logs.includes("motion: started"));
  });

  it("does not report warnings from the first seconds after ffmpeg starts: the decoder is just waiting for a keyframe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-fault-"));
    dirs.push(dir);
    const rec = recorderFor(dir, fakeFfmpeg(dir, { decodeErrors: true }).path, [], 30);
    await rec.start();
    await sleep(2000);
    const health = rec.health();
    const status = rec.status();
    await rec.stop();
    assert.equal(health.damagedLastMinute, 0, "not counted as packet loss");
    assert.equal(status.recording, false, "but still not mistaken for motion");
  });

  it("does not flood the log with one line per damaged frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-fault-"));
    dirs.push(dir);
    const logs: string[] = [];
    const rec = recorderFor(dir, fakeFfmpeg(dir, { decodeErrors: true }).path, logs);
    await rec.start();
    await sleep(2500);
    await rec.stop();
    assert.ok(logs.filter((l) => /undecodable/.test(l)).length <= 1, logs.join("\n"));
  });

  it("restarts ffmpeg and closes the open event when the frames stop coming", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-fault-"));
    dirs.push(dir);
    const logs: string[] = [];
    const fake = fakeFfmpeg(dir, { stallFirstRun: true });
    const rec = recorderFor(dir, fake.path, logs);
    await rec.start();

    let open = false;
    for (const deadline = Date.now() + 5000; Date.now() < deadline && !open; await sleep(100)) open = rec.status().recording;
    assert.equal(open, true, "an event is open when the stream freezes");

    // frozen at 1.5 s; the watchdog (1 s) kills ffmpeg, the supervisor starts it again after its pause
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && fake.runs() < 2) await sleep(200);
    const status = rec.status();
    const health = rec.health();
    await rec.stop();

    assert.ok(health.stalls >= 1 && health.restarts >= 1, `stall and restart are counted (${JSON.stringify(health)})`);
    assert.ok(fake.runs() >= 2, `ffmpeg was restarted (runs: ${fake.runs()})\n${logs.join("\n")}`);
    assert.equal(status.recording, false, "the event must not stay open forever on a dead stream");
    assert.equal(status.level, 0, "no stale level from a frozen stream");
    assert.ok(logs.some((l) => /no frames/i.test(l)), logs.join("\n"));
  });
});
