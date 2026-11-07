import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { XiaomiSetup } from "../src/xiaomi.js";
import type { AppContext } from "../src/context.js";
import { DeviceError, DeviceStore, envDevices, isPrivateIPv4, parseDevice, parseDevices } from "../src/devices.js";
import { discover, kindOfModel, scanCozyLife, scanMiio, type DiscoverDeps } from "../src/discovery.js";
import { devicesRoutes } from "../src/routes/devices.js";
import type { CloudDevice } from "../src/xiaomiCloud.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "devices-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const TOKEN = "00112233445566778899aabbccddeeff";
const lamp = { kind: "light", protocol: "cozylife", name: "Lamp", host: "192.168.1.20", did: "abc123", origin: "discovered" } as const;

describe("isPrivateIPv4", () => {
  it("accepts home networks only", () => {
    for (const ok of ["10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.1", "169.254.1.1"]) assert.equal(isPrivateIPv4(ok), true, ok);
    for (const bad of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "127.0.0.1", "0.0.0.0", "192.169.0.1", "example.com", "10.0.0", "10.0.0.256", ""]) assert.equal(isPrivateIPv4(bad), false, bad);
  });
});

describe("parseDevice", () => {
  const base = { id: "dev-1234", kind: "vacuum", protocol: "miio", name: " Vacuum ", origin: "manual", addedAt: "2026-11-05T10:00:00.000Z" };

  it("trims the name and keeps only known fields", () => {
    const rec = parseDevice({ ...base, host: "10.0.0.7", token: TOKEN.toUpperCase(), extra: "ignored" });
    assert.deepEqual(rec, { ...base, name: "Vacuum", host: "10.0.0.7", token: TOKEN });
  });

  it("refuses a public address, a bad token, an unknown kind and control characters", () => {
    assert.throws(() => parseDevice({ ...base, host: "8.8.8.8" }), DeviceError);
    assert.throws(() => parseDevice({ ...base, token: "short" }), DeviceError);
    assert.throws(() => parseDevice({ ...base, kind: "toaster" }), DeviceError);
    assert.throws(() => parseDevice({ ...base, name: "a\nb" }), DeviceError);
    assert.throws(() => parseDevice({ ...base, name: "   " }), DeviceError);
    assert.throws(() => parseDevice({ ...base, name: "x".repeat(61) }), DeviceError);
    assert.throws(() => parseDevice({ ...base, id: "Bad Id" }), DeviceError);
  });

  it("refuses duplicate ids in a list", () => {
    assert.throws(() => parseDevices([base, base]), /duplicate/);
  });
});

describe("DeviceStore", () => {
  it("starts empty, stores, and reads back after a restart", async () => {
    const dir = tmp();
    const store = new DeviceStore(dir);
    await store.init();
    assert.deepEqual(store.list(), []);
    const rec = await store.add({ ...lamp, room: "Bedroom" });
    assert.match(rec.id, /^dev-[0-9a-f]{8}$/);
    const again = new DeviceStore(dir);
    await again.init();
    assert.deepEqual(again.list(), [rec]);
  });

  it("keeps the file readable only by the owner (it holds tokens)", async () => {
    const dir = tmp();
    const store = new DeviceStore(dir);
    await store.init();
    await store.add({ kind: "vacuum", protocol: "miio", name: "Vacuum", host: "10.0.0.7", token: TOKEN, origin: "manual" });
    assert.equal(statSync(join(dir, "devices.json")).mode & 0o777, 0o600);
  });

  it("renames, sets and clears the room, and removes", async () => {
    const store = new DeviceStore(tmp());
    await store.init();
    const rec = await store.add(lamp);
    assert.equal((await store.update(rec.id, { name: "Kitchen lamp", room: "Kitchen" }))?.room, "Kitchen");
    assert.equal((await store.update(rec.id, { room: "" }))?.room, undefined);
    assert.equal(await store.update("dev-nope", { name: "x" }), undefined);
    assert.equal(await store.remove(rec.id), true);
    assert.equal(await store.remove(rec.id), false);
    assert.deepEqual(store.list(), []);
  });

  it("finds a stored device by address or by its own id", async () => {
    const store = new DeviceStore(tmp());
    await store.init();
    const rec = await store.add(lamp);
    assert.equal(store.find({ host: "192.168.1.20" })?.id, rec.id);
    assert.equal(store.find({ did: "abc123" })?.id, rec.id);
    assert.equal(store.find({ host: "192.168.1.21" }), undefined);
    assert.equal(store.find({}), undefined);
  });

  it("does not lose devices when several are added at once", async () => {
    const dir = tmp();
    const store = new DeviceStore(dir);
    await store.init();
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.add({ ...lamp, did: `d${i}`, host: `192.168.1.${i}` })));
    assert.equal(store.list().length, 5);
    const again = new DeviceStore(dir);
    await again.init();
    assert.deepEqual(again.list().map((d) => d.did).sort(), ["d1", "d2", "d3", "d4", "d5"]);
  });

  it("refuses to start on a damaged file instead of overwriting it later", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "devices.json"), "{ not json");
    await assert.rejects(new DeviceStore(dir).init());
  });
});

