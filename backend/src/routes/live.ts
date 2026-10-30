import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { HttpError } from "../go2rtc.js";

async function pipe(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  reply.code(res.status);
  for (const h of ["content-type", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!res.body) return reply.send();
  return reply.send(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream));
}
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/** How long a reset waits for other viewers (other tabs) to go away. */
const RESET_WAIT_MS = 6000;

/** Number of consumers go2rtc has on the stream right now. */
async function consumerCount(go: AppContext["go"]): Promise<number> {
  try {
    // With ?src=<name> go2rtc returns that stream's own object.
    const info = (await (await go.get("/api/streams")).json()) as { consumers?: unknown };
    return Array.isArray(info.consumers) ? info.consumers.length : 0;
  } catch {
    return 0;
  }
}

export function liveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { go, recorder } = ctx;
  // --- live video: only these go2rtc endpoints are exposed, stream name is forced ---
  // "mp4" makes go2rtc cut fMP4 segments, which is the only HLS flavour that carries H.265.
  app.get("/api/stream.m3u8", async (_req, reply) => pipe(reply, await go.get("/api/stream.m3u8", { mp4: "" })));

  app.get<{ Params: { "*": string }; Querystring: Record<string, string> }>("/api/hls/*", async (req, reply) => {
    const rest = req.params["*"];
    if (rest.includes("..")) throw new HttpError(400, "bad path");
    const { token: _t, src: _s, ...params } = req.query;
    return pipe(reply, await go.get(`/api/hls/${rest}`, params));
  });

  // Reset the stream: let go of the camera so go2rtc drops its session and opens a fresh one (no queue of old
  // frames, no damaged picture). The browser closes its own player first; this stops the recorder, waits until
  // nobody else is watching, and starts the recorder again.
  app.post("/api/stream/reset", async () => {
    await recorder.suspend();
    go.close(); // the PTZ keep-alive consumer
    let viewers = 0;
    try {
      const deadline = Date.now() + RESET_WAIT_MS;
      for (;;) {
        viewers = await consumerCount(go);
        if (viewers === 0 || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      // go2rtc closes the camera session when the last consumer leaves; give it a moment to do so.
      if (viewers === 0) await new Promise((r) => setTimeout(r, 1500));
    } finally {
      recorder.resume();
    }
    return { ok: true, otherViewers: viewers };
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
}
