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

export function liveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { go } = ctx;
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
}
