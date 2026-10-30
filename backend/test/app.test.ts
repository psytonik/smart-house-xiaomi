import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { defaultMotion, type Config } from "../src/config.js";
import { testConfig } from "./helpers.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };
const EVENT = "20261030T130000000Z";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

describe("backend", () => {
  let mock: Server;
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const motorCalls: string[] = [];
  const seen: string[] = [];
  let motorFailuresLeft = 0;
  let motorDelayMs = 0;
  let motorInFlight = 0;
  let motorMaxInFlight = 0;
  let mp4Opened = 0;

  before(async () => {
    mock = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push(`${req.method} ${url.pathname}?${url.searchParams}`);
      if (url.pathname === "/api/xiaomi/motor" && req.method === "POST") {
        if (motorFailuresLeft > 0) {
          motorFailuresLeft--;
          res.writeHead(404).end("xiaomi: motor: stream has no connected source with a motor");
          return;
        }
        motorCalls.push(`${url.searchParams.get("src")}:${url.searchParams.get("operation")}`);
        motorInFlight++;
        motorMaxInFlight = Math.max(motorMaxInFlight, motorInFlight);
        setTimeout(() => {
          motorInFlight--;
          res.writeHead(200).end();
        }, motorDelayMs);
      } else if (url.pathname === "/api/stream.mp4") {
        mp4Opened++;
        res.writeHead(200, { "content-type": "video/mp4" });
        res.write("x"); // stays open until the client aborts
      } else if (url.pathname === "/api/frame.jpeg") {
        res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
      } else if (url.pathname === "/api/stream.m3u8") {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end("#EXTM3U\nhls/playlist.m3u8?id=abc\n");
      } else if (url.pathname.startsWith("/api/hls/")) {
        res.writeHead(200, { "content-type": "video/mp2t" }).end("segment");
      } else if (url.pathname === "/api/streams") {
        // real go2rtc: ?src=<name> returns the stream object itself, no ?src returns a map
        const body = url.searchParams.has("src") ? { producers: [{}] } : { cam: { producers: [{}] } };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      } else if (url.pathname === "/api/webrtc" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/sdp" }).end("v=0 answer");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const port = (mock.address() as AddressInfo).port;

    dataDir = mkdtempSync(join(tmpdir(), "cam-test-"));
    mkdirSync(join(dataDir, "public"));
    writeFileSync(join(dataDir, "public", "index.html"), "<!doctype html><title>cam</title>");
    const cfg: Config = testConfig({ apiToken: TOKEN, go2rtcUrl: `http://127.0.0.1:${port}`, dataDir, publicDir: join(dataDir, "public") });
    // a saved motion clip (the recorder is disabled in this test)
    const evDir = join(dataDir, "events");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, `${EVENT}.mp4`), Buffer.from("0123456789"));
    writeFileSync(join(evDir, `${EVENT}.jpg`), JPEG);
    writeFileSync(
      join(evDir, `${EVENT}.json`),
      JSON.stringify({ id: EVENT, startedAt: "2026-10-30T13:00:00.000Z", endedAt: "2026-10-30T13:00:09.000Z", durationSec: 14, peak: 5.2, bytes: 10, clip: `${EVENT}.mp4`, thumb: `${EVENT}.jpg` }),
    );
    app = await buildApp(cfg);
  });

  after(async () => {
    await app.close();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("health is public", async () => {
    const res = await app.inject("/health");
    assert.equal(res.statusCode, 200);
  });

  it("api requires the token", async () => {
    assert.equal((await app.inject("/api/status")).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/status", headers: { authorization: "Bearer nope" } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/status", headers: auth })).statusCode, 200);
    // the token in the URL is no longer accepted: URLs leak into logs and history
    assert.equal((await app.inject(`/api/status?token=${TOKEN}`)).statusCode, 401);
  });

  it("status reports the stream", async () => {
    const res = await app.inject({ url: "/api/status", headers: auth });
    const body = res.json();
    assert.deepEqual({ reachable: body.reachable, stream: body.stream, info: body.info }, { reachable: true, stream: "cam", info: { producers: [{}] } });
  });

  it("status reports disk usage of clips and free space", async () => {
    const { storage } = (await app.inject({ url: "/api/status", headers: auth })).json();
    assert.equal(storage.clips, 1);
    assert.equal(storage.usedBytes, 10);
    assert.equal(storage.limitBytes, 1024 ** 3);
    assert.ok(storage.freeBytes > 0, "free space of the data volume");
  });

  it("ptz maps directions to operations and uses the configured stream", async () => {
    for (const d of ["left", "right", "up", "down"]) {
      const res = await app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction: d } });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.deepEqual(motorCalls.slice(-4), ["cam:1", "cam:2", "cam:3", "cam:4"]);
  });

  it("system health combines go2rtc, the picture, the disk and push in one answer", async () => {
    assert.equal((await app.inject("/api/system")).statusCode, 401);
    const body = (await app.inject({ url: "/api/system", headers: auth })).json();
    assert.deepEqual(body.checks.map((c: { id: string }) => c.id), ["go2rtc", "picture", "detection", "disk", "storage", "push"]);
    assert.equal(body.checks[0].level, "ok", "the mock go2rtc answers");
    assert.ok(["ok", "warn", "error"].includes(body.level));
    assert.ok(body.uptimeSec >= 0);
  });

  it("ptz commands from several clients reach the camera one at a time", async () => {
    motorDelayMs = 40;
    motorMaxInFlight = 0;
    const before = motorCalls.length;
    const fire = (direction: string) => app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction } });
    const results = await Promise.all(["left", "right", "up"].map(fire));
    motorDelayMs = 0;
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    assert.equal(motorMaxInFlight, 1, "the camera must never get two moves at once");
    assert.deepEqual(motorCalls.slice(before), ["cam:1", "cam:2", "cam:3"], "in the order they arrived");
  });

  it("ptz answers 429 when too many commands are already waiting", async () => {
    motorDelayMs = 60;
    const fire = () => app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction: "left" } });
    const results = await Promise.all(Array.from({ length: 8 }, fire));
    motorDelayMs = 0;
    const codes = results.map((r) => r.statusCode);
    assert.ok(codes.includes(429), codes.join());
    assert.ok(codes.includes(200), codes.join());
    assert.match(results.find((r) => r.statusCode === 429)!.json().error, /busy/);
  });

  it("ptz rejects bad input", async () => {
    const bad = [{ direction: "sideways" }, {}, { direction: "left", steps: 99 }, { direction: "left", steps: 0 }];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
    // Fastify strips unknown fields instead of rejecting them; they never reach go2rtc.
    const extra = await app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction: "left", x: 1 } });
    assert.equal(extra.statusCode, 200);
  });

  it("ptz retries while the camera session comes up and holds a stream consumer", async () => {
    motorFailuresLeft = 2;
    const before = mp4Opened;
    const res = await app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction: "left", steps: 2 } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(mp4Opened > before, "keeper should open a stream consumer");
    assert.deepEqual(motorCalls.slice(-2), ["cam:1", "cam:1"]);
  });

  it("ptz reports 502 when the camera never accepts", async () => {
    motorFailuresLeft = 99;
    const res = await app.inject({ method: "POST", url: "/api/ptz", headers: auth, payload: { direction: "up" } });
    motorFailuresLeft = 0;
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /did not accept/);
  });

  it("snapshot passes the jpeg through", async () => {
    const res = await app.inject({ url: "/api/snapshot", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.ok(res.rawPayload.equals(JPEG));
  });

  it("snapshots can be saved, listed and fetched", async () => {
    const saved = await app.inject({ method: "POST", url: "/api/snapshots", headers: auth });
    assert.equal(saved.statusCode, 201);
    const { name } = saved.json();
    const list = await app.inject({ url: "/api/snapshots", headers: auth });
    assert.ok(list.json().items.some((i: { name: string }) => i.name === name));
    const file = await app.inject({ url: `/api/snapshots/${name}`, headers: auth });
    assert.equal(file.statusCode, 200);
    assert.ok(file.rawPayload.equals(JPEG));
  });

  it("snapshot names cannot escape the directory", async () => {
    for (const n of ["..%2F..%2Fetc%2Fpasswd", "passwd", "..", "a.jpg"]) {
      const res = await app.inject({ url: `/api/snapshots/${n}`, headers: auth });
      assert.ok([400, 404].includes(res.statusCode), `${n} -> ${res.statusCode}`);
    }
  });

  it("hls is proxied with the stream name forced", async () => {
    const pl = await app.inject({ url: "/api/stream.m3u8?src=other-stream", headers: auth });
    assert.equal(pl.statusCode, 200);
    assert.match(pl.body, /#EXTM3U/);
    assert.ok(seen.some((s) => s === "GET /api/stream.m3u8?src=cam&mp4="), "src must be forced to configured stream");

    const seg = await app.inject({ url: "/api/hls/playlist.m3u8?id=abc&src=other&token=zzz", headers: auth });
    assert.equal(seg.statusCode, 200);
    const last = seen.at(-1)!;
    assert.match(last, /^GET \/api\/hls\/playlist\.m3u8\?/);
    assert.ok(last.includes("src=cam") && last.includes("id=abc") && !last.includes("zzz"), last);

    const trav = await app.inject({ url: "/api/hls/..%2F..%2Fapi%2Fconfig", headers: auth });
    assert.ok([400, 404].includes(trav.statusCode));
  });

  it("webrtc offers are forwarded", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webrtc",
      headers: { ...auth, "content-type": "application/sdp" },
      payload: "v=0 offer",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "v=0 answer");
  });

  it("does not expose other go2rtc endpoints", async () => {
    for (const p of ["/api/config", "/api/streams", "/api/go2rtc", "/api/xiaomi"]) {
      const res = await app.inject({ url: p, headers: auth });
      assert.equal(res.statusCode, 404, p);
    }
  });

  it("serves the web app at / without a token, but the API stays protected", async () => {
    const page = await app.inject("/");
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<title>cam<\/title>/);
    assert.equal((await app.inject("/api/snapshots")).statusCode, 401);
  });

  it("motion status is available", async () => {
    const res = await app.inject({ url: "/api/motion", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: false, state: "off", recording: false, level: 0, threshold: 1.2, unstable: false });
  });

  it("lists motion clips and serves clip, thumbnail and ranges", async () => {
    const list = await app.inject({ url: "/api/events", headers: auth });
    assert.equal(list.json().items[0].id, EVENT);

    const clip = await app.inject({ url: `/api/events/${EVENT}/clip`, headers: auth });
    assert.equal(clip.statusCode, 200);
    assert.equal(clip.headers["content-type"], "video/mp4");
    assert.equal(clip.body, "0123456789");

    const part = await app.inject({ url: `/api/events/${EVENT}/clip`, headers: { ...auth, range: "bytes=2-5" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], "bytes 2-5/10");
    assert.equal(part.body, "2345");

    const tail = await app.inject({ url: `/api/events/${EVENT}/clip`, headers: { ...auth, range: "bytes=-3" } });
    assert.equal(tail.body, "789");

    const bad = await app.inject({ url: `/api/events/${EVENT}/clip`, headers: { ...auth, range: "bytes=50-60" } });
    assert.equal(bad.statusCode, 416);

    const thumb = await app.inject({ url: `/api/events/${EVENT}/thumb`, headers: auth });
    assert.ok(thumb.rawPayload.equals(JPEG));
  });

  it("event ids are validated and the events API needs the token", async () => {
    assert.equal((await app.inject(`/api/events`)).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/events/..%2Fsecret/clip", headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/events/20990101T000000000Z/clip", headers: auth })).statusCode, 404);
  });

  it("lists carry signed links that open media without the Authorization header", async () => {
    const [item] = (await app.inject({ url: "/api/events", headers: auth })).json().items;
    assert.match(item.clipUrl, new RegExp(`^/api/events/${EVENT}/clip\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    assert.match(item.thumbUrl, /^\/api\/events\/.+\/thumb\?exp=/);

    const clip = await app.inject(item.clipUrl);
    assert.equal(clip.statusCode, 200);
    assert.equal(clip.body, "0123456789");
    // players stream with Range requests, a signed link must support them
    const part = await app.inject({ url: item.clipUrl, headers: { range: "bytes=2-5" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, "2345");
    assert.ok((await app.inject(item.thumbUrl)).rawPayload.equals(JPEG));

    const snap = (await app.inject({ url: "/api/snapshots", headers: auth })).json().items[0];
    assert.match(snap.url, /^\/api\/snapshots\/\d{8}T\d{9}Z\.jpg\?exp=/);
    assert.ok((await app.inject(snap.url)).rawPayload.equals(JPEG));
  });

  it("a signed link cannot be reused for anything else", async () => {
    const [item] = (await app.inject({ url: "/api/events", headers: auth })).json().items;
    const { search } = new URL(item.clipUrl, "http://x");

    // other file, other endpoint, other method
    assert.equal((await app.inject(`/api/events/${EVENT}/thumb${search}`)).statusCode, 401);
    assert.equal((await app.inject(`/api/status${search}`)).statusCode, 401);
    assert.equal((await app.inject(`/api/snapshots${search}`)).statusCode, 401);
    assert.equal((await app.inject({ method: "DELETE", url: item.clipUrl })).statusCode, 401);

    // tampered expiry or signature, missing parts
    const params = new URLSearchParams(search);
    const exp = Number(params.get("exp"));
    assert.equal((await app.inject(`/api/events/${EVENT}/clip?exp=${exp + 1}&sig=${params.get("sig")}`)).statusCode, 401);
    assert.equal((await app.inject(`/api/events/${EVENT}/clip?exp=${exp}&sig=${"0".repeat(64)}`)).statusCode, 401);
    assert.equal((await app.inject(`/api/events/${EVENT}/clip?exp=${exp}`)).statusCode, 401);
    assert.equal((await app.inject(`/api/events/${EVENT}/clip`)).statusCode, 401);
  });

  it("a motion clip can be deleted", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/events/${EVENT}`, headers: auth });
    assert.equal(del.statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/events/${EVENT}`, headers: auth })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: "/api/events", headers: auth })).json().items, []);
  });
});
