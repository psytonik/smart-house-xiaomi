import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeYolox, groupOf, nms, summarize, summarizeClip, toTensor, type Candidate } from "../src/detect.js";

const SIZE = 416;
const ANCHORS = 3549; // 52*52 + 26*26 + 13*13
const WIDTH = 85; // x, y, w, h, objectness, 80 classes

/** A raw YOLOX output with nothing in it. */
const empty = () => new Float32Array(ANCHORS * WIDTH);

function put(out: Float32Array, anchor: number, v: { x: number; y: number; w: number; h: number; obj: number; cls: number; score: number }) {
  const o = anchor * WIDTH;
  out[o] = v.x;
  out[o + 1] = v.y;
  out[o + 2] = v.w;
  out[o + 3] = v.h;
  out[o + 4] = v.obj;
  out[o + 5 + v.cls] = v.score;
}

describe("decodeYolox", () => {
  it("turns grid offsets and log sizes into boxes in pixels, per stride", () => {
    const out = empty();
    // stride 8 (52x52 cells), cell x=10 y=5: centre (0.5+10)*8, (0.5+5)*8; size exp(ln 2)*8 by exp(ln 4)*8
    put(out, 5 * 52 + 10, { x: 0.5, y: 0.5, w: Math.log(2), h: Math.log(4), obj: 0.9, cls: 0, score: 0.8 });
    // stride 16 (26x26 cells, after the 2704 stride-8 cells), cell x=4 y=3, size 3*16 square
    put(out, 2704 + 3 * 26 + 4, { x: 0, y: 0, w: Math.log(3), h: Math.log(3), obj: 0.9, cls: 2, score: 0.9 });
    // stride 32 (13x13 cells, after 2704+676), cell x=1 y=1, size 1*32 square
    put(out, 3380 + 13 + 1, { x: 0, y: 0, w: 0, h: 0, obj: 1, cls: 16, score: 0.5 });

    const found = decodeYolox(out, 0.3, SIZE).sort((a, b) => b.score - a.score);
    assert.equal(found.length, 3);

    const car = found[0]!; // 0.81
    assert.equal(car.classId, 2);
    assert.ok(Math.abs(car.score - 0.81) < 1e-6);
    assert.deepEqual(car.box.map(Math.round), [40, 24, 88, 72]);

    const person = found[1]!; // 0.72
    assert.equal(person.classId, 0);
    assert.ok(Math.abs(person.score - 0.72) < 1e-6);
    assert.deepEqual(person.box.map(Math.round), [76, 28, 92, 60]);

    const dog = found[2]!; // 0.5, centre (1*32, 1*32), 32 wide
    assert.equal(dog.classId, 16);
    assert.deepEqual(dog.box.map(Math.round), [16, 16, 48, 48]);
  });

  it("drops anything under the score threshold, using objectness times class score", () => {
    const out = empty();
    put(out, 100, { x: 0, y: 0, w: 0, h: 0, obj: 0.5, cls: 0, score: 0.5 }); // 0.25
    put(out, 200, { x: 0, y: 0, w: 0, h: 0, obj: 0.9, cls: 0, score: 0.9 }); // 0.81
    assert.equal(decodeYolox(out, 0.4, SIZE).length, 1);
    assert.equal(decodeYolox(out, 0.2, SIZE).length, 2);
  });

  it("an empty picture decodes to nothing", () => {
    assert.deepEqual(decodeYolox(empty(), 0.1, SIZE), []);
  });

  it("refuses an output of the wrong size instead of reading garbage", () => {
    assert.throws(() => decodeYolox(new Float32Array(100), 0.3, SIZE), /output/i);
  });
});

