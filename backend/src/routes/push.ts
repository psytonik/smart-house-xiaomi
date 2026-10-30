import { HttpError } from "../go2rtc.js";
import { PushInputError } from "../push.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function pushRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, push } = ctx;
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
}
