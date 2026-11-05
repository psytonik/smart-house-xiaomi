import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import type { AppContext } from "../src/context.js";
import { PtzPresetError, PtzPresetStore, parsePresetPosition } from "../src/ptzPresets.js";
import { MOTOR_MAX, MOTOR_MIN, gotoPosition, type GotoIo } from "../src/ptzGoto.js";
import { ptzPositionRoutes, type PtzControl } from "../src/routes/ptzPosition.js";
import { SerialQueue } from "../src/queue.js";
import type { PtzDirection } from "../src/go2rtc.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ptz-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * A camera like the real one, measured on 2026-11-05: left raises the angle by about 3 per step, right lowers it; up raises the
 * elevation by about 7 per step, down lowers it; both stop at 1 and 101.
 */
class SimCamera {
  steps = 0;
  silent = false; // stops answering position queries
  constructor(
    public angle: number,
    public elevation: number,
    private readonly stuckAbove = MOTOR_MAX,
  ) {}
  io(): GotoIo {
    const clamp = (n: number, hi = MOTOR_MAX) => Math.min(hi, Math.max(MOTOR_MIN, n));
    return {
      position: async () => (this.silent ? undefined : { angle: this.angle, elevation: this.elevation }),
      step: async (d: PtzDirection) => {
        this.steps++;
        if (d === "left") this.angle = clamp(this.angle + 3, this.stuckAbove);
        if (d === "right") this.angle = clamp(this.angle - 3);
        if (d === "up") this.elevation = clamp(this.elevation + 7);
        if (d === "down") this.elevation = clamp(this.elevation - 7);
      },
      sleep: async () => {},
    };
  }
}

describe("gotoPosition", () => {
  it("walks to a position on both axes, within the size of one step", async () => {
    const cam = new SimCamera(101, 1);
    const r = await gotoPosition({ angle: 60, elevation: 40 }, cam.io());
    assert.equal(r.reached, true);
    assert.ok(Math.abs(cam.angle - 60) <= 2, `angle ${cam.angle}`);
    assert.ok(Math.abs(cam.elevation - 40) <= 4, `elevation ${cam.elevation}`);
    assert.equal(r.steps, cam.steps);
    assert.ok(r.steps <= 40, `${r.steps} steps`);
  });

  it("does not move when it is already there, or close enough", async () => {
    const cam = new SimCamera(50, 50);
    assert.equal((await gotoPosition({ angle: 51, elevation: 52 }, cam.io())).steps, 0);
    assert.equal(cam.steps, 0);
  });

  it("does not swing back and forth around the target", async () => {
    for (const [a0, e0, a1, e1] of [[10, 10, 77, 88], [90, 90, 3, 5], [50, 1, 50, 100], [1, 50, 101, 50]] as const) {
      const cam = new SimCamera(a0, e0);
      const r = await gotoPosition({ angle: a1, elevation: e1 }, cam.io());
      assert.equal(r.reached, true, `${a0},${e0} -> ${a1},${e1}`);
      const need = Math.ceil(Math.abs(a1 - a0) / 3) + Math.ceil(Math.abs(e1 - e0) / 7);
      assert.ok(r.steps <= need + 3, `${r.steps} steps for ${need} needed`);
    }
  });

  it("stops at the end of the camera's range instead of pushing forever", async () => {
    const cam = new SimCamera(50, 50, 80); // this camera cannot go beyond 80
    const r = await gotoPosition({ angle: 101, elevation: 50 }, cam.io());
    assert.equal(r.reached, false);
    assert.equal(r.reason, "limit");
    assert.equal(cam.angle, 80);
    assert.ok(r.steps < 20);
  });

  it("gives up after the step limit", async () => {
    const cam = new SimCamera(1, 1);
    const r = await gotoPosition({ angle: 101, elevation: 101 }, cam.io(), { maxSteps: 5 });
    assert.deepEqual([r.reached, r.reason, r.steps], [false, "max-steps", 5]);
  });

  it("does nothing and says why when the camera cannot tell where it is", async () => {
    const cam = new SimCamera(50, 50);
    cam.silent = true;
    const r = await gotoPosition({ angle: 10, elevation: 10 }, cam.io());
    assert.deepEqual([r.reached, r.reason, cam.steps], [false, "unknown", 0]);
  });

  it("stops if the camera stops answering in the middle", async () => {
    const cam = new SimCamera(101, 50);
    const io = cam.io();
    const step = io.step;
    io.step = async (d) => {
      await step(d);
      if (cam.steps === 3) cam.silent = true;
    };
    const r = await gotoPosition({ angle: 20, elevation: 50 }, io);
    assert.deepEqual([r.reached, r.reason, r.steps], [false, "unknown", 3]);
  });

  it("refuses a target outside the range", async () => {
    const cam = new SimCamera(50, 50);
    for (const t of [{ angle: 0, elevation: 50 }, { angle: 50, elevation: 102 }, { angle: 1.5, elevation: 50 }, { angle: NaN, elevation: 50 }]) {
      await assert.rejects(gotoPosition(t, cam.io()), /1\.\.101/);
    }
    assert.equal(cam.steps, 0);
  });
});

