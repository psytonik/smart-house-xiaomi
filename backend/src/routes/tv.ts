import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../go2rtc.js";
import { TvError, TvRemote } from "../tv.js";
import { findAdb, TvAdb } from "../tvAdb.js";
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

  // The TV's own "Source Choice" menu and its inputs go over ADB (TV_ADB=host:5555): a TCL ignores them on the remote protocol.
  let adb: TvAdb | undefined;
  const adbTarget = env.TV_ADB?.trim();
  if (adbTarget) {
    const path = findAdb(env);
    try {
      if (!path) throw new Error("adb was not found (install it, or set TV_ADB_PATH)");
      adb = new TvAdb(adbTarget, path, (m) => app.log.info(m));
    } catch (e) {
      app.log.warn(`tv adb disabled: ${(e as Error).message}`);
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

  // an app that opens by its component needs ADB: it is not offered without it
  const apps = APP_IDS.filter((id) => adb || !APPS[id]!.component).map((id) => ({ id, label: APPS[id]!.label }));

  app.get("/api/tv", async () => (tv ? { configured: true, ...tv.status(), apps, adb: adb !== undefined } : { configured: false }));

  // What the TV's Source Choice offers (Home, TV, HDMI 1, HDMI 2, AV, Media Player), found out from the TV itself.
  app.get("/api/tv/sources", async () => {
    if (!adb) throw new HttpError(404, "sources need ADB: set TV_ADB (the TV's address and port 5555) in backend/.env");
    const robot = adb;
    let sources: Awaited<ReturnType<TvAdb["sources"]>> = [];
    await guarded(async () => {
      sources = await robot.sources();
    });
    return { sources };
  });

  // What is open in the TV's memory (apps a person opened, and a few helpers), and closing it.
  app.get("/api/tv/running", async () => {
    if (!adb) throw new HttpError(404, "the running apps need ADB: set TV_ADB in backend/.env");
    const robot = adb;
    let apps: Awaited<ReturnType<TvAdb["running"]>> = [];
    await guarded(async () => {
      apps = await robot.running();
    });
    return { apps };
  });

  app.post<{ Body: { packages?: string[]; all?: boolean } }>(
    "/api/tv/running/close",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          // either some packages, or all of them
          oneOf: [{ required: ["packages"] }, { required: ["all"] }],
          properties: {
            packages: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", pattern: "^[A-Za-z0-9._]{1,200}$" } },
            all: { type: "boolean", enum: [true] },
          },
        },
      },
    },
    async (req) => {
      const robot = adb;
      if (!robot) throw new HttpError(404, "closing apps needs ADB: set TV_ADB in backend/.env");
      let closed: string[] = [];
      await guarded(async () => {
        closed = await robot.close(req.body.all ? "all" : req.body.packages!);
      });
      return { ok: true, closed };
    },
  );

  app.post<{ Body: { source: string } }>(
    "/api/tv/source",
    { schema: { body: { type: "object", additionalProperties: false, required: ["source"], properties: { source: { type: "string", pattern: "^[a-z0-9]{1,16}$" } } } } },
    (req) => {
      const robot = adb;
      if (!robot) throw new HttpError(404, "sources need ADB: set TV_ADB (the TV's address and port 5555) in backend/.env");
      return guarded(() => robot.switchTo(req.body.source));
    },
  );

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
    (req) => {
      // the INPUT key of this app opens the TV's own Source Choice, which only ADB can reach
      if (req.body.key === "input" && adb) return guarded(() => adb!.openSourceMenu());
      return guarded(() => need().press(req.body.key));
    },
  );

  app.post<{ Body: { app: TvApp } }>(
    "/api/tv/app",
    { schema: { body: { type: "object", additionalProperties: false, required: ["app"], properties: { app: { type: "string", enum: APP_IDS } } } } },
    (req) => {
      const component = APPS[req.body.app]?.component;
      if (component) {
        const robot = adb;
        if (!robot) throw new HttpError(404, "this app opens over ADB: set TV_ADB in backend/.env");
        return guarded(() => robot.launchComponent(component));
      }
      return guarded(() => need().launch(req.body.app));
    },
  );
}
