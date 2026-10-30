import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { EventStore, type MotionClip } from "../src/events.js";

let dir: string;
const dirs: string[] = [];

function clip(n: number, bytes: number): MotionClip {
  const id = `2026103${n}T120000000Z`;
  return { id, startedAt: `2026-10-3${n}T12:00:00.000Z`, endedAt: `2026-10-3${n}T12:00:09.000Z`, durationSec: 9, peak: 3, bytes, clip: `${id}.mp4`, thumb: `${id}.jpg` };
}

async function seed(store: EventStore, ...clips: MotionClip[]) {
  for (const c of clips) {
    writeFileSync(store.file(c.clip), Buffer.alloc(c.bytes));
    writeFileSync(store.file(c.thumb!), Buffer.alloc(1));
    await store.add(c);
  }
}

describe("EventStore storage limits", () => {
  let store: EventStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cam-store-"));
    dirs.push(dir);
    store = new EventStore(dir);
    await store.init();
  });

  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("reports how many clips there are and how much space they take", async () => {
    assert.deepEqual(await store.usage(), { clips: 0, bytes: 0 });
    await seed(store, clip(1, 100), clip(2, 250));
    assert.deepEqual(await store.usage(), { clips: 2, bytes: 350 });
  });

  it("deletes the oldest clips first until the total fits", async () => {
    await seed(store, clip(1, 100), clip(2, 100), clip(3, 100));
    const removed = await store.pruneToSize(250);
    assert.equal(removed, 1);
    assert.deepEqual((await store.list()).map((c) => c.id), [clip(3, 0).id, clip(2, 0).id]);
    assert.equal(await store.size(clip(1, 0).id, "mp4"), null, "files are removed too");
  });

  it("does nothing when everything fits", async () => {
    await seed(store, clip(1, 100), clip(2, 100));
    assert.equal(await store.pruneToSize(200), 0);
    assert.equal((await store.list()).length, 2);
  });

  it("never deletes the newest clip, even if it alone is over the limit", async () => {
    await seed(store, clip(1, 100), clip(2, 500));
    const removed = await store.pruneToSize(50);
    assert.equal(removed, 1);
    assert.deepEqual((await store.list()).map((c) => c.id), [clip(2, 0).id]);
  });
});
