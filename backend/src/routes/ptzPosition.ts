import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError, type PtzDirection } from "../go2rtc.js";
import { MOTOR_MAX, MOTOR_MIN, gotoPosition, type GotoOptions, type GotoResult, type Pos } from "../ptzGoto.js";
import { PtzPresetError, parsePresetPosition } from "../ptzPresets.js";
import { QueueFullError } from "../queue.js";

/** What these routes need from the camera: Go2rtc is one, tests bring their own. */
export interface PtzControl {
  move(direction: PtzDirection): Promise<void>;
  /** Where the camera points; refresh asks the camera now instead of using the last answer. */
  position(refresh: boolean): Promise<(Pos & { ageMs: number }) | undefined>;
  calibrate(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const range = { type: "integer", minimum: MOTOR_MIN, maximum: MOTOR_MAX } as const;

/** Where the camera points, going to a position, saved places ("presets"), and calibration. */
export function ptzPositionRoutes(app: FastifyInstance, ctx: AppContext, control: PtzControl = ctx.go, opts: GotoOptions = {}): void {
  const { cfg, recorder, ptzQueue, ptzPresets } = ctx;

  const busy = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      // One command at a time, like every other move: the camera has a single session.
      return await ptzQueue.run(task);
    } catch (e) {
      if (e instanceof QueueFullError) throw new HttpError(429, "the camera is busy with other moves, try again in a moment");
      throw e;
    }
  };

  const go = (target: Pos): Promise<GotoResult> =>
    busy(() =>
      gotoPosition(
        target,
        {
          position: async () => control.position(true),
          step: async (d) => {
            recorder.suppress(cfg.motion.suppressAfterPtzMs); // the picture moves because the camera does
            await control.move(d);
          },
          sleep,
        },
        opts,
      ),
    ).then((r) => {
      if (r.reason === "unknown") throw new HttpError(409, "the camera did not say where it points: is the stream up?");
      return r;
    });

  app.get<{ Querystring: { refresh?: string } }>("/api/ptz/position", async (req) => {
    const p = await control.position(req.query.refresh === "1");
    return p ? { known: true, angle: p.angle, elevation: p.elevation, ageMs: p.ageMs } : { known: false };
  });

  app.post<{ Body: Pos }>(
    "/api/ptz/goto",
    { schema: { body: { type: "object", required: ["angle", "elevation"], additionalProperties: false, properties: { angle: range, elevation: range } } } },
    async (req) => go(req.body),
  );

  app.post("/api/ptz/calibrate", async () => {
    await busy(() => control.calibrate());
    return { ok: true };
  });

  app.get("/api/ptz/presets", async () => ({ presets: ptzPresets.list() }));

  // Saves a named place: the one the camera points at now, or the one given.
  app.post<{ Body: { name: string; angle?: number; elevation?: number } }>(
    "/api/ptz/presets",
    {
      schema: {
        body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", maxLength: 200 }, angle: range, elevation: range } },
      },
    },
    async (req, reply) => {
      const { name, angle, elevation } = req.body;
      if ((angle === undefined) !== (elevation === undefined)) throw new HttpError(400, "give both angle and elevation, or neither");
      let pos: Pos;
      if (angle !== undefined && elevation !== undefined) pos = parsePresetPositionOr400({ angle, elevation });
      else {
        const p = await control.position(true);
        if (!p) throw new HttpError(409, "the camera did not say where it points: is the stream up?");
        pos = { angle: p.angle, elevation: p.elevation };
      }
      try {
        return reply.code(201).send(await ptzPresets.save(name, pos));
      } catch (e) {
        if (e instanceof PtzPresetError) throw new HttpError(400, e.message);
        throw e;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/ptz/presets/:id", async (req, reply) => {
    if (!(await ptzPresets.remove(req.params.id))) throw new HttpError(404, "no such place");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/ptz/presets/:id/go", async (req) => {
    const preset = ptzPresets.get(req.params.id);
    if (!preset) throw new HttpError(404, "no such place");
    return { preset: preset.name, ...(await go({ angle: preset.angle, elevation: preset.elevation })) };
  });
}

function parsePresetPositionOr400(raw: unknown): Pos {
  try {
    return parsePresetPosition(raw);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "bad position");
  }
}
