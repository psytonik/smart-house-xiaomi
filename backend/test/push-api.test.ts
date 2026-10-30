import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "push-api-test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const PHONE = "ExponentPushToken[phonephonephonephone01]";

describe("push API", () => {
  let expo: Server;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const received: Array<{ method?: string; url?: string; body: Array<{ to: string; title: string }> }> = [];

  before(async () => {
    // A stand-in for Expo's push service: nothing here ever leaves the machine.
    expo = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: body.map(() => ({ status: "ok", id: "x" })) }));
      });
    });
    await new Promise<void>((r) => expo.listen(0, "127.0.0.1", r));
    dir = mkdtempSync(join(tmpdir(), "cam-pushapi-"));
    app = await buildApp(
      loadConfig({
        API_TOKEN: TOKEN,
        DATA_DIR: dir,
        PUBLIC_DIR: join(dir, "none"),
        MOTION_ENABLED: "false",
        GO2RTC_URL: "http://127.0.0.1:1",
        EXPO_PUSH_URL: `http://127.0.0.1:${(expo.address() as AddressInfo).port}/send`,
      }),
    );
  });

  after(async () => {
    await app.close();
    await new Promise((r) => expo.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload?: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: "POST", url, headers, payload: payload as object });

  it("needs the API token", async () => {
    assert.equal((await app.inject("/api/push")).statusCode, 401);
    assert.equal((await post("/api/push/register", { token: PHONE }, {})).statusCode, 401);
    assert.equal((await post("/api/push/test", undefined, {})).statusCode, 401);
  });

  it("starts with no devices, and the test button says so instead of pretending", async () => {
    assert.deepEqual((await app.inject({ url: "/api/push", headers: auth })).json(), { devices: 0, minIntervalSec: 120 });
    const res = await post("/api/push/test");
    assert.equal(res.statusCode, 409);
    assert.equal(received.length, 0);
  });

  it("rejects bad registrations", async () => {
    assert.equal((await post("/api/push/register", {})).statusCode, 400);
    assert.equal((await post("/api/push/register", { token: 5 })).statusCode, 400);
    assert.equal((await post("/api/push/register", { token: "x".repeat(300) })).statusCode, 400);
    const res = await post("/api/push/register", { token: "not-a-token" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Expo push token/);
  });

  it("registers a phone once, keeps the token file private and sends it a test notification", async () => {
    assert.deepEqual((await post("/api/push/register", { token: PHONE })).json(), { registered: true, added: true, devices: 1 });
    assert.deepEqual((await post("/api/push/register", { token: PHONE })).json(), { registered: true, added: false, devices: 1 });
    assert.equal(statSync(join(dir, "push-devices.json")).mode & 0o777, 0o600, "push tokens are not for other users of this Mac");

    const res = await post("/api/push/test");
    assert.deepEqual(res.json(), { sent: 1 });
    assert.equal(received.length, 1);
    assert.equal(received[0]!.method, "POST");
    assert.equal(received[0]!.body[0]!.to, PHONE);
    assert.match(received[0]!.body[0]!.title, /test/i);
  });

  it("unregisters a phone", async () => {
    assert.deepEqual((await post("/api/push/unregister", { token: PHONE })).json(), { removed: true, devices: 0 });
    assert.deepEqual((await post("/api/push/unregister", { token: PHONE })).json(), { removed: false, devices: 0 });
  });
});
