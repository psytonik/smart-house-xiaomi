import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import type { Config } from "./config.js";
import { createContext } from "./context.js";
import { HttpError } from "./go2rtc.js";
import { assistantRoutes } from "./routes/assistant.js";
import { camerasRoutes } from "./routes/cameras.js";
import { eventsRoutes } from "./routes/events.js";
import { lampRoutes } from "./routes/lamp.js";
import { liveRoutes } from "./routes/live.js";
import { ptzRoutes } from "./routes/ptz.js";
import { pushRoutes } from "./routes/push.js";
import { snapshotsRoutes } from "./routes/snapshots.js";
import { statusRoutes } from "./routes/status.js";
import { devicesRoutes } from "./routes/devices.js";
import { tvRoutes } from "./routes/tv.js";
import { vacuumRoutes } from "./routes/vacuum.js";
import { zonesRoutes } from "./routes/zones.js";
import { registerSecurity } from "./security.js";

/** Composition root: builds the services once, then lets every route module take what it needs. */
export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const ctx = await createContext(cfg, { info: (m) => app.log.info(m), debug: (m) => app.log.debug(m) });
  app.addHook("onClose", () => ctx.close());

  await registerSecurity(app, ctx);

  // WebRTC offers may arrive as raw SDP.
  app.addContentTypeParser(["application/sdp", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: err.message });
  });

  app.get("/health", async () => ({ ok: true }));

  for (const routes of [assistantRoutes, statusRoutes, ptzRoutes, snapshotsRoutes, eventsRoutes, zonesRoutes, pushRoutes, camerasRoutes, lampRoutes, devicesRoutes, vacuumRoutes, tvRoutes, liveRoutes]) {
    routes(app, ctx);
  }

  // Web app (public shell; all data goes through the token-protected /api).
  if (existsSync(cfg.publicDir)) {
    await app.register(fastifyStatic, { root: cfg.publicDir });
    // The pages have their own addresses (/vacuum, /lights, /tv); a reload or a bookmark must still get the app.
    for (const page of ["/vacuum", "/lights", "/tv"]) app.get(page, (_req, reply) => reply.sendFile("index.html"));
  }

  return app;
}
