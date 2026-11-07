import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { createServer } from "node:net";
import { isAwake } from "../src/awake.js";
import { tvRoutes, WAKE_COOLDOWN_MS, WAKE_POLL_MS, WAKE_RETRIES, WAKE_RETRY_MS } from "../src/routes/tv.js";
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
    await sendIrWake(fakeAdb(dir, "Broadcast completed: result=1"), "ABCDEF0123456789");
    const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 4), ["-s", "ABCDEF0123456789", "shell", "am"]);
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
    const env = { TV_IP: "127.0.0.1", TV_IR_PHONE: "phone1", TV_ADB_PATH: adb, TV_MAC: "aa:bb:cc:00:00:01" };
    const irs: string[] = [];
    const packets: string[][] = [];
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, env, { sendWake: async (macs) => void packets.push(macs), sendIr: async (_adb, serial) => void irs.push(serial), awake: async () => false });
    assert.equal((await app.inject({ url: "/api/tv" })).json().wake, true);
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } })).json(), { ok: true, woke: true });
    assert.deepEqual(irs, ["phone1"]);
    assert.equal(packets.length, 0); // the phone did it
    await app.close();

    const failing = Fastify();
    tvRoutes(failing, { cfg: testConfig({ dataDir: dir }) } as never, env, { sendWake: async (macs) => void packets.push(macs), sendIr: async () => { throw new Error("phone unplugged"); }, awake: async () => false });
    assert.deepEqual((await failing.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } })).json(), { ok: true, woke: true });
    assert.deepEqual(packets, [["aabbcc000001"]]); // the phone was not there: the wake-up packet instead
    await failing.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not wake a TV that is on the network, even if its link status is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    const irs: string[] = [];
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, { TV_IP: "127.0.0.1", TV_IR_PHONE: "phone1", TV_ADB_PATH: fakeAdb(dir, "x") }, { sendIr: async (_adb, serial) => void irs.push(serial), awake: async () => true });
    const res = await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } });
    assert.equal(res.statusCode, 503); // the ordinary key, which this test TV cannot take; no infrared
    assert.equal(irs.length, 0);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the infrared switch once, then waits for the TV instead of switching it off again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    let clock = 1_000_000;
    let fail = true;
    let sent = 0;
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, { TV_IP: "127.0.0.1", TV_IR_PHONE: "phone1", TV_ADB_PATH: fakeAdb(dir, "x") }, {
      sendIr: async () => {
        if (fail) throw new Error("phone unplugged");
        sent++;
      },
      awake: async () => false,
      now: () => clock,
    });
    const press = async () => app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } });
    assert.equal((await press()).statusCode, 500); // nothing was sent, so nothing to wait for
    fail = false;
    assert.deepEqual((await press()).json(), { ok: true, woke: true });
    clock += 5000;
    assert.deepEqual((await press()).json(), { ok: true, woke: true, waiting: true });
    assert.equal(sent, 1);
    clock += WAKE_COOLDOWN_MS;
    assert.deepEqual((await press()).json(), { ok: true, woke: true }); // it never came up: try again
    assert.equal(sent, 2);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a missed infrared frame", () => {
  const polls = WAKE_RETRY_MS / WAKE_POLL_MS;
  /** The TV answers from its `up`-th check on (the press itself is the first check). */
  const setup = (up: number) => {
    const dir = mkdtempSync(join(tmpdir(), "ir-"));
    const waits: number[] = [];
    let clock = 5_000_000;
    let sent = 0;
    let checks = 0;
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, { TV_IP: "127.0.0.1", TV_IR_PHONE: "phone1", TV_ADB_PATH: fakeAdb(dir, "x") }, {
      sendIr: async () => void sent++,
      awake: async () => ++checks >= up,
      sleep: async (ms) => void ((clock += ms), waits.push(ms)),
      now: () => clock,
    });
    return { app, dir, waits, sent: () => sent, checks: () => checks };
  };
  const press = (app: ReturnType<typeof Fastify>) => app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("is sent again when the TV does not answer, up to the limit, asking the TV every second meanwhile", async () => {
    const t = setup(Infinity);
    await press(t.app);
    await settle();
    assert.equal(t.sent(), 1 + WAKE_RETRIES);
    assert.equal(t.checks(), 1 + WAKE_RETRIES * polls); // the press, then every poll of every window
    assert.ok(t.waits.every((ms) => ms === WAKE_POLL_MS));
    await t.app.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("stops asking and sending once the TV answers", async () => {
    const t = setup(8); // up at the seventh poll of the first window
    await press(t.app);
    await settle();
    assert.equal(t.sent(), 1);
    assert.equal(t.checks(), 8);
    await t.app.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("sends the second frame only after a whole window without an answer", async () => {
    const t = setup(polls + 5); // up during the second window
    await press(t.app);
    await settle();
    assert.equal(t.sent(), 2);
    await t.app.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
});

describe("is the TV on the network", () => {
  it("answers yes to a connection or a refusal, no to silence", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    assert.equal(await isAwake("127.0.0.1", port), true);
    server.close();
    await new Promise((r) => server.once("close", r));
    assert.equal(await isAwake("127.0.0.1", port), true); // refused at once: the machine is up
    assert.equal(await isAwake("192.0.2.1", 6466, 300), false); // a documentation address: nobody answers
  });
});
