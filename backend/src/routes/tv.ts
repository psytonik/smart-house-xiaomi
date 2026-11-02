import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../go2rtc.js";
import { TvError, TvRemote } from "../tv.js";
import { findAdb, TvAdb } from "../tvAdb.js";
import { APPS, APP_IDS, KEY_NAMES, type TvApp, type TvKey } from "../tv/messages.js";
import { isAwake } from "../awake.js";
import { PHONE_SERIAL, sendIrWake } from "../ir.js";
import { broadcastsFor, parseMacs, wake } from "../wol.js";

/** How long Power is not sent again after a wake-up: the infrared key is a switch, and a TV takes about half a minute to answer. */
export const WAKE_COOLDOWN_MS = 45_000;

/** The TV answers within about ten seconds of a frame it took; after this long without an answer the frame is sent again (a frame is sometimes missed), this many times. */
export const WAKE_RETRY_MS = 20_000;
export const WAKE_RETRIES = 2;

/** The parts of the wake-up that tests replace. */
export interface TvDeps {
  sendWake: typeof wake;
  sendIr: typeof sendIrWake;
  /** Is the TV on the network? */
  awake: (host: string, port: number) => Promise<boolean>;
  now: () => number;
  /** Waits; the wake-up retries run on it. */
  sleep: (ms: number) => Promise<void>;
}

/** A Google TV / Android TV (TCL and others) on the local network, as a remote control. Configured with TV_IP (backend/.env). */
export function tvRoutes(app: FastifyInstance, ctx: AppContext, env: NodeJS.ProcessEnv = process.env, deps: Partial<TvDeps> = {}): void {
  const { sendWake = wake, sendIr = sendIrWake, awake = isAwake, now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = deps;
  let wokeAt = -Infinity;
  let closing = false;
  app.addHook("onClose", async () => void (closing = true));
  const remotePort = Number(env.TV_REMOTE_PORT) || 6466;
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

  // A TV in deep sleep has no network link, so no remote protocol can reach it; a wake-up packet to its address (TV_MAC) can.
  let macs: string[] = [];
  try {
    macs = parseMacs(env.TV_MAC);
  } catch (e) {
    app.log.warn(`tv wake disabled: ${(e as Error).message}`);
  }

  // The surest way to wake it: an infrared frame from the emitter of a phone plugged into this computer (TV_IR_PHONE=adb serial, ir-phone/).
  const irPhone = env.TV_IR_PHONE?.trim() || undefined;
  const irAdb = irPhone ? findAdb(env) : undefined;
  if (irPhone && !PHONE_SERIAL.test(irPhone)) app.log.warn("tv infrared wake disabled: TV_IR_PHONE must be an adb serial");
  else if (irPhone && !irAdb) app.log.warn("tv infrared wake disabled: adb was not found (install it, or set TV_ADB_PATH)");
  const irReady = irPhone !== undefined && PHONE_SERIAL.test(irPhone) && irAdb !== undefined;

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

  app.get("/api/tv", async () => (tv ? { configured: true, ...tv.status(), apps, adb: adb !== undefined, wake: macs.length > 0 || irReady } : { configured: false }));

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

  // A frame is sometimes missed by the sleeping TV. If it still does not answer after a while, send it again: a TV that is not answering
  // cannot be switched off by it. The TV that did take it answers well before the first retry.
  const retryWake = () => {
    if (!irReady || !host) return;
    void (async () => {
      for (let i = 0; i < WAKE_RETRIES; i++) {
        await sleep(WAKE_RETRY_MS);
        if (closing || (await awake(host, remotePort))) return;
        try {
          await sendIr(irAdb!, irPhone!);
          app.log.info(`tv infrared wake sent again (${i + 1}): the TV did not answer`);
        } catch (e) {
          app.log.warn(`tv infrared wake retry failed: ${(e as Error).message}`);
          return;
        }
      }
    })();
  };

  app.post<{ Body: { key: TvKey } }>(
    "/api/tv/key",
    { schema: { body: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", enum: KEY_NAMES } } } } },
    (req) => {
      // the INPUT key of this app opens the TV's own Source Choice, which only ADB can reach
      if (req.body.key === "input" && adb) return guarded(() => adb!.openSourceMenu());
      // Power while the TV is not on the network: it is asleep (or off), so wake it instead of failing.
      // The link status lags behind a TV that has just gone to sleep, so the network is asked directly.
      if (req.body.key === "power" && (irReady || macs.length > 0) && host) {
        return awake(host, remotePort).then((up) => {
          if (up) return guarded(() => need().press("power"));
          // the infrared key is a switch: a second one before the TV has answered would turn it off again
          if (now() - wokeAt < WAKE_COOLDOWN_MS) return { ok: true, woke: true, waiting: true };
          wokeAt = now();
          return guarded(async () => {
            // infrared first; the packet is the fallback when the phone is not there
            if (irReady) {
              try {
                await sendIr(irAdb!, irPhone!);
                retryWake(); // in the background: the page does not wait for it
                return;
              } catch (e) {
                app.log.warn(`tv infrared wake failed: ${(e as Error).message}`);
                if (macs.length === 0) throw e;
              }
            }
            await sendWake(macs, broadcastsFor(host));
          })
            .then((r) => ({ ...r, woke: true }))
            .catch((e) => {
              wokeAt = -Infinity; // nothing was sent: the next press may try again
              throw e;
            });
        });
      }
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
