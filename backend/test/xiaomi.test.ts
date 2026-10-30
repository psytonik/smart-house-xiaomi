import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { defaultMotion, type Config } from "../src/config.js";

const TOKEN = "t".repeat(24);
const auth = { authorization: `Bearer ${TOKEN}` };
const SRC = "xiaomi://6674200535:de@192.168.1.20?did=1001&model=chuangmi.camera.046c04";

describe("camera setup API", () => {
  let mock: Server;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let loginAnswer: { status: number; body: string };
  const streams: Record<string, unknown> = { cam: { producers: [{}] } };
  const puts: string[] = [];
  const logins: string[] = [];

  before(async () => {
    mock = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
        if (url.pathname === "/api/xiaomi" && req.method === "GET") {
          if (!url.searchParams.has("id")) return json(200, ["6674200535"]);
          const region = url.searchParams.get("region");
          if (region !== "de") return res.writeHead(404).end("no sources");
          return json(200, {
            sources: [
              { name: "Living room", info: "ip: 192.168.1.20, mac: AA", url: SRC },
              // go2rtc would never list this, but whatever it lists must be checked before it is trusted
              { name: "Odd", info: "", url: "exec:rm -rf /" },
              { name: "Bad did", info: "", url: "xiaomi://6674200535:de@1.1.1.1?did=../x&model=m" },
            ],
          });
        }
        if (url.pathname === "/api/xiaomi" && req.method === "POST") {
          logins.push(body);
          return res.writeHead(loginAnswer.status, { "content-type": loginAnswer.status === 401 ? "application/json" : "text/plain" }).end(loginAnswer.body);
        }
        if (url.pathname === "/api/streams" && req.method === "PUT") {
          puts.push(`${url.searchParams.get("name")} <- ${url.searchParams.get("src")}`);
          streams[url.searchParams.get("name") ?? ""] = {};
          return res.writeHead(200).end();
        }
        if (url.pathname === "/api/streams") return json(200, streams);
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const port = (mock.address() as AddressInfo).port;

    dataDir = mkdtempSync(join(tmpdir(), "cam-xiaomi-"));
    mkdirSync(join(dataDir, "public"));
    writeFileSync(join(dataDir, "public", "index.html"), "<!doctype html><title>cam</title>");
    const cfg: Config = {
      port: 0, host: "127.0.0.1", apiToken: TOKEN, go2rtcUrl: `http://127.0.0.1:${port}`, stream: "cam", dataDir, publicDir: join(dataDir, "public"),
      input: "unused", ffmpegPath: "ffmpeg", retentionDays: 7, motion: defaultMotion({ enabled: false }), signedUrlTtlSec: 3600,
      detect: { enabled: false, modelPath: "", minScore: 0.4, maxFrames: 5, discardEmpty: true },
      maxStorageBytes: 1024 ** 3, pushMinIntervalSec: 120, pushUrl: "http://127.0.0.1:1/push", expoAccessToken: "",
      authMaxFailures: 10, authWindowSec: 60, keepAliveMs: 300, warmupPollMs: 20, warmupAttempts: 5,
    };
    app = await buildApp(cfg);
  });

  after(async () => {
    await app.close();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const login = (payload: unknown) => app.inject({ method: "POST", url: "/api/xiaomi/login", headers: auth, payload: payload as object });

  it("needs the token", async () => {
    assert.equal((await app.inject("/api/cameras")).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/xiaomi/login", payload: { username: "a", password: "b" } })).statusCode, 401);
    assert.equal((await app.inject("/api/xiaomi/devices?account=1&region=de")).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/cameras", payload: {} })).statusCode, 401);
  });

  it("lists stream names and signed-in accounts, never sources", async () => {
    const res = await app.inject({ url: "/api/cameras", headers: auth });
    assert.deepEqual(res.json(), { streams: [{ name: "cam", active: true }], accounts: ["6674200535"] });
  });

  it("signs in with the form go2rtc expects", async () => {
    loginAnswer = { status: 200, body: "" };
    logins.length = 0;
    const res = await login({ username: "me@example.com", password: "p&ss word" });
    assert.deepEqual(res.json(), { status: "ok" });
    assert.equal(new URLSearchParams(logins[0]).get("username"), "me@example.com");
    assert.equal(new URLSearchParams(logins[0]).get("password"), "p&ss word", "special characters survive");
  });

  it("passes on a captcha and a verification step, then accepts the answer", async () => {
    loginAnswer = { status: 401, body: JSON.stringify({ captcha: "QUJD" }) };
    assert.deepEqual((await login({ username: "a", password: "b" })).json(), { status: "captcha", image: "QUJD" });

    loginAnswer = { status: 401, body: JSON.stringify({ verify_email: "m***@example.com" }) };
    assert.deepEqual((await login({ captcha: "x9k2" })).json(), { status: "verify", target: "m***@example.com" });

    loginAnswer = { status: 401, body: JSON.stringify({ verify_phone: "+49 *** 12" }) };
    assert.deepEqual((await login({ verify: "123456" })).json(), { status: "verify", target: "+49 *** 12" });

    loginAnswer = { status: 200, body: "" };
    logins.length = 0;
    assert.deepEqual((await login({ verify: "123456" })).json(), { status: "ok" });
    assert.equal(new URLSearchParams(logins[0]).get("verify"), "123456");
  });

  it("reports a refused sign-in in plain words and rejects malformed requests", async () => {
    loginAnswer = { status: 500, body: "xiaomi: wrong password" };
    const refused = await login({ username: "a", password: "b" });
    assert.equal(refused.statusCode, 502);
    assert.equal(refused.json().error, "xiaomi: wrong password");

    for (const bad of [{}, { username: "a" }, { password: "b" }, { username: "a", password: "b", captcha: "c" }, { username: "", password: "b" }, { other: 1 }]) {
      assert.equal((await login(bad)).statusCode, 400, JSON.stringify(bad));
    }
  });

  it("lists cameras of an account without exposing the source", async () => {
    const res = await app.inject({ url: "/api/xiaomi/devices?account=6674200535&region=de", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { devices: [{ did: "1001", name: "Living room", model: "chuangmi.camera.046c04", ip: "192.168.1.20" }] });
    assert.ok(!res.body.includes("xiaomi://"), "no source in the answer");
    assert.ok(!res.body.includes("exec:"), "a non-Xiaomi source is dropped");
  });

  it("an account with no camera in the region is an empty list; bad parameters are refused", async () => {
    assert.deepEqual((await app.inject({ url: "/api/xiaomi/devices?account=6674200535&region=us", headers: auth })).json(), { devices: [] });
    assert.equal((await app.inject({ url: "/api/xiaomi/devices?account=6674200535&region=mars", headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/xiaomi/devices?account=a%26b&region=de", headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/xiaomi/devices?region=de", headers: auth })).statusCode, 400);
  });

  it("adds a camera using the source go2rtc itself listed", async () => {
    puts.length = 0;
    const res = await app.inject({ method: "POST", url: "/api/cameras", headers: auth, payload: { account: "6674200535", region: "de", did: "1001", name: "living-room" } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { name: "living-room", active: false });
    assert.deepEqual(puts, [`living-room <- ${SRC}`]);
    const list = (await app.inject({ url: "/api/cameras", headers: auth })).json();
    assert.deepEqual(list.streams.map((s: { name: string }) => s.name), ["cam", "living-room"]);
  });

  it("never takes a source from the browser: an extra `src` is dropped, go2rtc's own source is used", async () => {
    puts.length = 0;
    const res = await app.inject({ method: "POST", url: "/api/cameras", headers: auth, payload: { account: "6674200535", region: "de", did: "1001", name: "second", src: "exec:id" } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(puts, [`second <- ${SRC}`]);
  });

  it("refuses to overwrite an existing camera, an unknown device and a bad name", async () => {
    puts.length = 0;
    const add = (payload: object) => app.inject({ method: "POST", url: "/api/cameras", headers: auth, payload });
    assert.equal((await add({ account: "6674200535", region: "de", did: "1001", name: "cam" })).statusCode, 409, "the camera the app uses stays as it is");
    assert.equal((await add({ account: "6674200535", region: "de", did: "9999", name: "other" })).statusCode, 404);
    for (const name of ["Cam", "a b", "../x", "", "-x", "x".repeat(41)]) {
      assert.equal((await add({ account: "6674200535", region: "de", did: "1001", name })).statusCode, 400, name);
    }
    assert.deepEqual(puts, []);
  });

  it("says so when go2rtc is down", async () => {
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    const res = await app.inject({ url: "/api/cameras", headers: auth });
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /go2rtc is unreachable/);
  });
});
