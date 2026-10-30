import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueueFullError, SerialQueue } from "../src/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs tasks one at a time, in the order they arrived", async () => {
    const q = new SerialQueue(10);
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string, ms: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      running--;
      return name;
    };
    const results = await Promise.all([q.run(task("a", 30)), q.run(task("b", 5)), q.run(task("c", 5))]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.equal(maxRunning, 1);
    assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("keeps going after a task fails and passes the error to its caller only", async () => {
    const q = new SerialQueue(10);
    const failing = q.run(async () => {
      throw new Error("camera said no");
    });
    const next = q.run(async () => "ok");
    await assert.rejects(failing, /camera said no/);
    assert.equal(await next, "ok");
  });

  it("refuses new tasks when too many are already waiting, and recovers afterwards", async () => {
    const q = new SerialQueue(2); // one running + one waiting
    const first = q.run(() => sleep(30));
    const second = q.run(() => sleep(5));
    await assert.rejects(
      q.run(async () => "late"),
      QueueFullError,
    );
    await Promise.all([first, second]);
    assert.equal(await q.run(async () => "fits again"), "fits again");
  });
});
