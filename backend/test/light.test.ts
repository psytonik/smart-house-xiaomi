import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { defaultMotion, type Config } from "../src/config.js";
import { CozyLight, fromDevice, toDevice } from "../src/light.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

describe("light units", () => {
  it("converts a patch to lamp units", () => {
    assert.deepEqual(toDevice({ on: true }), { "1": 255 });
    assert.deepEqual(toDevice({ on: false }), { "1": 0 });
    assert.deepEqual(toDevice({ brightness: 50 }), { "2": 0, "4": 500 });
    assert.deepEqual(toDevice({ hue: 120, saturation: 80 }), { "2": 0, "5": 120, "6": 800 });
    assert.deepEqual(toDevice({ temperature: 100 }), { "2": 0, "3": 1000 });
  });

  it("clamps out-of-range values", () => {
    assert.deepEqual(toDevice({ brightness: 500, hue: 999 }), { "2": 0, "4": 1000, "5": 360 });
  });

  it("reads lamp state", () => {
    assert.deepEqual(fromDevice({ "1": 1, "2": 0, "3": 1000, "4": 1000, "5": 143, "6": 956 }), {
      on: true,
      brightness: 100,
      hue: 143,
      saturation: 96,
      temperature: 100,
    });
    assert.equal(fromDevice({ "1": 0 }).on, false);
  });
});

describe("lamp over the network (mock)", () => {
  let lamp: Server;
  let port: number;
  let state: Record<string, number>;
  const sets: Array<Record<string, number>> = [];
  let reject = false;
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    state = { "1": 0, "2": 0, "3": 500, "4": 1000, "5": 143, "6": 956 };
    lamp = createServer((c: Socket) => {
      c.on("data", (d) => {
        const q = JSON.parse(d.toString().trim());
        // an unrelated state report arrives first, like on the real lamp
        c.write(JSON.stringify({ cmd: 10, pv: 0, sn: "1", msg: { attr: [1], data: { "1": 1 } } }) + "\r\n");
        if (q.cmd === 3) {
          if (reject) return void c.write(JSON.stringify({ cmd: 3, pv: 0, sn: q.sn, msg: {}, res: 1 }) + "\r\n");
          sets.push(q.msg.data);
          Object.assign(state, q.msg.data);
          if (state["1"] === 255) state["1"] = 1;
          c.write(JSON.stringify({ cmd: 3, pv: 0, sn: q.sn, msg: q.msg, res: 0 }) + "\r\n");
        } else {
          c.write(JSON.stringify({ cmd: 2, pv: 0, sn: q.sn, msg: { attr: Object.keys(state).map(Number), data: state }, res: 0 }) + "\r\n");
        }
      });
    });
    await new Promise<void>((r) => lamp.listen(0, "127.0.0.1", r));
    port = (lamp.address() as AddressInfo).port;

    dataDir = mkdtempSync(join(tmpdir(), "light-test-"));
    const cfg: Config = {
      port: 0,
      host: "127.0.0.1",
      apiToken: TOKEN,
      go2rtcUrl: "http://127.0.0.1:1",
      stream: "cam",
      dataDir,
      publicDir: join(dataDir, "none"),
      input: "unused",
      ffmpegPath: "ffmpeg",
      retentionDays: 7,
      signedUrlTtlSec: 3600,
      detect: { enabled: false, modelPath: "", minScore: 0.4, maxFrames: 5, discardEmpty: true },
      maxStorageBytes: 1024 ** 3,
      pushMinIntervalSec: 120,
      pushUrl: "http://127.0.0.1:1/push",
      expoAccessToken: "",
      authMaxFailures: 10,
      authWindowSec: 60,
      motion: defaultMotion({ enabled: false }),
      lightIp: "127.0.0.1",
      lightPort: port,
      keepAliveMs: 300,
      warmupPollMs: 20,
      warmupAttempts: 5,
    };
    app = await buildApp(cfg);
  });

  after(async () => {
    await app.close();
    lamp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads the state and skips unrelated reports", async () => {
    const s = await new CozyLight("127.0.0.1", port).state();
    assert.equal(s.on, false);
    assert.equal(s.hue, 143);
  });

  it("GET /api/light needs the token and returns the state", async () => {
    assert.equal((await app.inject({ url: "/api/light" })).statusCode, 401);
    const res = await app.inject({ url: "/api/light", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { configured: true, reachable: true, on: false, brightness: 100, hue: 143, saturation: 96, temperature: 50 });
  });

  it("POST /api/light sets values and answers with the new state", async () => {
    const res = await app.inject({ method: "POST", url: "/api/light", headers: auth, payload: { on: true, brightness: 30 } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sets.at(-1), { "1": 255, "2": 0, "4": 300 });
    assert.equal(res.json().on, true);
    assert.equal(res.json().brightness, 30);
  });

  it("rejects bad input", async () => {
    for (const payload of [{}, { brightness: 101 }, { hue: -1 }, { on: "yes" }]) {
      const res = await app.inject({ method: "POST", url: "/api/light", headers: auth, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });

  it("reports a lamp that refuses the command", async () => {
    reject = true;
    const res = await app.inject({ method: "POST", url: "/api/light", headers: auth, payload: { on: false } });
    reject = false;
    assert.equal(res.statusCode, 502);
  });

  it("two quick requests do not collide", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/light", headers: auth, payload: { hue: 10 } }),
      app.inject({ method: "POST", url: "/api/light", headers: auth, payload: { hue: 200 } }),
    ]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal((await app.inject({ url: "/api/light", headers: auth })).json().hue, 200);
  });
});

describe("lamp not configured or offline", () => {
  const base = (over: Partial<Config>): Config => ({
    port: 0,
    host: "127.0.0.1",
    apiToken: TOKEN,
    go2rtcUrl: "http://127.0.0.1:1",
    stream: "cam",
    dataDir: mkdtempSync(join(tmpdir(), "light-test2-")),
    publicDir: "/nonexistent",
    input: "unused",
    ffmpegPath: "ffmpeg",
    retentionDays: 7,
    signedUrlTtlSec: 3600,
    detect: { enabled: false, modelPath: "", minScore: 0.4, maxFrames: 5, discardEmpty: true },
    maxStorageBytes: 1024 ** 3,
    pushMinIntervalSec: 120,
    pushUrl: "http://127.0.0.1:1/push",
    expoAccessToken: "",
    authMaxFailures: 10,
    authWindowSec: 60,
    motion: defaultMotion({ enabled: false }),
    keepAliveMs: 300,
    warmupPollMs: 20,
    warmupAttempts: 5,
    ...over,
  });

  it("says so when LIGHT_IP is not set", async () => {
    const app = await buildApp(base({}));
    assert.deepEqual((await app.inject({ url: "/api/light", headers: auth })).json(), { configured: false });
    assert.equal((await app.inject({ method: "POST", url: "/api/light", headers: auth, payload: { on: true } })).statusCode, 404);
    await app.close();
  });

  it("shows unreachable instead of failing", async () => {
    const app = await buildApp(base({ lightIp: "127.0.0.1", lightPort: 1 }));
    assert.deepEqual((await app.inject({ url: "/api/light", headers: auth })).json(), { configured: true, reachable: false });
    await app.close();
  });
});
