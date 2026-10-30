import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FailureLimiter } from "./authLimiter.js";
import type { Config } from "./config.js";
import { ObjectDetector } from "./detect.js";
import { EVENT_ID } from "./events.js";
import { Go2rtc, HttpError, PTZ_OPERATIONS, type PtzDirection } from "./go2rtc.js";
import { assess } from "./health.js";
import { CozyLight, LightError } from "./light.js";
import { registerLights } from "./lights.js";
import { blackout } from "./privacy.js";
import { PushInputError, PushService } from "./push.js";
import { QueueFullError, SerialQueue } from "./queue.js";
import { MotionRecorder } from "./recorder.js";
import { UrlSigner, isSignable } from "./signing.js";
import { REGIONS, XiaomiSetup, type LoginInput, type Region } from "./xiaomi.js";
import { ZoneError, ZoneStore, parseZones } from "./zones.js";

const SNAPSHOT_NAME = /^\d{8}T\d{9}Z\.jpg$/;
const sha = (s: string) => createHash("sha256").update(s).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The token comes only from the Authorization header: URLs end up in logs and browser history. */
function tokenFrom(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function pipe(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  reply.code(res.status);
  for (const h of ["content-type", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!res.body) return reply.send();
  return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
}

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const go = new Go2rtc(cfg, (m) => app.log.debug(m));
  const snapshotsDir = join(cfg.dataDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });

  const recorder = new MotionRecorder(cfg, (m) => app.log.info(m));
  const zones = new ZoneStore(cfg.dataDir);
  await zones.init();
  recorder.setZones(zones.get());

  const detector = cfg.detect.enabled ? await ObjectDetector.load(cfg.detect.modelPath, cfg.detect.minScore, (m) => app.log.info(m)) : null;
  if (detector) recorder.setDetector(detector);

  const push = new PushService(cfg, { log: (m) => app.log.info(m) });
  await push.init();
  push.attach(recorder);
  await recorder.start();

  const signer = new UrlSigner(cfg.apiToken, cfg.signedUrlTtlSec);
  const limiter = new FailureLimiter(cfg.authMaxFailures, cfg.authWindowSec * 1000);
  const ptzQueue = new SerialQueue(4);
  const xiaomi = new XiaomiSetup(cfg);

  app.addHook("onClose", async () => {
    go.close();
    push.close();
    await recorder.stop();
  });

  // Plain-HTTP LAN app: no HSTS and no upgrade-insecure-requests. Inline code is forbidden outright.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "blob:", "data:"],
        "media-src": ["'self'", "blob:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
    strictTransportSecurity: false,
    referrerPolicy: { policy: "no-referrer" },
  });

  // WebRTC offers may arrive as raw SDP.
  app.addContentTypeParser(["application/sdp", "text/plain"], { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.message });
  });

  // --- auth: everything under /api requires the token (or a signed link for one media file) ---
  const expected = sha(cfg.apiToken);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;
    if ((req.method === "GET" || req.method === "HEAD") && isSignable(url.pathname) && signer.verify(url.pathname, q.get("exp"), q.get("sig"))) return;

    const given = tokenFrom(req);
    // No credentials is not a guess (an expired signed link, a logged-out tab): it is refused but not counted.
    if (!given) return reply.code(401).send({ error: "unauthorized" });
    const wait = limiter.retryAfterSec(req.ip);
    if (wait > 0) return reply.code(429).header("retry-after", wait).send({ error: `too many wrong tokens, try again in ${wait} s` });
    if (!timingSafeEqual(sha(given), expected)) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
    limiter.succeed(req.ip);
  });

  app.get("/health", async () => ({ ok: true }));

  // --- status ---
  app.get("/api/status", async () => {
    const storage = await recorder.storage();
    try {
      const res = await go.get("/api/streams");
      if (!res.ok) return { reachable: true, stream: cfg.stream, info: null, storage };
      // With ?src=<name> go2rtc returns that stream's object itself; without it, a map by name.
      const body = (await res.json()) as Record<string, unknown>;
      const info = "producers" in body || "consumers" in body ? body : (body[cfg.stream] ?? null);
      return { reachable: true, stream: cfg.stream, info, storage };
    } catch {
      return { reachable: false, stream: cfg.stream, info: null, storage };
    }
  });

  // --- everything the system panel needs, in plain language ---
  app.get("/api/system", async () => {
    let reachable = true;
    try {
      await go.get("/api/streams");
    } catch {
      reachable = false;
    }
    const health = assess({
      go2rtc: { reachable },
      recorder: recorder.health(),
      storage: await recorder.storage(),
      push: { devices: push.devices() },
      detection: detector ? { state: "ready", model: detector.model } : { state: cfg.detect.enabled ? "unavailable" : "off" },
    });
    return { ...health, uptimeSec: Math.floor(process.uptime()) };
  });

  // --- PTZ ---
  app.post<{ Body: { direction: PtzDirection; steps?: number } }>(
    "/api/ptz",
    {
      schema: {
        body: {
          type: "object",
          required: ["direction"],
          additionalProperties: false,
          properties: {
            direction: { type: "string", enum: Object.keys(PTZ_OPERATIONS) },
            steps: { type: "integer", minimum: 1, maximum: 5, default: 1 },
          },
        },
      },
    },
    async (req) => {
      const { direction, steps = 1 } = req.body;
      try {
        // One command at a time: the camera has a single session, and a stale move is worse than a refusal.
        await ptzQueue.run(async () => {
          for (let i = 0; i < steps; i++) {
            if (i > 0) await sleep(300);
            recorder.suppress(cfg.motion.suppressAfterPtzMs); // the picture moves because the camera does
            await go.move(direction);
          }
        });
      } catch (e) {
        if (e instanceof QueueFullError) throw new HttpError(429, "the camera is busy with other moves, try again in a moment");
        throw e;
      }
      return { ok: true, direction, steps };
    },
  );

  // --- snapshots ---
  async function grabFrame(): Promise<Buffer> {
    const res = await go.get("/api/frame.jpeg");
    if (!res.ok) {
      throw new HttpError(502, `snapshot failed (go2rtc ${res.status}); JPEG conversion in go2rtc needs ffmpeg in PATH`);
    }
    const jpg = Buffer.from(await res.arrayBuffer());
    // Private areas are painted over before the picture leaves this function (live view and saved files alike).
    try {
      return await blackout(jpg, zones.get(), cfg.ffmpegPath);
    } catch (e) {
      throw new HttpError(502, `the picture was not shown because the private areas could not be hidden (${e instanceof Error ? e.message : e})`);
    }
  }

  app.get("/api/snapshot", async (_req, reply) => {
    const jpg = await grabFrame();
    return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpg);
  });

  app.post("/api/snapshots", async (_req, reply) => {
    const jpg = await grabFrame();
    const name = new Date().toISOString().replace(/[-:.]/g, "") + ".jpg";
    await writeFile(join(snapshotsDir, name), jpg);
    return reply.code(201).send({ name, bytes: jpg.length });
  });

  app.get("/api/snapshots", async () => {
    const names = (await readdir(snapshotsDir)).filter((n) => SNAPSHOT_NAME.test(n)).sort().reverse();
    const items = await Promise.all(
      names.map(async (name) => ({ name, bytes: (await stat(join(snapshotsDir, name))).size, url: signer.sign(`/api/snapshots/${name}`) })),
    );
    return { items };
  });

  app.get<{ Params: { name: string } }>("/api/snapshots/:name", async (req, reply) => {
    const { name } = req.params;
    if (!SNAPSHOT_NAME.test(name)) throw new HttpError(400, "bad snapshot name");
    try {
      return reply.header("content-type", "image/jpeg").send(await readFile(join(snapshotsDir, name)));
    } catch {
      throw new HttpError(404, "snapshot not found");
    }
  });

  // --- motion clips ---
  async function sendFile(req: FastifyRequest, reply: FastifyReply, path: string, type: string) {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new HttpError(404, "file not found");
    }
    reply.header("content-type", type).header("accept-ranges", "bytes");
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(createReadStream(path, { start, end }));
    }
    return reply.header("content-length", size).send(createReadStream(path));
  }

  app.get("/api/motion", async () => recorder.status());

  app.get<{ Querystring: { limit?: string } }>("/api/events", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const items = (await recorder.store.list(limit)).map((c) => ({
      ...c,
      clipUrl: signer.sign(`/api/events/${c.id}/clip`),
      thumbUrl: c.thumb ? signer.sign(`/api/events/${c.id}/thumb`) : null,
    }));
    return { items };
  });

  app.get<{ Params: { id: string } }>("/api/events/:id/clip", async (req, reply) => {
    if (!EVENT_ID.test(req.params.id)) throw new HttpError(400, "bad event id");
    return sendFile(req, reply, recorder.store.file(`${req.params.id}.mp4`), "video/mp4");
  });

  app.get<{ Params: { id: string } }>("/api/events/:id/thumb", async (req, reply) => {
    if (!EVENT_ID.test(req.params.id)) throw new HttpError(400, "bad event id");
    return sendFile(req, reply, recorder.store.file(`${req.params.id}.jpg`), "image/jpeg");
  });

  app.delete<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
    if (!EVENT_ID.test(req.params.id)) throw new HttpError(400, "bad event id");
    if (!(await recorder.store.remove(req.params.id))) throw new HttpError(404, "event not found");
    recorder.invalidateStorage();
    return reply.code(204).send();
  });

  // --- motion zones and private areas ---
  app.get("/api/zones", async () => ({ zones: zones.get() }));

  app.put("/api/zones", async (req) => {
    let parsed;
    try {
      parsed = parseZones((req.body as { zones?: unknown } | null | undefined)?.zones);
    } catch (e) {
      if (e instanceof ZoneError) throw new HttpError(400, e.message);
      throw e;
    }
    await zones.set(parsed);
    recorder.setZones(parsed);
    return { zones: parsed };
  });

  // --- push notifications ---
  app.get("/api/push", async () => ({ devices: push.devices(), minIntervalSec: cfg.pushMinIntervalSec }));

  const tokenBody = { type: "object", required: ["token"], properties: { token: { type: "string", minLength: 1, maxLength: 200 } } } as const;

  app.post<{ Body: { token: string } }>("/api/push/register", { schema: { body: tokenBody } }, async (req) => {
    try {
      const added = await push.register(req.body.token);
      return { registered: true, added, devices: push.devices() };
    } catch (e) {
      if (e instanceof PushInputError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  app.post<{ Body: { token: string } }>("/api/push/unregister", { schema: { body: tokenBody } }, async (req) => {
    const removed = await push.unregister(req.body.token);
    return { removed, devices: push.devices() };
  });

  app.post("/api/push/test", async () => {
    const sent = await push.sendTest();
    if (sent === 0) throw new HttpError(409, "no phone is registered for notifications yet");
    return { sent };
  });

  // --- cameras and Mi Home sign-in (ADR 0013): the browser never sends a stream source ---
  app.get("/api/cameras", async () => ({ streams: await xiaomi.streams(), accounts: await xiaomi.accounts() }));

  app.post("/api/xiaomi/login", async (req) => {
    const b = req.body;
    const keys = b && typeof b === "object" ? Object.keys(b) : [];
    const str = (k: string) => (b as Record<string, unknown>)[k];
    const filled = (k: string) => typeof str(k) === "string" && (str(k) as string).length > 0;
    let input: LoginInput | undefined;
    if (keys.length === 2 && filled("username") && filled("password")) input = { username: str("username") as string, password: str("password") as string };
    else if (keys.length === 1 && filled("captcha")) input = { captcha: str("captcha") as string };
    else if (keys.length === 1 && filled("verify")) input = { verify: str("verify") as string };
    if (!input) throw new HttpError(400, "send username and password, or a captcha answer, or a verification code");
    return xiaomi.login(input);
  });

  app.get<{ Querystring: { account?: string; region?: string } }>("/api/xiaomi/devices", async (req) => {
    const { account = "", region = "" } = req.query;
    return { devices: await xiaomi.devices(account, region as Region) };
  });

  app.post<{ Body: { account: string; region: Region; did: string; name: string } }>(
    "/api/cameras",
    {
      schema: {
        body: {
          type: "object",
          required: ["account", "region", "did", "name"],
          additionalProperties: false,
          properties: {
            account: { type: "string", maxLength: 40 },
            region: { type: "string", enum: [...REGIONS] },
            did: { type: "string", maxLength: 80 },
            name: { type: "string", maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(await xiaomi.add(req.body)),
  );

  // --- lamp (CozyLife, local network) ---
  const light = cfg.lightIp ? new CozyLight(cfg.lightIp, cfg.lightPort) : undefined;

  app.get("/api/light", async () => {
    if (!light) return { configured: false };
    try {
      return { configured: true, reachable: true, ...(await light.state()) };
    } catch {
      return { configured: true, reachable: false };
    }
  });

  app.post<{ Body: { on?: boolean; brightness?: number; hue?: number; saturation?: number; temperature?: number } }>(
    "/api/light",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            on: { type: "boolean" },
            brightness: { type: "integer", minimum: 0, maximum: 100 },
            hue: { type: "integer", minimum: 0, maximum: 360 },
            saturation: { type: "integer", minimum: 0, maximum: 100 },
            temperature: { type: "integer", minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (req) => {
      if (!light) throw new HttpError(404, "lamp is not configured (set LIGHT_IP)");
      try {
        return { configured: true, reachable: true, ...(await light.set(req.body)) };
      } catch (e) {
        if (e instanceof LightError) throw new HttpError(502, e.message);
        throw e;
      }
    },
  );

  registerLights(app, { cozy: light }); // both lamps in one list, see lights.ts

  // --- live video: only these go2rtc endpoints are exposed, stream name is forced ---
  // "mp4" makes go2rtc cut fMP4 segments, which is the only HLS flavour that carries H.265.
  app.get("/api/stream.m3u8", async (_req, reply) => pipe(reply, await go.get("/api/stream.m3u8", { mp4: "" })));

  app.get<{ Params: { "*": string }; Querystring: Record<string, string> }>("/api/hls/*", async (req, reply) => {
    const rest = req.params["*"];
    if (rest.includes("..")) throw new HttpError(400, "bad path");
    const { token: _t, src: _s, ...params } = req.query;
    return pipe(reply, await go.get(`/api/hls/${rest}`, params));
  });

  app.post("/api/webrtc", async (req, reply) => {
    const isSdp = typeof req.body === "string";
    const res = await go.postText(
      "/api/webrtc",
      isSdp ? (req.body as string) : JSON.stringify(req.body),
      isSdp ? "application/sdp" : "application/json",
    );
    return pipe(reply, res);
  });

  // --- web app (public shell; all data goes through the token-protected /api) ---
  if (existsSync(cfg.publicDir)) {
    await app.register(fastifyStatic, { root: cfg.publicDir });
  }

  return app;
}
