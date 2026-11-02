import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { tvRoutes } from "../src/routes/tv.js";
import { broadcastsFor, magicPacket, parseMacs, wake } from "../src/wol.js";
import { testConfig } from "./helpers.js";

describe("wake-on-LAN", () => {
  it("builds the magic packet: six 0xFF then the address sixteen times", () => {
    const p = magicPacket("d07602eb6cb9");
    assert.equal(p.length, 102);
    assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
    assert.equal(p.subarray(6, 12).toString("hex"), "d07602eb6cb9");
    assert.equal(p.subarray(96, 102).toString("hex"), "d07602eb6cb9");
  });

  it("reads one or several addresses in any usual spelling and refuses a broken one", () => {
    assert.deepEqual(parseMacs("D0:76:02:EB:6C:B9, 38-26-56-56-2d-a6"), ["d07602eb6cb9", "382656562da6"]);
    assert.deepEqual(parseMacs(undefined), []);
    assert.throws(() => parseMacs("d0:76:02:eb:6c"), /malformed/);
  });

  it("shouts on the TV's network and on the global one", () => {
    assert.deepEqual(broadcastsFor("10.0.0.9"), ["10.0.0.255", "255.255.255.255"]);
    assert.deepEqual(broadcastsFor("tv.local"), ["255.255.255.255"]);
  });

  it("sends the packet over UDP", async () => {
    const server = createSocket("udp4");
    const got: Buffer[] = [];
    server.on("message", (m) => got.push(m));
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
    await wake(["d07602eb6cb9"], ["127.0.0.1"], [server.address().port]);
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    assert.ok(got.length >= 1);
    assert.deepEqual(got[0], magicPacket("d07602eb6cb9"));
  });

  it("keeps sending when one address cannot be reached", async () => {
    const server = createSocket("udp4");
    const got: Buffer[] = [];
    server.on("message", (m) => got.push(m));
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", r));
    await wake(["d07602eb6cb9"], ["256.256.256.256", "127.0.0.1"], [server.address().port]);
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    assert.ok(got.length >= 1);
    await assert.rejects(wake(["d07602eb6cb9"], ["256.256.256.256"], [9]));
  });

  it("wakes the TV when power is pressed and it does not answer", async () => {
    const sent: string[][] = [];
    const dir = mkdtempSync(join(tmpdir(), "wol-"));
    const app = Fastify();
    tvRoutes(app, { cfg: testConfig({ dataDir: dir }) } as never, { TV_IP: "127.0.0.1", TV_MAC: "d0:76:02:eb:6c:b9" }, { sendWake: async (macs) => void sent.push(macs), awake: async () => false });
    const status = (await app.inject({ url: "/api/tv" })).json();
    assert.equal(status.wake, true);
    const res = await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "power" } });
    assert.deepEqual(res.json(), { ok: true, woke: true });
    assert.deepEqual(sent, [["d07602eb6cb9"]]);
    const other = await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "volumeUp" } });
    assert.equal(other.statusCode, 503); // other keys still say the TV is not answering
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
