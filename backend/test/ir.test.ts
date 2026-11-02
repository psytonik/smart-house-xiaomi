import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { tvRoutes } from "../src/routes/tv.js";
import { CARRIER_HZ, rcaTimings, sendIrWake } from "../src/ir.js";
import { testConfig } from "./helpers.js";

/** A stand-in for adb: writes its arguments to a file and prints what the phone's receiver prints. */
function fakeAdb(dir: string, answer: string): string {
  const path = join(dir, "adb");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho "${answer}"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** What the Universal TV app logged for "Power Toggle" when the sleeping TV woke up (Redmi Note 14, 2 November). */
const PRONTO =
  "0000 006C 0000 001A 0098 0098 0013 004C 0013 004C 0013 004C 0013 004C 0013 0026 0013 0026 0013 004C 0013 0026 0013 004C 0013 0026 0013 004C 0013 0026 0013 0026 0013 0026 0013 0026 0013 0026 0013 004C 0013 004C 0013 0026 0013 004C 0013 0026 0013 004C 0013 0026 0013 004C 0013 0156";

describe("infrared frame", () => {
  it("encodes the TV's standby wake key (address 0xF, command 0xD5) as header, 24 bits and a closing mark", () => {
    const t = rcaTimings(0xf, 0xd5);
    assert.equal(t.length, 2 + 48 + 1);
    assert.deepEqual(t.slice(0, 2), [3960, 3960]);
    const bits = [];
    for (let i = 2; i < 50; i += 2) bits.push(t[i + 1] === 1980 ? 1 : 0);
    // 1111 00101010 0000 11010101: address, inverted command, inverted address, command
    assert.equal(bits.join(""), "111100101010000011010101");
    assert.equal(t.at(-1), 495);
  });

  it("matches the code the app really sends, within a few percent, on the same carrier", () => {
    const words = PRONTO.split(" ").map((w) => parseInt(w, 16));
    assert.ok(Math.abs(CARRIER_HZ - 1_000_000 / (words[1]! * 0.241246)) < 100);
    const unit = words[1]! * 0.241246; // microseconds per tick
    const real = words.slice(4, -1).map((ticks) => ticks * unit); // without the trailing gap
    const ours = rcaTimings(0xf, 0xd5);
    assert.equal(ours.length, real.length); // both end with the closing mark; the app adds a gap after it
    real.forEach((us, i) => assert.ok(Math.abs(ours[i]! - us) / us < 0.03, `${i}: ${ours[i]} vs ${us}`));
  });

  it("refuses an address or command out of range", () => {
    assert.throws(() => rcaTimings(16, 0), /address/);
    assert.throws(() => rcaTimings(0, 256), /command/);
  });

  it("hands the phone the carrier and the frame through adb, without a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    await sendIrWake(fakeAdb(dir, "Broadcast completed: result=1"), "cyijxoxg6trs996t");
    const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 4), ["-s", "cyijxoxg6trs996t", "shell", "am"]);
    assert.equal(args[args.indexOf("--ei") + 2], String(CARRIER_HZ));
    assert.equal(args[args.indexOf("--es") + 2], rcaTimings(0xf, 0xd5).join(","));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the phone says it did not send, or when the serial is odd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    await assert.rejects(sendIrWake(fakeAdb(dir, "Broadcast completed: result=2"), "phone"), /no infrared emitter/);
    await assert.rejects(sendIrWake(fakeAdb(dir, "Broadcast completed: result=0"), "phone"), /did not send/);
    await assert.rejects(sendIrWake(fakeAdb(dir, "x"), "phone; rm -rf /"), /adb serial/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the infrared frame for Power while the TV does not answer, and falls back to the packet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    const adb = fakeAdb(dir, "x");
    const env = { TV_IP: "127.0.0.1", TV_IR_PHONE: "phone1", TV_ADB_PATH: adb, TV_MAC: "d0:76:02:eb:6c:b9" };
    const irs: string[] = [];
    const packets: string[][] = [];
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, env, async (macs) => void packets.push(macs), async (_adb, serial) => void irs.push(serial));
    assert.equal((await app.inject({ url: "/api/tv" })).json().wake, true);
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } })).json(), { ok: true, woke: true });
    assert.deepEqual(irs, ["phone1"]);
    assert.equal(packets.length, 0); // the phone did it
    await app.close();

    const failing = Fastify();
    tvRoutes(failing, { cfg: testConfig({ dataDir: dir }) } as never, env, async (macs) => void packets.push(macs), async () => { throw new Error("phone unplugged"); });
    assert.deepEqual((await failing.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } })).json(), { ok: true, woke: true });
    assert.deepEqual(packets, [["d07602eb6cb9"]]); // the phone was not there: the wake-up packet instead
    await failing.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
