import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../go2rtc.js";
import { blackout } from "../privacy.js";

const SNAPSHOT_NAME = /^\d{8}T\d{9}Z\.jpg$/;
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function snapshotsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, go, zones, signer, snapshotsDir } = ctx;
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
}
