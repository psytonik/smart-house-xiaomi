import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { VacuumCare, VacuumState } from "../src/vacuum.js";
import { VacuumWatcher } from "../src/vacuumWatcher.js";

describe("VacuumWatcher", () => {
  let dir: string;
  let clock: number;
  let state: VacuumState | Error;
  let care: VacuumCare | Error;
  let sent: Array<{ title: string; body: string; type: string }>;
  let careCalls: number;

  const good: VacuumCare = { mainBrush: { percent: 80, hoursLeft: 241 }, sideBrush: { percent: 70 }, filter: { percent: 61 }, totals: {} };
  const watcher = () =>
    new VacuumWatcher(
      {
        state: async () => {
          if (state instanceof Error) throw state;
          return state;
        },
        care: async () => {
          careCalls++;
          if (care instanceof Error) throw care;
          return care;
        },
      },
      { notify: async (title, body, type) => void sent.push({ title, body, type }) },
      { dataDir: dir, intervalMs: 60_000, now: () => clock },
    );
  const at = (mode: VacuumState["mode"], extra: Partial<VacuumState> = {}): VacuumState => ({ battery: 80, mode, statusCode: 0, ...extra });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watcher-"));
    clock = 1_000_000_000;
    state = at("charged");
    care = good;
    sent = [];
    careCalls = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("says when a cleaning is over and how much it did", async () => {
    const w = watcher();
    await w.tick();
    state = at("cleaning");
    await w.tick();
    state = at("returning");
    await w.tick();
    assert.equal(sent.length, 0);
    state = at("charging", { areaM2: 9, minutes: 25 });
    await w.tick();
    assert.deepEqual(sent.map((m) => [m.type, m.body]), [["vacuum-done", "Cleaned 9 m² in 25 min"]]);
    state = at("charged", { areaM2: 9, minutes: 25 });
    await w.tick();
    assert.equal(sent.length, 1, "sitting on the dock is not news");
  });

  it("calls for a start only when a cleaning begins, not on a resume or at the first look", async () => {
    let starts = 0;
    const w = new VacuumWatcher(
      { state: async () => state as VacuumState, care: async () => good },
      { notify: async () => undefined },
      { dataDir: dir, intervalMs: 60_000, now: () => clock, onCleaningStart: async () => void starts++ },
    );
    state = at("cleaning");
    await w.tick();
    assert.equal(starts, 0, "the server may start in the middle of a cleaning");
    state = at("charged");
    await w.tick();
    state = at("cleaning");
    await w.tick();
    assert.equal(starts, 1);
    state = at("paused");
    await w.tick();
    state = at("cleaning");
    await w.tick();
    assert.equal(starts, 1, "resuming is not a start");
  });

  it("stays quiet about a robot that just sits on the dock", async () => {
    const w = watcher();
    for (const mode of ["charging", "charged", "charging"] as const) {
      state = at(mode);
      await w.tick();
    }
    assert.equal(sent.length, 0);
  });

  it("tells about an error once, and again after it has gone", async () => {
    const w = watcher();
    await w.tick();
    state = at("error");
    await w.tick();
    await w.tick();
    assert.deepEqual(sent.map((m) => m.type), ["vacuum-error"]);
    state = at("idle");
    await w.tick();
    state = at("error");
    await w.tick();
    assert.deepEqual(sent.map((m) => m.type), ["vacuum-error", "vacuum-error"]);
  });

  it("tells when the robot stopped away from the dock with a nearly empty battery, once", async () => {
    const w = watcher();
    await w.tick();
    state = at("idle", { battery: 9 });
    await w.tick();
    await w.tick();
    assert.deepEqual(sent.map((m) => m.type), ["vacuum-battery"]);
    state = at("charging", { battery: 30 });
    await w.tick();
    state = at("paused", { battery: 8 });
    await w.tick();
    assert.equal(sent.filter((m) => m.type === "vacuum-battery").length, 2);
  });

  it("does not call a low battery on the way home an emergency", async () => {
    const w = watcher();
    await w.tick();
    state = at("returning", { battery: 5 });
    await w.tick();
    assert.equal(sent.length, 0);
  });

  it("says nothing while the robot doesn't answer, and carries on when it does", async () => {
    const w = watcher();
    await w.tick();
    state = at("cleaning");
    await w.tick();
    state = new Error("asleep");
    await w.tick();
    await w.tick();
    state = at("charging", { areaM2: 4, minutes: 10 });
    await w.tick();
    assert.deepEqual(sent.map((m) => m.type), ["vacuum-done"]);
  });

  it("warns about a worn part at most once a day, and remembers it across restarts", async () => {
    care = { ...good, sideBrush: { percent: 12, hoursLeft: 24 } };
    await watcher().tick();
    assert.deepEqual(sent.map((m) => [m.title, m.type]), [["Side brush is worn", "vacuum-part"]]);
    assert.match(sent[0]!.body, /12% left, about 24 h/);

    clock += 7 * 3600_000; // checked again, but it is still the same day
    await watcher().tick();
    assert.equal(sent.length, 1);

    clock += 25 * 3600_000;
    await watcher().tick();
    assert.equal(sent.length, 2);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "vacuum-alerts.json"), "utf8"))), ["Side brush"]);
  });

  it("looks at the parts every few hours, not every minute, and retries after a failure", async () => {
    const w = watcher();
    await w.tick();
    await w.tick();
    assert.equal(careCalls, 1);
    clock += 7 * 3600_000;
    await w.tick();
    assert.equal(careCalls, 2);

    care = new Error("no answer");
    clock += 7 * 3600_000;
    await w.tick();
    await w.tick();
    assert.equal(careCalls, 3, "a failed look is retried later, not at once");
    clock += 3601_000;
    care = good;
    await w.tick();
    assert.equal(careCalls, 4);
  });
});
