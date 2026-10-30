import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SuctionLevel, VacuumState, WaterLevel } from "../src/vacuum.js";
import { LevelKeeper } from "../src/vacuumLevels.js";

describe("LevelKeeper", () => {
  let dir: string;
  let robot: { suction?: SuctionLevel; water?: WaterLevel };
  let writes: string[];
  let broken: boolean;

  const keeper = () =>
    new LevelKeeper(
      {
        state: async () => {
          if (broken) throw new Error("asleep");
          return { battery: 80, mode: "cleaning", statusCode: 1, ...robot } as VacuumState;
        },
        setSuction: async (l) => {
          writes.push(`suction ${l}`);
          robot.suction = l;
        },
        setWater: async (l) => {
          writes.push(`water ${l}`);
          robot.water = l;
        },
      },
      dir,
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "levels-"));
    robot = { suction: "turbo", water: "high" };
    writes = [];
    broken = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does nothing until the user has chosen something", async () => {
    await keeper().apply();
    assert.deepEqual(writes, []);
  });

  it("puts the chosen levels back where the robot reset them, and only those", async () => {
    const k = keeper();
    k.remember({ suction: "quiet" });
    await k.apply();
    assert.deepEqual(writes, ["suction quiet"]);
    k.remember({ water: "low" });
    await k.apply();
    assert.deepEqual(writes, ["suction quiet", "water low"], "suction already matches: not written again");
    await k.apply();
    assert.equal(writes.length, 2);
  });

  it("remembers across restarts, in a private file", async () => {
    keeper().remember({ suction: "standard", water: "medium" });
    assert.deepEqual(keeper().get(), { suction: "standard", water: "medium" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "vacuum-levels.json"), "utf8")), { suction: "standard", water: "medium" });
  });

  it("ignores a damaged file or values it does not know", () => {
    keeper().remember({ suction: "quiet" });
    rmSync(join(dir, "vacuum-levels.json"));
    assert.deepEqual(keeper().get(), {});
  });

  it("never rejects when the robot does not answer", async () => {
    const k = keeper();
    k.remember({ suction: "quiet" });
    broken = true;
    await k.apply();
    assert.deepEqual(writes, []);
  });

  it("looks twice after a start, and not at all when nothing was chosen", async () => {
    const none = keeper();
    none.afterStart(10);
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(writes, []);

    const k = keeper();
    k.remember({ suction: "quiet" });
    k.afterStart(10);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(writes, ["suction quiet"]);
    robot.suction = "turbo"; // the robot resets again later
    await new Promise((r) => setTimeout(r, 90));
    assert.deepEqual(writes, ["suction quiet", "suction quiet"]);
  });
});