describe("envDevices", () => {
  const cfg = { lightIp: "10.0.0.1", stream: "psytonik_base" };
  it("lists what .env configures, read-only, with no token shown", () => {
    const list = envDevices(cfg, { VACUUM_IP: "10.0.0.7", VACUUM_TOKEN: TOKEN, TV_IP: "10.0.0.9" });
    assert.deepEqual(list.map((d) => d.id), ["env-camera", "env-light", "env-vacuum", "env-tv"]);
    assert.ok(list.every((d) => !d.editable && d.origin === "env"));
    assert.equal(list.find((d) => d.id === "env-vacuum")?.hasToken, true);
    assert.ok(!JSON.stringify(list).includes(TOKEN));
  });
  it("shows the camera's address and own id when go2rtc tells them", () => {
    const cam = envDevices(cfg, {}, { host: "10.0.0.5", did: "100000002" }).find((d) => d.id === "env-camera");
    assert.deepEqual([cam?.host, cam?.did], ["10.0.0.5", "100000002"]);
  });
  it("lists only the camera when nothing else is set", () => {
    assert.deepEqual(envDevices({ lightIp: undefined, stream: "cam" }, {}).map((d) => d.id), ["env-camera"]);
  });
});

describe("kindOfModel", () => {
  it("reads the kind from the Xiaomi model name", () => {
    assert.equal(kindOfModel("dreame.vacuum.p2028a"), "vacuum");
    assert.equal(kindOfModel("roborock.vacuum.s5"), "vacuum");
    assert.equal(kindOfModel("chuangmi.camera.029a02"), "camera");
    assert.equal(kindOfModel("yeelink.light.color1"), "light");
    assert.equal(kindOfModel("chuangmi.plug.212a01"), "plug");
    assert.equal(kindOfModel("lumi.sensor_ht.v1"), "other");
    assert.equal(kindOfModel("nodots"), "other");
  });
});

/** A fake device on this machine: answers every datagram with `reply(msg)`, if it returns one. */
function fakeDevice(reply: (msg: Buffer) => Buffer | undefined): Promise<{ port: number; close: () => void; sock: Socket }> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      const r = reply(msg);
      if (r) sock.send(r, rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve({ port: sock.address().port, close: () => sock.close(), sock }));
  });
}

describe("scanners", () => {
  const live: Array<() => void> = [];
  afterEach(() => live.splice(0).forEach((c) => c()));

  it("scanMiio reads the device id from the hello answer, and ignores other traffic", async () => {
    const hello = Buffer.alloc(32, 0xff);
    hello.writeUInt16BE(0x2131, 0);
    hello.writeUInt16BE(32, 2);
    hello.writeUInt32BE(0, 4);
    hello.writeUInt32BE(100000002, 8);
    const dev = await fakeDevice((msg) => (msg.length === 32 && msg.readUInt16BE(0) === 0x2131 ? hello : undefined));
    live.push(dev.close);
    const found = await scanMiio({ broadcast: "127.0.0.1", port: dev.port, timeoutMs: 600 });
    assert.deepEqual(found, [{ host: "127.0.0.1", did: "100000002" }]);

    const junk = await fakeDevice(() => Buffer.from("hello there"));
    live.push(junk.close);
    assert.deepEqual(await scanMiio({ broadcast: "127.0.0.1", port: junk.port, timeoutMs: 400 }), []);
  });

  it("scanCozyLife reads the did from the answer to cmd 0", async () => {
    const dev = await fakeDevice((msg) => {
      const q = JSON.parse(msg.toString());
      return q.cmd === 0 ? Buffer.from(JSON.stringify({ cmd: 0, msg: { did: "cozy-9f3a" } })) : undefined;
    });
    live.push(dev.close);
    assert.deepEqual(await scanCozyLife({ broadcast: "127.0.0.1", port: dev.port, timeoutMs: 600 }), [{ host: "127.0.0.1", did: "cozy-9f3a" }]);
    const bad = await fakeDevice(() => Buffer.from(JSON.stringify({ cmd: 0, msg: {} })));
    live.push(bad.close);
    assert.deepEqual(await scanCozyLife({ broadcast: "127.0.0.1", port: bad.port, timeoutMs: 400 }), []);
  });

  it("find nothing, without throwing, when nobody answers", async () => {
    assert.deepEqual(await scanMiio({ broadcast: "127.0.0.1", port: 1, timeoutMs: 300 }), []);
  });
});

