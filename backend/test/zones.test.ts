import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ZoneError, ZoneStore, buildMask, parseZones, type Zone } from "../src/zones.js";

const z = (over: Partial<Zone> = {}): Zone => ({ id: "a", mode: "ignore", x: 0.5, y: 0, w: 0.5, h: 0.25, ...over });

describe("parseZones", () => {
  it("accepts a list of rectangles and keeps only the known fields, rounded", () => {
    const out = parseZones([{ id: "stamp", mode: "ignore", x: 0.123456789, y: 0, w: 0.3, h: 0.1, extra: "dropped" }]);
    assert.deepEqual(out, [{ id: "stamp", mode: "ignore", x: 0.1235, y: 0, w: 0.3, h: 0.1 }]);
  });

  it("accepts privacy zones too", () => {
    assert.equal(parseZones([{ id: "window", mode: "privacy", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }])[0]!.mode, "privacy");
  });

  it("accepts an empty list: zones are optional", () => {
    assert.deepEqual(parseZones([]), []);
  });

  it("refuses anything that is not a sane rectangle inside the picture", () => {
    const bad: unknown[] = [
      "nope",
      [null],
      [z({ id: "" })],
      [z({ id: "x".repeat(41) })],
      [z({ mode: "hide" as never })],
      [z({ x: -0.1 })],
      [z({ x: 0.8, w: 0.5 })], // sticks out on the right
      [z({ y: 0.9, h: 0.2 })], // sticks out at the bottom
      [z({ w: 0.001 })], // too small to draw or hit
      [z({ h: Number.NaN })],
      [z({ x: "0.5" as never })],
      [z({ id: "dup" }), z({ id: "dup" })],
      Array.from({ length: 21 }, (_, i) => z({ id: `z${i}` })),
    ];
    for (const input of bad) assert.throws(() => parseZones(input), ZoneError, JSON.stringify(input).slice(0, 80));
  });
});

describe("buildMask", () => {
  const at = (mask: Uint8Array, w: number, x: number, y: number) => mask[y * w + x];

  it("is null without zones, so the detector keeps looking at the whole picture", () => {
    assert.equal(buildMask([], 100, 100), null);
  });

  it("an ignore zone switches off its own area only", () => {
    const m = buildMask([z({ x: 0.5, y: 0, w: 0.5, h: 0.5 })], 100, 100)!;
    assert.equal(at(m, 100, 75, 25), 0);
    assert.equal(at(m, 100, 25, 25), 1);
    assert.equal(at(m, 100, 75, 75), 1);
  });

  it("a privacy zone is also left out of motion detection: what is hidden is not watched", () => {
    const m = buildMask([z({ mode: "privacy", x: 0, y: 0, w: 0.5, h: 1 })], 100, 100)!;
    assert.equal(at(m, 100, 25, 50), 0);
    assert.equal(at(m, 100, 75, 50), 1);
  });

  it("a watch zone limits detection to its own area", () => {
    const m = buildMask([z({ mode: "watch", x: 0, y: 0.5, w: 0.5, h: 0.5 })], 100, 100)!;
    assert.equal(at(m, 100, 25, 75), 1);
    assert.equal(at(m, 100, 75, 75), 0);
    assert.equal(at(m, 100, 25, 25), 0);
  });

  it("an ignore zone cuts a hole in a watch zone", () => {
    const m = buildMask([z({ id: "w", mode: "watch", x: 0, y: 0, w: 1, h: 1 }), z({ id: "i", mode: "ignore", x: 0.5, y: 0.5, w: 0.5, h: 0.5 })], 100, 100)!;
    assert.equal(at(m, 100, 25, 25), 1);
    assert.equal(at(m, 100, 75, 75), 0);
  });

  it("covers every pixel a zone touches, also on a coarse grid", () => {
    const m = buildMask([z({ x: 0.51, y: 0, w: 0.01, h: 0.5 })], 10, 10)!; // touches column 5 only
    assert.equal(at(m, 10, 5, 2), 0);
    assert.equal(at(m, 10, 4, 2), 1);
    assert.equal(at(m, 10, 6, 2), 1);
  });
});

describe("ZoneStore", () => {
  const dirs: string[] = [];
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "cam-zones-"));
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("starts empty, keeps zones across restarts", async () => {
    const dir = fresh();
    const a = new ZoneStore(dir);
    await a.init();
    assert.deepEqual(a.get(), []);
    await a.set([z()]);
    const b = new ZoneStore(dir);
    await b.init();
    assert.deepEqual(b.get(), [z()]);
  });

  it("a damaged file means no zones, not a crash", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "zones.json"), "{ not json");
    const s = new ZoneStore(dir);
    await s.init();
    assert.deepEqual(s.get(), []);
  });
});
