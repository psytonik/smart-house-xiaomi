import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { defaultMotion, type Config } from "../src/config.js";
import { testConfig } from "./helpers.js";
import { hsToHex } from "../src/lights.js";

const TOKEN = "test-token-0123456789abcdef";
const HELPER_TOKEN = "helper-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };

describe("hsToHex", () => {
  it("maps hue and saturation at full value", () => {
    assert.equal(hsToHex(0, 100), "ff0000");
    assert.equal(hsToHex(120, 100), "00ff00");
    assert.equal(hsToHex(240, 100), "0000ff");
    assert.equal(hsToHex(60, 100), "ffff00");
    assert.equal(hsToHex(200, 0), "ffffff");
    assert.equal(hsToHex(360, 100), "ff0000");
  });
});

describe("lights API with a Bluetooth helper (mock)", () => {
  let helper: Server;
  let up = true;
  let lightHits = 0;
  const posts: unknown[] = [];
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const saved = { t: process.env.BLE_HELPER_TOKEN, p: process.env.BLE_HELPER_PORT };

  const cfg = (port: number): Config => (testConfig({ apiToken: TOKEN, dataDir, publicDir: join(dataDir, "none"), lightPort: port }));

  before(async () => {
    helper = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== `Bearer ${HELPER_TOKEN}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
        if (req.url === "/state") return void res.end('{"connected":false}');
        lightHits++;
        if (!up) return void res.writeHead(502).end('{"error":"strip not found"}');
        posts.push(JSON.parse(body));
        res.end("{}");
      });
    });
    await new Promise<void>((r) => helper.listen(0, "127.0.0.1", r));
    process.env.BLE_HELPER_TOKEN = HELPER_TOKEN;
    process.env.BLE_HELPER_PORT = String((helper.address() as AddressInfo).port);
    dataDir = mkdtempSync(join(tmpdir(), "lights-test-"));
    app = await buildApp(cfg(5555));
  });

  after(async () => {
    await app.close();
    helper.close();
    rmSync(dataDir, { recursive: true, force: true });
    for (const [k, v] of [["BLE_HELPER_TOKEN", saved.t], ["BLE_HELPER_PORT", saved.p]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("needs the API token", async () => {
    assert.equal((await app.inject({ url: "/api/lights" })).statusCode, 401);
  });

  it("lists the Bluetooth strip with an unknown state at first", async () => {
    const { lights } = (await app.inject({ url: "/api/lights", headers: auth })).json();
    assert.equal(lights.length, 1);
    assert.equal(lights[0].id, "ble");
    assert.equal(lights[0].reachable, true);
    assert.equal(lights[0].stateKnown, false);
  });

  it("sends colour, brightness and power to the helper", async () => {
    const res = await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { hue: 120, saturation: 100, brightness: 40 } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(posts.at(-1), { color: "00ff00", brightness: 40, on: true });
    await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { on: false } });
    assert.deepEqual(posts.at(-1), { on: false });
    const { lights } = (await app.inject({ url: "/api/lights", headers: auth })).json();
    assert.equal(lights[0].stateKnown, true);
    assert.equal(lights[0].on, false);
    assert.equal(lights[0].brightness, 40);
  });

  it("keeps the saturation when only the hue changes", async () => {
    await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { saturation: 0 } });
    await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { hue: 240 } });
    assert.deepEqual(posts.at(-1), { color: "ffffff" });
  });

  it("rejects bad input and unknown lamps", async () => {
    for (const payload of [{}, { brightness: 101 }, { on: "yes" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/lights/nope", headers: auth, payload: { on: true } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/lights/wifi", headers: auth, payload: { on: true } })).statusCode, 404);
  });

  it("passes on a helper failure as 502, and does not ask a strip that was just not found again", async () => {
    up = false;
    const before = lightHits;
    const first = await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { on: true } });
    const second = await app.inject({ method: "POST", url: "/api/lights/ble", headers: auth, payload: { on: false } });
    up = true;
    assert.equal(first.statusCode, 502);
    assert.match(first.json().message ?? first.json().error, /strip not found/);
    assert.equal(second.statusCode, 502);
    assert.match(second.json().message ?? second.json().error, /strip not found/); // the same reason, at once
    assert.equal(lightHits - before, 1, "the helper was asked once, the second call failed without it");
  });
});

describe("the Wi-Fi strip in the lamp list", () => {
  it("has no temperature: its own 0..100 warmth is not kelvin, only bulbs report one", async () => {
    const { default: Fastify } = await import("fastify");
    const { registerLights } = await import("../src/lights.js");
    const app = Fastify();
    const cozy = { state: async () => ({ on: true, brightness: 50, hue: 0, saturation: 0, temperature: 40 }) };
    registerLights(app, { cozy: cozy as never, env: {} });
    const body = (await app.inject({ method: "GET", url: "/api/lights" })).json() as { lights: Array<Record<string, unknown>> };
    assert.equal(body.lights[0]!.id, "wifi");
    assert.equal(body.lights[0]!.group, "strip");
    assert.equal("temperature" in body.lights[0]!, false);
    await app.close();
  });
});