const cloudVacuum: CloudDevice = { did: "111", name: "Dreame", model: "dreame.vacuum.p2028a", localip: "10.0.0.7", token: TOKEN, isOnline: true, region: "de" };
const cloudCamera: CloudDevice = { did: "222", name: "Cam", model: "chuangmi.camera.029a02", localip: "10.0.0.5", token: "ff".repeat(16), isOnline: false, region: "de" };
const deps = (over: Partial<DiscoverDeps> = {}): DiscoverDeps => ({ miio: async () => [], cozylife: async () => [], cloud: async () => [], ...over });

describe("discover", () => {
  it("joins what answered on the network with the account's name, model and token", async () => {
    const r = await discover(deps({ miio: async () => [{ host: "10.0.0.7", did: "111" }], cloud: async () => [cloudVacuum] }));
    assert.equal(r.cloud, "ok");
    assert.deepEqual(r.candidates, [{ key: "miio:111", protocol: "miio", kind: "vacuum", host: "10.0.0.7", name: "Dreame", model: "dreame.vacuum.p2028a", token: TOKEN, did: "111", seen: true }]);
  });

  it("lists an account device the network did not answer for as not seen", async () => {
    const r = await discover(deps({ cloud: async () => [cloudCamera] }));
    assert.equal(r.candidates[0]?.seen, false);
    assert.equal(r.candidates[0]?.kind, "camera");
    assert.equal(r.candidates[0]?.host, "10.0.0.5");
  });

  it("still finds devices when the Xiaomi account is not signed in, and says so", async () => {
    const r = await discover(deps({ miio: async () => [{ host: "10.0.0.8", did: "333" }], cloud: async () => Promise.reject(new Error("not signed in to Xiaomi yet")) }));
    assert.equal(r.cloud, "not-signed-in");
    assert.deepEqual(r.candidates.map((c) => [c.key, c.kind, c.token]), [["miio:333", "other", undefined]]);
  });

  it("reports an unreachable cloud as unavailable, not as 'not signed in'", async () => {
    const r = await discover(deps({ cloud: async () => Promise.reject(new Error("the Xiaomi cloud refused the request")) }));
    assert.equal(r.cloud, "unavailable");
  });

  it("finds CozyLife lamps, and drops anything outside the home network", async () => {
    const r = await discover(deps({ cozylife: async () => [{ host: "10.0.0.1", did: "abcdef12" }, { host: "8.8.8.8", did: "evil" }], miio: async () => [{ host: "1.2.3.4", did: "9" }] }));
    assert.deepEqual(r.candidates.map((c) => [c.key, c.name]), [["cozylife:abcdef12", "CozyLife ef12"]]);
  });

  it("survives a scanner that throws", async () => {
    const r = await discover(deps({ miio: async () => Promise.reject(new Error("no network")), cozylife: async () => [{ host: "10.0.0.1", did: "aa11" }] }));
    assert.equal(r.candidates.length, 1);
  });
});

