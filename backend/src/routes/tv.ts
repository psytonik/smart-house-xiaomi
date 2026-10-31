import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../go2rtc.js";
import { TvError, TvRemote } from "../tv.js";
import { APPS, APP_IDS, KEY_NAMES, type TvApp, type TvKey } from "../tv/messages.js";

/** A Google TV / Android TV (TCL and others) on the local network, as a remote control. Configured with TV_IP (backend/.env). */
export function tvRoutes(app: FastifyInstance, ctx: AppContext, env: NodeJS.ProcessEnv = process.env): void {
  let tv: TvRemote | undefined;
  const host = env.TV_IP?.trim();
  if (host) {
    const port = (name: string, fallback: number) => {
      const n = Number(env[name] ?? fallback);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
      return n;
    };
    try {
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error("TV_IP must be an address or a name");
      tv = new TvRemote({ host, dataDir: ctx.cfg.dataDir, remotePort: port("TV_REMOTE_PORT", 6466), pairingPort: port("TV_PAIRING_PORT", 6467), log: (m) => app.log.info(m) });
      tv.start();
      app.addHook("onClose", async () => tv?.stop());
    } catch (e) {
      app.log.warn(`tv disabled: ${(e as Error).message}`); // a wrong setting is a setup mistake, not a crash
      tv = undefined;
    }
  }

  const need = (): TvRemote => {
    if (!tv) throw new HttpError(404, "the TV is not configured (set TV_IP in backend/.env)");
    return tv;
  };
  const guarded = async (change: () => void | Promise<void>) => {
    try {
      await change();
    } catch (e) {
      if (e instanceof TvError) throw new HttpError(e.status, e.message);
      throw e;
    }
    return { ok: true };
  };

  const apps = APP_IDS.map((id) => ({ id, label: APPS[id].label }));

  app.get("/api/tv", async () => (tv ? { configured: true, ...tv.status(), apps } : { configured: false }));

  // Pairing: the TV shows a six-character code; the person types it in. Done once.
  app.post("/api/tv/pair", () => guarded(() => need().beginPairing()));
  app.post<{ Body: { code: string } }>(
    "/api/tv/pair/code",
    { schema: { body: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", maxLength: 16 } } } } },
    (req) => guarded(() => need().finishPairing(req.body.code.trim())),
  );
  app.post("/api/tv/pair/cancel", () => guarded(() => need().cancelPairing()));

  app.post<{ Body: { key: TvKey } }>(
    "/api/tv/key",
    { schema: { body: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", enum: KEY_NAMES } } } } },
    (req) => guarded(() => need().press(req.body.key)),
  );

  app.post<{ Body: { app: TvApp } }>(
    "/api/tv/app",
    { schema: { body: { type: "object", additionalProperties: false, required: ["app"], properties: { app: { type: "string", enum: APP_IDS } } } } },
    (req) => guarded(() => need().launch(req.body.app)),
  );
}
