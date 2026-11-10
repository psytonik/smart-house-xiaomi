import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadTuyaLights } from "../src/config.js";
import { fromDps, packFrame, sessionKey, toColourDp, toDps, TuyaBulb, unpackFrame } from "../src/tuya.js";

const KEY = Buffer.from("0123456789abcdef");

describe("Tuya 3.5 frames", () => {
  it("packs a frame that unpacks to the same command and bytes", () => {
    const wire = packFrame(7, 0x10, Buffer.from('{"a":1}'), KEY);
    const got = unpackFrame(wire, KEY)!;
    assert.equal(got.frame.cmd, 0x10);
    assert.equal(got.frame.seq, 7);
    assert.equal(got.frame.payload.toString(), '{"a":1}');
    assert.equal(got.used, wire.length);
  });

  it("waits for the rest of a frame and rejects a wrong key", () => {
    const wire = packFrame(1, 8, Buffer.from("x"), KEY);
    assert.equal(unpackFrame(wire.subarray(0, wire.length - 3), KEY), undefined);
    assert.throws(() => unpackFrame(wire, Buffer.from("fedcba9876543210")), /local key/);
  });

  it("derives the same session key on both sides", () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    assert.equal(sessionKey(KEY, a, b).length, 16);
    assert.deepEqual(sessionKey(KEY, a, b), sessionKey(KEY, a, b));
    assert.notDeepEqual(sessionKey(KEY, a, b), sessionKey(KEY, a, randomBytes(16)));
  });
});

describe("Tuya datapoints", () => {
  it("reads white and colour mode", () => {
    assert.deepEqual(fromDps({ "20": true, "21": "white", "22": 500 }), { on: true, brightness: 50, hue: 0, saturation: 0 });
    assert.deepEqual(fromDps({ "20": false, "21": "colour", "24": toColourDp(120, 1000, 800) }), { on: false, brightness: 80, hue: 120, saturation: 100 });
  });

  it("colour wins over brightness and lights a bulb that is off", () => {
    const dps = toDps({ hue: 240, saturation: 100 }, { "20": false, "21": "white", "22": 1000 });
    assert.equal(dps["20"], true);
    assert.equal(dps["21"], "colour");
    assert.equal(dps["24"], toColourDp(240, 1000, 1000));
  });

  it("saturation 0 goes back to the bulb's own white", () => {
    assert.deepEqual(toDps({ saturation: 0, brightness: 40 }, { "20": true, "21": "colour", "24": toColourDp(10, 1000, 1000) }), { "21": "white", "22": 400 });
  });

  it("brightness in colour mode changes the value part only; in white mode the white brightness (never below 10)", () => {
    assert.deepEqual(toDps({ brightness: 50 }, { "21": "colour", "24": toColourDp(120, 1000, 1000) }), { "24": toColourDp(120, 1000, 500) });
    assert.deepEqual(toDps({ brightness: 0 }, { "21": "white", "22": 1000 }), { "22": 10 });
    assert.deepEqual(toDps({ on: false }, {}), { "20": false });
  });
});

describe("Tuya bulb session (fake bulb)", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  /** Plays the bulb's side: session negotiation, then answers queries and records controls. */
  async function fakeBulb(dps: Record<string, unknown>, controls: unknown[]): Promise<number> {
    const server = createServer((sock: Socket) => {
      let buf: Buffer = Buffer.alloc(0);
      let key: Buffer = KEY;
      let remote: Buffer = Buffer.alloc(0);
      let local: Buffer = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const got = unpackFrame(buf, key);
          if (!got) return;
          buf = buf.subarray(got.used);
          const { cmd, payload } = got.frame;
          if (cmd === 3) {
            remote = payload;
            local = randomBytes(16);
            sock.write(packFrame(1, 4, Buffer.concat([local, createHmac("sha256", KEY).update(remote).digest()]), KEY));
          } else if (cmd === 5) {
            key = sessionKey(KEY, remote, local);
          } else if (cmd === 0x10) {
            sock.write(packFrame(2, 0x10, Buffer.concat([Buffer.alloc(4), Buffer.from(JSON.stringify({ dps }))]), key));
          } else if (cmd === 0x0d) {
            controls.push(JSON.parse(payload.subarray(15).toString()).data.dps);
            sock.write(packFrame(3, 0x0d, Buffer.alloc(4), key));
          }
        }
      });
      sock.on("error", () => undefined);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  const cfg = { id: "kitchen", name: "Кухня", ip: "127.0.0.1", deviceId: "dev", localKey: KEY.toString() };

  it("reads the state through a negotiated session", async () => {
    const port = await fakeBulb({ "20": true, "21": "white", "22": 300 }, []);
    assert.deepEqual(await new TuyaBulb(cfg, port).state(), { on: true, brightness: 30, hue: 0, saturation: 0 });
  });

  it("sends a control with only what changed", async () => {
    const controls: unknown[] = [];
    const port = await fakeBulb({ "20": true, "21": "white", "22": 1000 }, controls);
    await new TuyaBulb(cfg, port).set({ on: false });
    assert.deepEqual(controls, [{ "20": false }]);
  });

  it("says so when the bulb is not there", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await assert.rejects(new TuyaBulb(cfg, port).state(), /did not answer|closed/);
  });
});

describe("loadTuyaLights", () => {
  const dir = mkdtempSync(join(tmpdir(), "tuya-cfg-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (v: unknown) => {
    const f = join(dir, `l-${Math.random()}.json`);
    writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
    return f;
  };
  const good = { id: "kitchen", name: "Кухня", ip: "10.0.0.21", deviceId: "d", localKey: "0123456789abcdef" };

  it("no file means no bulbs", () => assert.deepEqual(loadTuyaLights(join(dir, "nope.json")), []));
  it("reads a good list", () => assert.equal(loadTuyaLights(write([good]))[0]!.name, "Кухня"));
  it("refuses a short key, a repeated id and broken JSON", () => {
    assert.throws(() => loadTuyaLights(write([{ ...good, localKey: "short" }])), /16-character/);
    assert.throws(() => loadTuyaLights(write([good, good])), /twice/);
    assert.throws(() => loadTuyaLights(write([{ ...good, id: "wifi" }])), /twice/);
    assert.throws(() => loadTuyaLights(write("{nope")), /not valid JSON/);
  });
});
