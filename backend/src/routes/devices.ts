import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { DEVICE_KINDS, DeviceError, PROTOCOLS, envDevices, viewOf, type DeviceView } from "../devices.js";
import { realDeps, discover, type Candidate, type CloudStatus, type DiscoverDeps } from "../discovery.js";
import { HttpError } from "../go2rtc.js";

/** How long a scan's answers stay available to "add" (the tokens in them live only in memory). */
export const SCAN_TTL_MS = 10 * 60_000;

/** A candidate as the web app sees it: no token, and whether it is already in the list. */
interface CandidateView extends Omit<Candidate, "token"> {
  hasToken: boolean;
  known: boolean;
}

/** The registry of devices at home: what is there, what the network offers, and adding by choosing (not by typing addresses). */
export function devicesRoutes(app: FastifyInstance, ctx: AppContext, env: NodeJS.ProcessEnv = process.env, deps: DiscoverDeps = realDeps(ctx.cfg.dataDir, env)): void {
  const { devices } = ctx;
  let scan: { at: number; byKey: Map<string, Candidate>; cloud: CloudStatus } | undefined;
  let scanning = false;

  // The camera's address lives in go2rtc, not in .env: ask for it, so the search recognises the camera as already there.
  const fromEnv = async (): Promise<DeviceView[]> => envDevices(ctx.cfg, env, await ctx.xiaomi.cameraIdentity());
  const all = async (): Promise<DeviceView[]> => [...(await fromEnv()), ...devices.list().map(viewOf)];
  const isKnown = async (c: { host?: string; did?: string }): Promise<boolean> =>
    !!devices.find(c) || (await fromEnv()).some((d) => (c.host !== undefined && d.host === c.host) || (c.did !== undefined && d.did === c.did));
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof DeviceError) throw new HttpError(400, e.message);
      throw e;
    }
  };

  app.get("/api/devices", async () => ({ devices: await all() }));

  // Asks the network (a broadcast) and the Xiaomi account. Only on a press of the button, never on a timer.
  app.post("/api/devices/scan", async () => {
    if (scanning) throw new HttpError(409, "a search is already running");
    scanning = true;
    try {
      const result = await discover(deps);
      scan = { at: Date.now(), byKey: new Map(result.candidates.map((c) => [c.key, c])), cloud: result.cloud };
      const candidates: CandidateView[] = await Promise.all(result.candidates.map(async ({ token, ...c }) => ({ ...c, hasToken: token !== undefined, known: await isKnown(c) })));
      return { candidates, cloud: result.cloud, ...(result.cloudMessage && { cloudMessage: result.cloudMessage }) };
    } finally {
      scanning = false;
    }
  });

  // Adds a device the last search found. The client names it by `key`; the token is taken from the server's own memory of the search.
  app.post<{ Body: { key: string; name?: string; room?: string } }>(
    "/api/devices",
    { schema: { body: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", maxLength: 120 }, name: { type: "string" }, room: { type: "string" } } } } },
    async (req, reply) => {
      if (!scan || Date.now() - scan.at > SCAN_TTL_MS) throw new HttpError(409, "search for devices first: the last search is too old or missing");
      const c = scan.byKey.get(req.body.key);
      if (!c) throw new HttpError(404, "that device was not in the last search");
      if (await isKnown(c)) throw new HttpError(409, "that device is already in the list");
      const rec = await guard(() =>
        devices.add({
          kind: c.kind,
          protocol: c.protocol,
          name: req.body.name ?? c.name,
          ...(req.body.room && { room: req.body.room }),
          ...(c.host && { host: c.host }),
          ...(c.model && { model: c.model }),
          ...(c.did && { did: c.did }),
          ...(c.token && { token: c.token }),
          origin: "discovered",
        }),
      );
      return reply.code(201).send(viewOf(rec));
    },
  );

  // For a device the search cannot see: the address and kind are typed in.
  app.post<{ Body: { kind: string; protocol: string; name: string; host: string; room?: string; model?: string; token?: string } }>(
    "/api/devices/manual",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "protocol", "name", "host"],
          properties: {
            kind: { type: "string", enum: [...DEVICE_KINDS] },
            protocol: { type: "string", enum: [...PROTOCOLS] },
            name: { type: "string" },
            host: { type: "string", maxLength: 15 },
            room: { type: "string" },
            model: { type: "string" },
            token: { type: "string", maxLength: 32 },
          },
        },
      },
    },
    async (req, reply) => {
      if (await isKnown({ host: req.body.host })) throw new HttpError(409, "a device with this address is already in the list");
      const rec = await guard(() => devices.add({ ...(req.body as Parameters<typeof devices.add>[0]), origin: "manual" }));
      return reply.code(201).send(viewOf(rec));
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; room?: string } }>(
    "/api/devices/:id",
    { schema: { body: { type: "object", additionalProperties: false, minProperties: 1, properties: { name: { type: "string" }, room: { type: "string" } } } } },
    async (req) => {
      if (req.params.id.startsWith("env-")) throw new HttpError(400, "this device is set in .env: change its name there");
      const rec = await guard(() => devices.update(req.params.id, req.body));
      if (!rec) throw new HttpError(404, "no such device");
      return viewOf(rec);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req, reply) => {
    if (req.params.id.startsWith("env-")) throw new HttpError(400, "this device is set in .env: remove it there");
    if (!(await devices.remove(req.params.id))) throw new HttpError(404, "no such device");
    return reply.code(204).send();
  });
}
