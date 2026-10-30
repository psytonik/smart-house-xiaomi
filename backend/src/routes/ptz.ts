import { HttpError, PTZ_OPERATIONS, type PtzDirection } from "../go2rtc.js";
import { QueueFullError } from "../queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function ptzRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, go, recorder, ptzQueue } = ctx;
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
}