describe("parsePresetPosition", () => {
  it("accepts whole numbers 1..101 and refuses the rest", () => {
    assert.deepEqual(parsePresetPosition({ angle: 1, elevation: 101 }), { angle: 1, elevation: 101 });
    for (const bad of [{ angle: 0, elevation: 5 }, { angle: 5, elevation: 102 }, { angle: 2.5, elevation: 5 }, { angle: "5", elevation: 5 }, { angle: 5 }, null, "x"]) {
      assert.throws(() => parsePresetPosition(bad), PtzPresetError, JSON.stringify(bad));
    }
  });
});

describe("PtzPresetStore", () => {
  it("saves, finds by name without caring about case, renames position on save, and survives a restart", async () => {
    const dir = tmp();
    const store = new PtzPresetStore(dir);
    await store.init();
    const door = await store.save("Door", { angle: 20, elevation: 30 });
    assert.match(door.id, /^[a-z0-9-]{3,40}$/);
    assert.equal(store.findByName("  door ")?.id, door.id);
    assert.equal(store.findByName("window"), undefined);
    const again = await store.save("DOOR", { angle: 25, elevation: 31 }); // same name: the position is replaced, not a second preset
    assert.equal(again.id, door.id);
    assert.equal(store.list().length, 1);
    assert.deepEqual([store.list()[0]?.angle, store.list()[0]?.elevation], [25, 31]);
    const reopened = new PtzPresetStore(dir);
    await reopened.init();
    assert.deepEqual(reopened.list(), store.list());
  });

  it("refuses bad names and too many presets, and removes", async () => {
    const store = new PtzPresetStore(tmp());
    await store.init();
    await assert.rejects(store.save("   ", { angle: 5, elevation: 5 }), PtzPresetError);
    await assert.rejects(store.save("a\nb", { angle: 5, elevation: 5 }), PtzPresetError);
    await assert.rejects(store.save("x".repeat(41), { angle: 5, elevation: 5 }), PtzPresetError);
    for (let i = 0; i < 20; i++) await store.save(`spot ${i}`, { angle: 5, elevation: 5 });
    await assert.rejects(store.save("one too many", { angle: 5, elevation: 5 }), /at most 20/);
    const first = store.list()[0]!;
    assert.equal(await store.remove(first.id), true);
    assert.equal(await store.remove(first.id), false);
    assert.equal(store.list().length, 19);
  });

  it("does not lose presets saved at the same moment", async () => {
    const dir = tmp();
    const store = new PtzPresetStore(dir);
    await store.init();
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.save(`p${i}`, { angle: i, elevation: i })));
    assert.equal(store.list().length, 5);
    const onDisk = JSON.parse(readFileSync(join(dir, "ptz-presets.json"), "utf8")).presets;
    assert.equal(onDisk.length, 5);
  });

  it("refuses to start on a damaged file instead of overwriting it", async () => {
    const dir = tmp();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "ptz-presets.json"), "{ nope");
    await assert.rejects(new PtzPresetStore(dir).init());
  });
});