describe("nms", () => {
  const c = (box: [number, number, number, number], score: number, classId = 0): Candidate => ({ box, score, classId });

  it("keeps the best of overlapping boxes", () => {
    const kept = nms([c([0, 0, 100, 100], 0.6), c([5, 5, 105, 105], 0.9), c([200, 200, 260, 260], 0.5)], 0.45);
    assert.deepEqual(kept.map((k) => k.score), [0.9, 0.5]);
  });

  it("keeps boxes that touch but hardly overlap", () => {
    assert.equal(nms([c([0, 0, 100, 100], 0.9), c([90, 0, 190, 100], 0.8)], 0.45).length, 2);
  });

  it("copes with nothing and with one box", () => {
    assert.deepEqual(nms([], 0.45), []);
    assert.equal(nms([c([0, 0, 1, 1], 0.5)], 0.45).length, 1);
  });
});

describe("groupOf and summarize", () => {
  it("sorts the 80 COCO classes into the three groups that matter at home", () => {
    assert.equal(groupOf(0), "person");
    for (const id of [1, 2, 3, 5, 7]) assert.equal(groupOf(id), "vehicle", `class ${id}`);
    for (const id of [14, 15, 16, 17, 18, 19]) assert.equal(groupOf(id), "animal", `class ${id}`);
    for (const id of [4, 6, 8, 24, 56, 79]) assert.equal(groupOf(id), null, `class ${id}`);
  });

  it("keeps the best score per group, in a stable order", () => {
    const cand = (classId: number, score: number): Candidate => ({ classId, score, box: [0, 0, 1, 1] });
    assert.deepEqual(summarize([cand(2, 0.7), cand(0, 0.5), cand(0, 0.8), cand(16, 0.6), cand(56, 0.99)]), [
      { label: "person", score: 0.8 },
      { label: "vehicle", score: 0.7 },
      { label: "animal", score: 0.6 },
    ]);
    assert.deepEqual(summarize([]), []);
  });
});

describe("toTensor", () => {
  it("lays a BGR picture out as channels first, as floats, without rescaling (what YOLOX expects)", () => {
    // 2x1 picture: pixel 0 = (B 1, G 2, R 3), pixel 1 = (B 4, G 5, R 6)
    const t = toTensor(Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, 1);
    assert.deepEqual(Array.from(t), [1, 4, 2, 5, 3, 6]);
  });

  it("rejects a frame of the wrong size", () => {
    assert.throws(() => toTensor(new Uint8Array(5), 2, 1), /frame/i);
  });
});

describe("summarizeClip", () => {
  const det = (classId: number, score: number): Candidate => ({ classId, score, box: [0, 0, 1, 1] });
  const frame = new Uint8Array(3);

  it("looks at a few frames spread over the clip and merges what it sees", async () => {
    const times: number[] = [];
    const result = await summarizeClip({
      durationSec: 20,
      maxFrames: 4,
      extract: async (t) => {
        times.push(t);
        return frame;
      },
      detect: async () => (times.length === 2 ? [det(0, 0.9)] : times.length === 3 ? [det(2, 0.6)] : []),
    });
    assert.equal(times.length, 4);
    assert.ok(times.every((t) => t > 0 && t < 20));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), "in order");
    assert.deepEqual(result, [
      { label: "person", score: 0.9 },
      { label: "vehicle", score: 0.6 },
    ]);
  });

  it("a short clip gets fewer frames", async () => {
    let n = 0;
    await summarizeClip({ durationSec: 3, maxFrames: 6, extract: async () => ((n++, frame)), detect: async () => [] });
    assert.ok(n >= 1 && n <= 2, `frames: ${n}`);
  });

  it("nothing found is an answer ([]), not a failure", async () => {
    assert.deepEqual(await summarizeClip({ durationSec: 10, maxFrames: 3, extract: async () => frame, detect: async () => [] }), []);
  });

  it("skips a frame that cannot be taken, but reports failure when none can", async () => {
    let i = 0;
    const partly = await summarizeClip({ durationSec: 10, maxFrames: 3, extract: async () => (i++ === 0 ? null : frame), detect: async () => [det(0, 0.8)] });
    assert.deepEqual(partly, [{ label: "person", score: 0.8 }]);
    await assert.rejects(summarizeClip({ durationSec: 10, maxFrames: 3, extract: async () => null, detect: async () => [] }), /no frame/i);
  });
});
