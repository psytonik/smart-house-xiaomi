import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EventStore, type MotionClip } from "../src/events.js";
import { labelMissing } from "../src/label.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const clip = (id: string, over: Partial<MotionClip> = {}): MotionClip => ({
  id, startedAt: "2026-10-30T12:00:00.000Z", endedAt: "2026-10-30T12:00:09.000Z", durationSec: 9, peak: 3, bytes: 4, clip: `${id}.mp4`, thumb: null, ...over,
});

async function seed(withFile: string[], ...clips: MotionClip[]) {
  const dir = mkdtempSync(join(tmpdir(), "cam-label-"));
  dirs.push(dir);
  const store = new EventStore(dir);
  await store.init();
  for (const c of clips) {
    await store.add(c);
    if (withFile.includes(c.id)) writeFileSync(store.file(c.clip), "x");
  }
  return store;
}

describe("labelMissing (older clips get their labels)", () => {
  it("labels only clips that were never analysed, and keeps everything else in the clip as it was", async () => {
    const store = await seed(["20261030T120001000Z", "20261030T120002000Z"], clip("20261030T120001000Z"), clip("20261030T120002000Z", { objects: [] }));
    const asked: string[] = [];
    const result = await labelMissing(store, { analyzeClip: async (_f, file) => (asked.push(file), [{ label: "person", score: 0.91234 }]) }, "ffmpeg", 5);
    assert.deepEqual(result, { labelled: 1, failed: 0, missingFile: 0, alreadyDone: 1 });
    assert.equal(asked.length, 1);
    const a = await store.get("20261030T120001000Z");
    assert.deepEqual(a?.objects, [{ label: "person", score: 0.91 }]);
    assert.equal(a?.bytes, 4, "the rest of the record is untouched");
    assert.deepEqual((await store.get("20261030T120002000Z"))?.objects, [], "analysed earlier: not asked again");
  });

  it("a clip that cannot be analysed stays unlabelled and does not stop the others", async () => {
    const ids = ["20261030T120003000Z", "20261030T120004000Z"];
    const store = await seed(ids, clip(ids[0]!), clip(ids[1]!));
    let n = 0;
    const result = await labelMissing(
      store,
      { analyzeClip: async () => { if (n++ === 0) throw new Error("bad video"); return []; } },
      "ffmpeg",
      5,
    );
    assert.equal(result.failed, 1);
    assert.equal(result.labelled, 1);
    const all = await store.list();
    assert.deepEqual(all.map((c) => c.objects).sort(), [[], undefined].sort());
  });

  it("skips records whose video file is gone", async () => {
    const store = await seed([], clip("20261030T120005000Z"));
    const result = await labelMissing(store, { analyzeClip: async () => { throw new Error("must not be asked"); } }, "ffmpeg", 5);
    assert.deepEqual(result, { labelled: 0, failed: 0, missingFile: 1, alreadyDone: 0 });
  });
});