describe("PTZ position API", () => {
  let app: ReturnType<typeof Fastify>;
  let store: PtzPresetStore;
  let cam: SimCamera;
  let calibrated = 0;
  let queue: SerialQueue;
  const control = (): PtzControl => {
    const io = cam.io();
    return {
      move: io.step,
      position: async () => {
        const p = await io.position();
        return p && { ...p, ageMs: 0 };
      },
      calibrate: async () => {
        calibrated++;
      },
    };
  };

  beforeEach(async () => {
    cam = new SimCamera(101, 1);
    calibrated = 0;
    queue = new SerialQueue(4);
    store = new PtzPresetStore(tmp());
    await store.init();
    app = Fastify();
    const ctx = { cfg: testConfig({ dataDir: tmp() }), ptzQueue: queue, ptzPresets: store, recorder: { suppress() {} } } as unknown as AppContext;
    ptzPositionRoutes(app, ctx, control(), { settleMs: 0 });
    await app.ready();
  });
  afterEach(() => app.close());

  const post = (url: string, payload?: object) => app.inject({ method: "POST", url, payload });

  it("tells where the camera points", async () => {
    const r = await app.inject({ url: "/api/ptz/position" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { known: true, angle: 101, elevation: 1, ageMs: 0 });
    cam.silent = true;
    assert.deepEqual((await app.inject({ url: "/api/ptz/position?refresh=1" })).json(), { known: false });
  });

  it("goes to a position and reports where it got", async () => {
    const r = await post("/api/ptz/goto", { angle: 60, elevation: 30 });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.reached, true);
    assert.ok(Math.abs(b.angle - 60) <= 2 && Math.abs(b.elevation - 30) <= 4);
  });

  it("refuses a goto outside the range or without both numbers", async () => {
    assert.equal((await post("/api/ptz/goto", { angle: 0, elevation: 30 })).statusCode, 400);
    assert.equal((await post("/api/ptz/goto", { angle: 50, elevation: 200 })).statusCode, 400);
    assert.equal((await post("/api/ptz/goto", {})).statusCode, 400);
    assert.equal(cam.steps, 0);
  });

  it("answers 409 when the camera cannot tell where it is", async () => {
    cam.silent = true;
    assert.equal((await post("/api/ptz/goto", { angle: 50, elevation: 50 })).statusCode, 409);
  });

  it("saves the current position as a preset by name, and goes there later", async () => {
    await post("/api/ptz/goto", { angle: 40, elevation: 22 });
    const saved = await post("/api/ptz/presets", { name: "Door" });
    assert.equal(saved.statusCode, 201);
    const { id, angle, elevation } = saved.json();
    assert.ok(Math.abs(angle - 40) <= 2 && Math.abs(elevation - 22) <= 4);
    await post("/api/ptz/goto", { angle: 90, elevation: 80 });
    const back = await post(`/api/ptz/presets/${id}/go`);
    assert.equal(back.statusCode, 200);
    assert.ok(Math.abs(cam.angle - angle) <= 2 && Math.abs(cam.elevation - elevation) <= 4);
    assert.deepEqual((await app.inject({ url: "/api/ptz/presets" })).json().presets.map((p: { name: string }) => p.name), ["Door"]);
  });

  it("saves a preset with a given position without moving", async () => {
    const r = await post("/api/ptz/presets", { name: "Window", angle: 10, elevation: 70 });
    assert.deepEqual([r.statusCode, r.json().angle, r.json().elevation, cam.steps], [201, 10, 70, 0]);
  });

  it("refuses a preset without a name, with a bad position, or when the camera is silent", async () => {
    assert.equal((await post("/api/ptz/presets", { name: " " })).statusCode, 400);
    assert.equal((await post("/api/ptz/presets", { name: "x", angle: 0, elevation: 5 })).statusCode, 400);
    cam.silent = true;
    assert.equal((await post("/api/ptz/presets", { name: "x" })).statusCode, 409);
  });

  it("removes a preset, and says 404 for one that is not there", async () => {
    const { id } = (await post("/api/ptz/presets", { name: "A", angle: 5, elevation: 5 })).json();
    assert.equal((await app.inject({ method: "DELETE", url: `/api/ptz/presets/${id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/ptz/presets/${id}` })).statusCode, 404);
    assert.equal((await post(`/api/ptz/presets/${id}/go`)).statusCode, 404);
  });

  it("calibrates only when asked to", async () => {
    assert.equal(calibrated, 0);
    assert.equal((await post("/api/ptz/calibrate")).statusCode, 200);
    assert.equal(calibrated, 1);
  });

  it("refuses with 429 when the camera is busy with other moves", async () => {
    const slow = new SerialQueue(1);
    const busy = Fastify();
    ptzPositionRoutes(busy, { cfg: testConfig({ dataDir: tmp() }), ptzQueue: slow, ptzPresets: store, recorder: { suppress() {} } } as unknown as AppContext, control(), { settleMs: 0 });
    await busy.ready();
    let release!: () => void;
    const hold = slow.run(() => new Promise<void>((r) => (release = r)));
    assert.equal((await busy.inject({ method: "POST", url: "/api/ptz/goto", payload: { angle: 50, elevation: 50 } })).statusCode, 429);
    release();
    await hold;
    await busy.close();
  });
});
