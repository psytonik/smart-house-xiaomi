import { HttpError } from "../go2rtc.js";
import { LightError } from "../light.js";
import { registerLights } from "../lights.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function lampRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { light } = ctx;
  // --- lamp (CozyLife, local network) ---

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
}
