import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultMotion, type Config } from "../src/config.js";
import { MotionRecorder, segmentStart } from "../src/recorder.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hasX265 = hasFfmpeg && /libx265/.test(String(spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout));

function makeSource(path: string, parts: string, codec = "libx264") {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...parts.split(" "), "-c:v", codec, "-g", "15", "-pix_fmt", "yuv420p", ...(codec === "libx265" ? ["-x265-params", "log-level=error"] : []), path]);
  assert.equal(r.status, 0, String(r.stderr));
}

function configFor(dir: string, input: string): Config {
  return {
    port: 0, host: "127.0.0.1", apiToken: "x".repeat(20), go2rtcUrl: "http://127.0.0.1:1", stream: "cam",
    dataDir: dir, publicDir: join(dir, "public"), signedUrlTtlSec: 3600, detect: { enabled: false, modelPath: "", minScore: 0.4, maxFrames: 5, discardEmpty: true }, maxStorageBytes: 1024 ** 3, pushMinIntervalSec: 120, pushUrl: "http://127.0.0.1:1/push", expoAccessToken: "", authMaxFailures: 10, authWindowSec: 60, keepAliveMs: 100, warmupPollMs: 10, warmupAttempts: 1,
    input, ffmpegPath: "ffmpeg", retentionDays: 7,
    motion: defaultMotion({ threshold: 0.02, fps: 5, width: 160, height: 90, quietSec: 1.5, preRollSec: 1, postRollSec: 1, segmentSec: 1 }),
  };
}

describe("segmentStart", () => {
  it("parses local segment names", () => {
    assert.equal(segmentStart("seg-20261030T130001.ts"), new Date(2026, 9, 30, 13, 0, 1).getTime());
    assert.equal(segmentStart("../seg-20261030T130001.ts"), null);
    assert.equal(segmentStart("concat-x.txt"), null);
  });
});