describe("devices API", () => {
  let dir: string;
  let store: DeviceStore;
  let app: ReturnType<typeof Fastify>;
  const env = { VACUUM_IP: "10.0.0.7", VACUUM_TOKEN: TOKEN };

  beforeEach(async () => {
    dir = tmp();
    store = new DeviceStore(dir);
    await store.init();
    app = Fastify();
    const ctx = { cfg: testConfig({ dataDir: dir, lightIp: "10.0.0.1" }), devices: store, xiaomi: { cameraIdentity: async () => ({ host: "10.0.0.5", did: "222" }) } } as unknown as AppContext;
    devicesRoutes(app, ctx, env, deps({ miio: async () => [{ host: "10.0.0.7", did: "111" }, { host: "10.0.0.30", did: "444" }], cozylife: async () => [{ host: "10.0.0.1", did: "lamp0001" }], cloud: async () => [cloudVacuum] }));
    await app.ready();
  });
  afterEach(() => app.close());

  const scan = async () => (await app.inject({ method: "POST", url: "/api/devices/scan" })).json();

  it("lists the .env devices, read-only, without secrets", async () => {
    const res = await app.inject({ url: "/api/devices" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().devices.map((d: { id: string }) => d.id), ["env-camera", "env-light", "env-vacuum"]);
    assert.ok(!res.body.includes(TOKEN));
  });

  it("a search marks devices already configured as known, and never shows a token", async () => {
    const r = await scan();
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    const byKey = Object.fromEntries(r.candidates.map((c: { key: string; known: boolean; hasToken: boolean }) => [c.key, c]));
    assert.equal(byKey["miio:111"].known, true); // the vacuum is in .env (same address)
    assert.equal(byKey["cozylife:lamp0001"].known, true); // the lamp too
    assert.equal(byKey["miio:444"].known, false);
    assert.equal(byKey["miio:111"].hasToken, true);
  });

  it("knows the camera is already there, though .env gives no address for it (go2rtc does)", async () => {
    const dev = Fastify();
    devicesRoutes(dev, { cfg: testConfig({ dataDir: dir }), devices: store, xiaomi: { cameraIdentity: async () => ({ host: "10.0.0.5", did: "222" }) } } as unknown as AppContext, {}, deps({ miio: async () => [{ host: "10.0.0.5", did: "222" }], cloud: async () => [cloudCamera] }));
    await dev.ready();
    const r = (await dev.inject({ method: "POST", url: "/api/devices/scan" })).json();
    assert.equal(r.candidates[0].known, true);
    assert.equal((await dev.inject({ url: "/api/devices" })).json().devices[0].host, "10.0.0.5");
    await dev.close();
  });

  it("adds a found device by its key, storing the token the server remembers", async () => {
    await scan();
    const res = await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:444", name: "Hall plug", room: "Hall" } });
    assert.equal(res.statusCode, 201);
    const added = res.json();
    assert.equal(added.name, "Hall plug");
    assert.equal(added.hasToken, false);
    assert.equal(store.list().length, 1);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:444" } })).statusCode, 409); // twice
  });

  it("will not add before a search, or something a search did not find, or something already known", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:444" } })).statusCode, 409);
    await scan();
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:999" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:111" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:444", name: "a\nb" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN } })).statusCode, 400);
  });

  it("adds a device by hand, only on the home network", async () => {
    const body = { kind: "light", protocol: "other", name: "Strip", host: "10.0.0.50" };
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/manual", payload: { ...body, host: "8.8.8.8" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/manual", payload: { ...body, kind: "toaster" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/manual", payload: body })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/api/devices/manual", payload: body })).statusCode, 409);
  });

  it("renames, and removes; the .env devices are protected", async () => {
    await scan();
    const { id } = (await app.inject({ method: "POST", url: "/api/devices", payload: { key: "miio:444" } })).json();
    const patched = await app.inject({ method: "PATCH", url: `/api/devices/${id}`, payload: { name: "Plug", room: "Hall" } });
    assert.deepEqual([patched.json().name, patched.json().room], ["Plug", "Hall"]);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/devices/env-light", payload: { name: "x" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/devices/env-light" })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/devices/dev-nope", payload: { name: "x" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/devices/${id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/devices/${id}` })).statusCode, 404);
  });

  it("does not start a second search while one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = Fastify();
    devicesRoutes(slow, { cfg: testConfig({ dataDir: dir }), devices: store, xiaomi: { cameraIdentity: async () => ({}) } } as unknown as AppContext, {}, deps({ miio: async () => (await gate, []) }));
    await slow.ready();
    const first = slow.inject({ method: "POST", url: "/api/devices/scan" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await slow.inject({ method: "POST", url: "/api/devices/scan" })).statusCode, 409);
    release();
    assert.equal((await first).statusCode, 200);
    await slow.close();
  });
});

describe("XiaomiSetup.cameraIdentity", () => {
  async function fakeGo2rtc(body: unknown) {
    const server = createServer((_req, res) => res.setHeader("content-type", "application/json").end(JSON.stringify(body)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }
  const identity = async (body: unknown) => {
    const g = await fakeGo2rtc(body);
    try {
      return await new XiaomiSetup(testConfig({ dataDir: tmp(), go2rtcUrl: g.url, stream: "cam" })).cameraIdentity();
    } finally {
      g.close();
    }
  };

  it("takes the camera's address from a running stream (go2rtc lists remote_addr, not the source)", async () => {
    assert.deepEqual(await identity({ cam: { producers: [{ protocol: "cs2+udp", remote_addr: "10.0.0.5:11577" }] } }), { host: "10.0.0.5" });
  });

  it("takes the address and the id from the source of a stream that is not connected, and never returns the token", async () => {
    const got = await identity({ cam: { producers: [{ url: "xiaomi://1000000001:cn@10.0.0.5?did=100000002&model=chuangmi.camera.029a02&token=SECRET" }] } });
    assert.deepEqual(got, { host: "10.0.0.5", did: "100000002" });
    assert.ok(!JSON.stringify(got).includes("SECRET"));
  });

  it("answers with nothing when the stream is missing or go2rtc is down", async () => {
    assert.deepEqual(await identity({ other: { producers: [] } }), {});
    assert.deepEqual(await new XiaomiSetup(testConfig({ dataDir: tmp(), go2rtcUrl: "http://127.0.0.1:1" })).cameraIdentity(), {});
  });
});
