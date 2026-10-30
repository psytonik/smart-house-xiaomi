import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MotionTracker, changedRatio, changedStats, type MotionSpan } from "../src/motion.js";

function setup(over: Partial<{ threshold: number; quietMs: number; maxMs: number; lightChange: number; settleMs: number }> = {}) {
  const starts: number[] = [];
  const spans: MotionSpan[] = [];
  const t = new MotionTracker(
    { threshold: 0.01, quietMs: 3000, maxMs: 20_000, ...over },
    { start: (at) => starts.push(at), end: (s) => spans.push(s) },
  );
  return { t, starts, spans };
}

/** Feeds `ratio` once per 250 ms from `from` to `to` (ms). */
function feed(t: MotionTracker, ratio: number, from: number, to: number) {
  for (let now = from; now < to; now += 250) t.feed(ratio, now);
}

describe("changedRatio", () => {
  it("counts pixels that changed by more than the delta", () => {
    const a = new Uint8Array([0, 0, 0, 0, 100, 100, 100, 100]);
    const b = new Uint8Array([10, 0, 30, 0, 100, 140, 100, 99]);
    assert.equal(changedRatio(a, b, 22), 2 / 8);
    assert.equal(changedRatio(a, a, 22), 0);
  });
});

describe("MotionTracker", () => {
  it("ignores a single flickering frame", () => {
    const { t, starts } = setup();
    t.feed(0.5, 0);
    for (let now = 250; now < 5000; now += 250) t.feed(0, now);
    assert.equal(starts.length, 0);
    assert.equal(t.recording, false);
  });

  it("starts on 2 of 3 moving frames and ends after the quiet period, at the last motion", () => {
    const { t, starts, spans } = setup();
    feed(t, 0, 0, 1000);
    feed(t, 0.2, 1000, 3000); // motion 1000..2750
    assert.equal(starts.length, 1);
    assert.equal(starts[0], 1250); // 2nd moving frame
    assert.equal(t.recording, true);
    feed(t, 0, 3000, 5500); // quiet
    assert.equal(spans.length, 0, "not ended yet (2750 + 3000 = 5750)");
    feed(t, 0, 5500, 6500);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.startedAt, 1250);
    assert.equal(spans[0]!.endedAt, 2750);
    assert.equal(spans[0]!.peak, 0.2);
    assert.equal(t.recording, false);
  });

  it("keeps one event going while motion continues with short pauses", () => {
    const { t, spans } = setup();
    feed(t, 0.1, 0, 2000);
    feed(t, 0, 2000, 4000); // pause shorter than quiet
    feed(t, 0.1, 4000, 6000);
    assert.equal(spans.length, 0);
    assert.equal(t.recording, true);
  });

  it("ignores motion while suppressed (camera is turning)", () => {
    const { t, starts } = setup();
    t.suppress(4000);
    feed(t, 0.5, 0, 4000);
    assert.equal(starts.length, 0);
    feed(t, 0.5, 4000, 5000);
    assert.equal(starts.length, 1);
  });

  it("splits events longer than the maximum and continues recording", () => {
    const { t, starts, spans } = setup({ maxMs: 5000 });
    feed(t, 0.3, 0, 7000);
    assert.equal(spans.length, 1);
    assert.equal(starts.length, 2);
    assert.ok(spans[0]!.endedAt - spans[0]!.startedAt >= 4750);
    assert.equal(t.recording, true);
  });

  it("stop() closes an open event", () => {
    const { t, spans } = setup();
    feed(t, 0.3, 0, 1500);
    t.stop();
    assert.equal(spans.length, 1);
    assert.equal(t.recording, false);
  });
});

describe("MotionTracker lighting changes (IR cut-filter, auto exposure)", () => {
  const light = { lightChange: 0.6, settleMs: 2000 };

  it("does not start an event when the whole frame changes at once", () => {
    const { t, starts } = setup(light);
    feed(t, 0, 0, 1000);
    t.feed(0.9, 1000); // the camera switches to night mode
    feed(t, 0.3, 1250, 3000); // exposure still settling: looks like motion but is not
    feed(t, 0, 3000, 6000);
    assert.equal(starts.length, 0);
    assert.equal(t.recording, false);
  });

  it("detects real motion again once the picture has settled", () => {
    const { t, starts } = setup(light);
    t.feed(0.9, 1000);
    feed(t, 0.2, 1250, 3000); // inside the settle window (until 3000)
    assert.equal(starts.length, 0);
    feed(t, 0.2, 3000, 4000);
    assert.equal(starts.length, 1);
  });

  it("a spike during an event neither extends it nor counts as its peak", () => {
    const { t, spans } = setup(light);
    feed(t, 0.2, 0, 3000); // motion until 2750
    t.feed(0.9, 3000);
    feed(t, 0, 3250, 7000);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.endedAt, 2750);
    assert.equal(spans[0]!.peak, 0.2);
  });

  it("a change below the limit is still motion", () => {
    const { t, starts } = setup(light);
    feed(t, 0.5, 0, 1000);
    assert.equal(starts.length, 1);
  });

  it("is off unless configured", () => {
    const { t, starts } = setup();
    feed(t, 0.9, 0, 1000);
    assert.equal(starts.length, 1);
  });
});

describe("changedStats (zones)", () => {
  const a = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
  const b = new Uint8Array([100, 100, 0, 0, 100, 100, 0, 0]); // 4 of 8 changed
  const mask = new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0]); // only the first half counts

  it("without a mask both ratios are the whole-picture ratio", () => {
    assert.deepEqual(changedStats(a, b, 22), { all: 0.5, inZone: 0.5 });
  });

  it("counts only masked-in pixels for inZone, as a share of the WHOLE picture, and keeps the whole-picture ratio", () => {
    assert.deepEqual(changedStats(a, b, 22, mask), { all: 0.5, inZone: 0.25 });
  });
});

describe("MotionTracker lighting change with zones", () => {
  it("recognises a lighting change from the whole picture, even when the zone sees only a little of it", () => {
    const { t, starts } = setup({ lightChange: 0.6, settleMs: 2000 });
    feed(t, 0, 0, 1000);
    t.feed(0.1, 1000, 0.9); // little inside the zone, but the whole picture changed
    feed(t, 0.1, 1250, 3000);
    assert.equal(starts.length, 0);
  });
});