describe("MotionRecorder with real ffmpeg", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cam-rec-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("records one clip with thumbnail for a burst of motion in a static scene", { timeout: 60_000 }, async () => {
    const src = join(dir, "burst.mp4");
    // 5 s static, 4 s of noise (= motion), 8 s static
    makeSource(
      src,
      "-f lavfi -i color=c=gray:s=640x360:r=15:d=5 -f lavfi -i color=c=gray:s=640x360:r=15:d=4,noise=alls=80:allf=t -f lavfi -i color=c=gray:s=640x360:r=15:d=8 -filter_complex [0][1][2]concat=n=3:v=1:a=0",
    );
    const rec = new MotionRecorder(configFor(join(dir, "a"), src));
    await rec.start();
    try {
      let clips = await rec.store.list();
      for (let i = 0; i < 100 && clips.length === 0; i++) {
        await sleep(300);
        clips = await rec.store.list();
      }
      assert.equal(clips.length, 1, "exactly one clip");
      const clip = clips[0]!;
      assert.ok(clip.durationSec >= 3.5 && clip.durationSec <= 11, `duration ${clip.durationSec}`);
      assert.ok(clip.bytes > 1000);
      assert.ok(clip.thumb, "thumbnail created");
      assert.ok((await rec.store.size(clip.id, "mp4")) ?? 0 > 0);
      assert.ok((await rec.store.size(clip.id, "jpg")) ?? 0 > 0);
      const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", rec.store.file(clip.clip)]);
      assert.match(String(probe.stderr), /Video: h264/);
      assert.ok(Date.parse(clip.endedAt) > Date.parse(clip.startedAt));
    } finally {
      await rec.stop();
    }
  });

  it("labels a clip with what the detector finds, and still saves it when the detector fails", { timeout: 90_000 }, async () => {
    const src = join(dir, "burst-detect.mp4");
    makeSource(
      src,
      "-f lavfi -i color=c=gray:s=640x360:r=15:d=5 -f lavfi -i color=c=gray:s=640x360:r=15:d=4,noise=alls=80:allf=t -f lavfi -i color=c=gray:s=640x360:r=15:d=8 -filter_complex [0][1][2]concat=n=3:v=1:a=0",
    );
    const seen: string[] = [];
    const wait = async (rec: MotionRecorder) => {
      let clips = await rec.store.list();
      for (let i = 0; i < 100 && clips.length === 0; i++) {
        await sleep(300);
        clips = await rec.store.list();
      }
      return clips[0];
    };

    const labelled = new MotionRecorder(configFor(join(dir, "d1"), src));
    labelled.setDetector({
      analyzeClip: async (_ffmpeg, file, durationSec, maxFrames) => {
        seen.push(`${file.endsWith(".mp4")}:${durationSec > 3}:${maxFrames}`);
        return [{ label: "person", score: 0.876 }];
      },
    });
    await labelled.start();
    try {
      const clip = await wait(labelled);
      assert.deepEqual(clip?.objects, [{ label: "person", score: 0.88 }], "score rounded to two places");
      assert.deepEqual(seen, ["true:true:5"], "the finished mp4 is analysed once");
    } finally {
      await labelled.stop();
    }

    const logs: string[] = [];
    const broken = new MotionRecorder(configFor(join(dir, "d2"), src), (m) => logs.push(m));
    broken.setDetector({
      analyzeClip: async () => {
        throw new Error("model exploded");
      },
    });
    await broken.start();
    try {
      const clip = await wait(broken);
      assert.ok(clip, "the clip is saved anyway");
      assert.equal(clip.objects, undefined, "not analysed is not the same as nothing found");
      assert.ok(logs.some((l) => /model exploded/.test(l)), logs.join("\n"));
    } finally {
      await broken.stop();
    }
  });

  it("deletes a clip the detector found nothing in, unless DETECT_DISCARD_EMPTY is off", { timeout: 90_000 }, async () => {
    const src = join(dir, "burst-empty.mp4");
    makeSource(
      src,
      "-f lavfi -i color=c=gray:s=640x360:r=15:d=5 -f lavfi -i color=c=gray:s=640x360:r=15:d=4,noise=alls=80:allf=t -f lavfi -i color=c=gray:s=640x360:r=15:d=8 -filter_complex [0][1][2]concat=n=3:v=1:a=0",
    );
    const empty = { analyzeClip: async () => [] };

    const logs: string[] = [];
    const discarding = new MotionRecorder(configFor(join(dir, "e1"), src), (m) => logs.push(m));
    discarding.setDetector(empty);
    await discarding.start();
    try {
      for (let i = 0; i < 100 && !logs.some((l) => /discarded/.test(l)); i++) await sleep(300);
      assert.ok(logs.some((l) => /discarded .* \(nothing recognised\)/.test(l)), logs.join("\n"));
      assert.equal((await discarding.store.list()).length, 0, "no record");
    } finally {
      await discarding.stop();
    }

    const cfg = configFor(join(dir, "e2"), src);
    cfg.detect.discardEmpty = false;
    const keeping = new MotionRecorder(cfg);
    keeping.setDetector(empty);
    await keeping.start();
    try {
      let clips = await keeping.store.list();
      for (let i = 0; i < 100 && clips.length === 0; i++) {
        await sleep(300);
        clips = await keeping.store.list();
      }
      assert.deepEqual(clips[0]?.objects, [], "kept, and shown under 'Nothing found'");
    } finally {
      await keeping.stop();
    }
  });

  it("handles H.265 like the real camera: clip is tagged hvc1 so Safari and QuickTime can play it", { skip: !hasX265 && "libx265 not available", timeout: 60_000 }, async () => {
    const src = join(dir, "burst265.mp4");
    makeSource(
      src,
      "-f lavfi -i color=c=gray:s=640x360:r=15:d=5 -f lavfi -i color=c=gray:s=640x360:r=15:d=4,noise=alls=80:allf=t -f lavfi -i color=c=gray:s=640x360:r=15:d=8 -filter_complex [0][1][2]concat=n=3:v=1:a=0",
      "libx265",
    );
    const rec = new MotionRecorder(configFor(join(dir, "d"), src));
    await rec.start();
    try {
      let clips = await rec.store.list();
      for (let i = 0; i < 100 && clips.length === 0; i++) {
        await sleep(300);
        clips = await rec.store.list();
      }
      assert.equal(clips.length, 1);
      const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", rec.store.file(clips[0]!.clip)]);
      assert.match(String(probe.stderr), /Video: hevc.*hvc1/);
      assert.ok(clips[0]!.thumb);
    } finally {
      await rec.stop();
    }
  });

  it("records nothing for a static scene", { timeout: 40_000 }, async () => {
    const src = join(dir, "static.mp4");
    makeSource(src, "-f lavfi -i color=c=gray:s=640x360:r=15:d=8");
    const rec = new MotionRecorder(configFor(join(dir, "b"), src));
    await rec.start();
    try {
      await sleep(11_000);
      assert.deepEqual(await rec.store.list(), []);
      assert.equal(rec.status().recording, false);
    } finally {
      await rec.stop();
    }
  });

  it("reports a missing ffmpeg instead of crashing", async () => {
    const cfg = configFor(join(dir, "c"), "unused");
    cfg.ffmpegPath = "/nonexistent/ffmpeg";
    const rec = new MotionRecorder(cfg);
    await rec.start();
    await sleep(300);
    assert.equal(rec.status().state, "ffmpeg-missing");
    await rec.stop();
  });
});
