import { HttpError } from "../go2rtc.js";
import { ZoneError, parseZones } from "../zones.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function zonesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { zones, recorder } = ctx;
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
}
