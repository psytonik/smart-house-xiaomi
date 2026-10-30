import { assess } from "../health.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function statusRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, go, recorder, push, detector } = ctx;
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
}
