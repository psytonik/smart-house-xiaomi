import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { EVENT_ID } from "../events.js";
import { HttpError } from "../go2rtc.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function eventsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { recorder, signer } = ctx;
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
}
