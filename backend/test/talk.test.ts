import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/sdp" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Talking to the camera: the browser publishes its microphone to a go2rtc stream of its own, and the backend then
 * plays that stream into the camera through ffmpeg, which turns it into what the speaker takes (A-law 16 kHz).
 * go2rtc cannot do that conversion by itself when the browser sends Opus.
 */
describe("talking to the camera", () => {
  let mock: Server;
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const seen: Array<{ method: string; path: string; query: URLSearchParams; body: string }> = [];
  let publishStatus = 201;
  let sourceReady = true;
  let talkExists = true;

  before(async () => {
    mock = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body });
        const route = `${req.method} ${url.pathname}`;
        if (route === "POST /api/webrtc") res.writeHead(publishStatus, { "content-type": "application/sdp" }).end(publishStatus < 300 ? "v=0 answer" : "no");
        else if (route === "GET /api/streams" && !talkExists) res.writeHead(404).end();
        else if (route === "GET /api/streams") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ producers: sourceReady ? [{ receivers: [{}] }] : [] }));
        else if (route === "PUT /api/streams") {
          talkExists = true;
          res.writeHead(200).end();
        } else if (route === "DELETE /api/streams") {
          talkExists = false;
          res.writeHead(200).end();
        } else if (route === "POST /api/streams") res.writeHead(200).end();
        else res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    dataDir = mkdtempSync(join(tmpdir(), "cam-talk-"));
    mkdirSync(join(dataDir, "public"));
    writeFileSync(join(dataDir, "public", "index.html"), "<!doctype html>");
    app = await buildApp(testConfig({ apiToken: TOKEN, go2rtcUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`, dataDir, publicDir: join(dataDir, "public") }));
  });
  after(async () => {
    await app.close();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const offer = (query = "") => app.inject({ method: "POST", url: `/api/talk${query}`, headers: auth, payload: "v=0 offer" });
  // A request leaves a bridge starting in the background: let the previous test's finish before the next one counts requests.
  const reset = async () => {
    await sleep(120);
    seen.length = 0;
    publishStatus = 201;
    sourceReady = true;
    talkExists = true;
  };

  it("needs the app token", async () => {
    await reset();
    const res = await app.inject({ method: "POST", url: "/api/talk", headers: { "content-type": "application/sdp" }, payload: "v=0 offer" });
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0);
  });

  it("publishes the browser's microphone to go2rtc and answers with go2rtc's answer", async () => {
    await reset();
    const res = await offer();
    assert.equal(res.statusCode, 201);
    assert.equal(res.body, "v=0 answer");
    const pub = seen.find((r) => r.path === "/api/webrtc")!;
    assert.equal(pub.query.get("dst"), "cam_talk");
    assert.equal(pub.query.has("src"), false, "a publisher has a destination, not a source");
    assert.equal(pub.body, "v=0 offer");
  });

  it("then plays that stream into the camera as A-law 16 kHz", async () => {
    await reset();
    await offer();
    for (let i = 0; i < 50 && !seen.some((r) => r.method === "POST" && r.path === "/api/streams"); i++) await sleep(20);
    const bridge = seen.find((r) => r.method === "POST" && r.path === "/api/streams")!;
    assert.ok(bridge, "the bridge to the camera was started");
    assert.equal(bridge.query.get("dst"), "cam");
    assert.equal(bridge.query.get("src"), "ffmpeg:cam_talk#audio=pcma/16000");
  });

  it("waits until the microphone stream has arrived before bridging, and gives up quietly if it never does", async () => {
    await reset();
    sourceReady = false;
    const res = await offer();
    assert.equal(res.statusCode, 201, "the browser still gets its answer");
    await sleep(300);
    assert.equal(seen.some((r) => r.method === "POST" && r.path === "/api/streams"), false);
    assert.ok(seen.filter((r) => r.method === "GET" && r.path === "/api/streams").length >= 2, "it looked more than once");
  });

  // Every bridge is an ffmpeg that stays connected to the microphone stream after the browser has left. Left alone they pile up
  // and all write into the one speaker, which sounds like crackling. So each conversation starts from a clean stream.
  it("starts every conversation from a fresh microphone stream: the old one, and its bridge, is removed first", async () => {
    await reset();
    await offer();
    await offer();
    const calls = seen.filter((r) => r.path === "/api/streams" && ["PUT", "DELETE"].includes(r.method)).map((r) => `${r.method} ${r.query.get("name") ?? r.query.get("src")}`);
    assert.deepEqual(calls, ["DELETE cam_talk", "PUT cam_talk", "DELETE cam_talk", "PUT cam_talk"]);
    const puts = seen.filter((r) => r.method === "PUT");
    assert.ok(puts[0]!.query.get("src"), "a stream needs a source, even a placeholder, or go2rtc does not keep it");
    // the stream has to exist before the browser publishes into it
    assert.ok(seen.findIndex((r) => r.method === "PUT") < seen.findIndex((r) => r.path === "/api/webrtc"));
  });

  it("stops talking on request: the microphone stream and its bridge go away", async () => {
    await reset();
    const res = await app.inject({ method: "DELETE", url: "/api/talk", headers: { authorization: auth.authorization } });
    assert.equal(res.statusCode, 204);
    const del = seen.filter((r) => r.method === "DELETE");
    assert.equal(del.length, 1);
    assert.equal(del[0]!.query.get("src"), "cam_talk");
    assert.equal((await app.inject({ method: "DELETE", url: "/api/talk" })).statusCode, 401);
  });

  it("never takes the stream names or sources from the request", async () => {
    await reset();
    await offer("?dst=evil&src=exec:rm%20-rf%20/");
    for (let i = 0; i < 50 && !seen.some((r) => r.method === "POST" && r.path === "/api/streams"); i++) await sleep(20);
    for (const r of seen) {
      assert.ok(!r.query.toString().includes("evil") && !r.query.toString().includes("exec"), `${r.method} ${r.path}?${r.query}`);
    }
  });

  it("passes go2rtc's refusal on as a bad gateway and does not start the bridge", async () => {
    await reset();
    publishStatus = 500;
    const res = await offer();
    assert.equal(res.statusCode, 502);
    await sleep(150);
    assert.equal(seen.some((r) => r.method === "POST" && r.path === "/api/streams"), false);
  });

  it("rejects an empty or oversized offer", async () => {
    await reset();
    const empty = await app.inject({ method: "POST", url: "/api/talk", headers: auth, payload: "" });
    assert.ok([400, 415].includes(empty.statusCode), String(empty.statusCode));
    const huge = await app.inject({ method: "POST", url: "/api/talk", headers: auth, payload: "x".repeat(200_000) });
    assert.ok([400, 413].includes(huge.statusCode), String(huge.statusCode));
    assert.equal(seen.length, 0);
  });
});
