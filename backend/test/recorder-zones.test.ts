import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultMotion, loadConfig } from "../src/config.js";
import { MotionRecorder } from "../src/recorder.js";
import type { Zone } from "../src/zones.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * A stand-in for ffmpeg that sends gray motion frames: every other frame has the top right corner
 * (x 70..100%, y 0..20%, that is 6% of the picture) bright. Like a camera's burned-in clock that changes.
 */
function fakeFfmpeg(dir: string): string {
  const path = join(dir, "fake-ffmpeg.py");
  writeFileSync(
    path,
    `#!/usr/bin/env python3
import sys, time
W, H = 160, 90
still = bytearray(W * H)
busy = bytearray(W * H)
for y in range(0, int(H * 0.2)):
    for x in range(int(W * 0.7), W):
        busy[y * W + x] = 255
i = 0
while True:
    sys.stdout.buffer.write(bytes(busy if i % 2 else still))
    sys.stdout.buffer.flush()
    i += 1
    time.sleep(0.25)
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function opens(zones: Zone[], seconds = 2.5): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "cam-zrec-"));
  dirs.push(dir);
  const cfg = loadConfig({ API_TOKEN: "x".repeat(20), DATA_DIR: dir, FFMPEG_PATH: fakeFfmpeg(dir), RTSP_URL: "unused" });
  cfg.motion = defaultMotion({ threshold: 0.02, fps: 4, width: 160, height: 90, quietSec: 1 });
  const rec = new MotionRecorder(cfg);
  rec.setZones(zones);
  await rec.start();
  let recording = false;
  for (const end = Date.now() + seconds * 1000; Date.now() < end && !recording; await sleep(100)) recording = rec.status().recording;
  await rec.stop();
  return recording;
}

describe("MotionRecorder with zones", { timeout: 30_000 }, () => {
  it("control: a flickering corner is motion when there are no zones", async () => {
    assert.equal(await opens([]), true);
  });

  it("an ignore zone over the flickering corner (the camera's clock) stops the false events", async () => {
    assert.equal(await opens([{ id: "clock", mode: "ignore", x: 0.65, y: 0, w: 0.35, h: 0.25 }]), false);
  });

  it("an ignore zone elsewhere does not hide the motion", async () => {
    assert.equal(await opens([{ id: "road", mode: "ignore", x: 0, y: 0.5, w: 1, h: 0.5 }]), true);
  });

  it("a watch zone that does not include the corner ignores it", async () => {
    assert.equal(await opens([{ id: "door", mode: "watch", x: 0, y: 0.4, w: 0.5, h: 0.6 }]), false);
  });

  it("a watch zone that includes the corner keeps seeing it", async () => {
    assert.equal(await opens([{ id: "corner", mode: "watch", x: 0.6, y: 0, w: 0.4, h: 0.3 }]), true);
  });

  it("zones apply while running, no restart needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cam-zrec-"));
    dirs.push(dir);
    const cfg = loadConfig({ API_TOKEN: "x".repeat(20), DATA_DIR: dir, FFMPEG_PATH: fakeFfmpeg(dir), RTSP_URL: "unused" });
    cfg.motion = defaultMotion({ threshold: 0.02, fps: 4, width: 160, height: 90, quietSec: 1 });
    const rec = new MotionRecorder(cfg);
    await rec.start();
    for (const end = Date.now() + 4000; Date.now() < end && !rec.status().recording; await sleep(100));
    assert.equal(rec.status().recording, true, "the corner counts at first");
    rec.setZones([{ id: "clock", mode: "ignore", x: 0.65, y: 0, w: 0.35, h: 0.25 }]);
    // the open event ends after the quiet period (1 s) once the corner no longer counts
    for (const end = Date.now() + 5000; Date.now() < end && rec.status().recording; await sleep(100));
    const stillRecording = rec.status().recording;
    await rec.stop();
    assert.equal(stillRecording, false);
  });
});
