import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { describe, it } from "node:test";
import { DownMemo } from "../src/breaker.js";
import { MiioDevice, MiioError } from "../src/miio.js";

describe("DownMemo", () => {
  it("is up until something fails, then down for the hold time, then up again", () => {
    let now = 1_000;
    const memo = new DownMemo(15_000, () => now);
    assert.equal(memo.isDown, false);
    memo.fail();
    assert.equal(memo.isDown, true);
    now += 14_999;
    assert.equal(memo.isDown, true);
    now += 2;
    assert.equal(memo.isDown, false); // the next call tries for real
  });

  it("an answer clears it at once", () => {
    const memo = new DownMemo(15_000, () => 5);
    memo.fail();
    memo.ok();
    assert.equal(memo.isDown, false);
  });
});

describe("a vacuum that does not answer", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  /** A UDP port that never replies, standing for a robot that is off the network. */
  async function silentPort() {
    const sock = createSocket("udp4");
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    return { port: sock.address().port, close: () => sock.close() };
  }

  it("makes the first call wait for the timeout and the next ones fail at once", async () => {
    const silent = await silentPort();
    try {
      const dev = new MiioDevice("127.0.0.1", TOKEN, silent.port, 150);
      let t = Date.now();
      await assert.rejects(dev.call("get_status", []), /did not answer/);
      assert.ok(Date.now() - t >= 140, "the first call really waited");
      t = Date.now();
      await assert.rejects(dev.call("get_status", []), (e) => e instanceof MiioError && /did not answer/.test(e.message));
      assert.ok(Date.now() - t < 50, `the second call waited ${Date.now() - t} ms`);
    } finally {
      silent.close();
    }
  });

  it("two calls queued together cost one timeout, not two", async () => {
    const silent = await silentPort();
    try {
      const dev = new MiioDevice("127.0.0.1", TOKEN, silent.port, 200);
      const t = Date.now();
      const results = await Promise.allSettled([dev.call("a", []), dev.call("b", [])]);
      assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
      assert.ok(Date.now() - t < 330, `took ${Date.now() - t} ms`);
    } finally {
      silent.close();
    }
  });
});
