import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../go2rtc.js";
import { MiioDevice, MiioError } from "../miio.js";
import { addDetail, decodeCloudMap, decodeLiveFrame, decodePiece, geometryOf, isGeometry, renderMapPng, routeOf, toCells, VacuumMapError, DEFAULT_COLORS, type MapGeometry, type MapPiece, type Point } from "../vacuumMap.js";
import { CloudError, deviceData, downloadCloudFile, idsFromObjectName } from "../xiaomiCloud.js";
import { LevelKeeper } from "../vacuumLevels.js";
import { roomsOf, type Room } from "../vacuumRooms.js";
import { VacuumWatcher } from "../vacuumWatcher.js";
import { CLEANING_MODE_NAMES, parseCleaningRecord, SUCTION_NAMES, Vacuum, SETTING_NAMES, VACUUM_ACTIONS, VACUUM_PARTS, WATER_NAMES, type CleaningMode, type SuctionLevel, type SettingName, type VacuumAction, type VacuumPart, type WaterLevel } from "../vacuum.js";

/** Robot vacuum over the local network. Configured with VACUUM_IP and VACUUM_TOKEN (backend/.env). */
export function vacuumRoutes(app: FastifyInstance, ctx: AppContext, env: NodeJS.ProcessEnv = process.env): void {
  let vacuum: Vacuum | undefined;
  if (env.VACUUM_IP && env.VACUUM_TOKEN) {
    try {
      const port = Number(env.VACUUM_PORT ?? 54321);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VACUUM_PORT must be a port number");
      vacuum = new Vacuum(new MiioDevice(env.VACUUM_IP, env.VACUUM_TOKEN, port));
    } catch (e) {
      app.log.warn(`vacuum disabled: ${(e as Error).message}`); // a wrong token is a setup mistake, not a crash
    }
  }

  // The suction and water chosen in the web app are put back after a cleaning starts (the robot resets them to the maximum).
  const levels = vacuum ? new LevelKeeper(vacuum, ctx.cfg.dataDir, (m) => app.log.info(m)) : undefined;
  const afterStartMs = Number(env.VACUUM_LEVELS_DELAY_MS ?? 5000);

  // Pushes about the robot (cleaning done, trouble, worn parts). VACUUM_WATCH_MS is how often it looks; 0 turns it off.
  if (vacuum) {
    const every = Number(env.VACUUM_WATCH_MS ?? 60_000);
    if (Number.isFinite(every) && every > 0) {
      const watcher = new VacuumWatcher(vacuum, ctx.push, { dataDir: ctx.cfg.dataDir, intervalMs: every, log: (m) => app.log.info(m), onCleaningStart: () => levels?.apply() ?? Promise.resolve() });
      watcher.start();
      app.addHook("onClose", async () => watcher.stop());
    }
  }

  app.get("/api/vacuum", async () => {
    if (!vacuum) return { configured: false };
    try {
      const state = await vacuum.state();
      const info = await vacuum.info().catch(() => undefined); // nice to have, never a reason to fail
      return { configured: true, reachable: true, ...state, ...info };
    } catch {
      return { configured: true, reachable: false };
    }
  });

  app.get("/api/vacuum/care", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    try {
      return await vacuum.care();
    } catch (e) {
      if (e instanceof MiioError) throw new HttpError(502, e.message);
      throw e;
    }
  });

  app.post<{ Body: { action: VacuumAction } }>(
    "/api/vacuum",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: { action: { type: "string", enum: VACUUM_ACTIONS } },
        },
      },
    },
    async (req) => {
      if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
      try {
        if (req.body.action === "empty") {
          // the dock can only empty a robot that is sitting on it; say so instead of sending a command that does nothing
          const state = await vacuum.state();
          if (!state.dustStation) throw new HttpError(409, "this robot has no dust station");
          if (!state.dustStation.ready) throw new HttpError(409, "the robot has to be on its dock to empty its bin");
          if (state.dustStation.emptying) throw new HttpError(409, "the dock is already emptying the bin");
        }
        await vacuum.run(req.body.action);
      } catch (e) {
        if (e instanceof MiioError) throw new HttpError(502, e.message);
        throw e;
      }
      if (req.body.action === "start") levels?.afterStart(afterStartMs);
      return { ok: true };
    },
  );

  app.get("/api/vacuum/settings", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    try {
      return await vacuum.settings();
    } catch (e) {
      if (e instanceof MiioError) throw new HttpError(502, e.message);
      throw e;
    }
  });

  // One on/off setting of the robot. The answer is 502 with the reason when the robot didn't take it.
  app.post<{ Body: { name: SettingName; on: boolean } }>(
    "/api/vacuum/setting",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name", "on"], properties: { name: { type: "string", enum: SETTING_NAMES }, on: { type: "boolean" } } } } },
    async (req) => {
      if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
      try {
        await vacuum.setSetting(req.body.name, req.body.on);
      } catch (e) {
        if (e instanceof MiioError) throw new HttpError(502, e.message);
        throw e;
      }
      return { ok: true };
    },
  );

  // After changing a brush or the filter: its wear counter starts again from 100%.
  app.post<{ Body: { part: VacuumPart } }>(
    "/api/vacuum/reset",
    { schema: { body: { type: "object", additionalProperties: false, required: ["part"], properties: { part: { type: "string", enum: VACUUM_PARTS } } } } },
    async (req) => {
      if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
      try {
        await vacuum.resetPart(req.body.part);
      } catch (e) {
        if (e instanceof MiioError) throw new HttpError(502, e.message);
        throw e;
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { mode: CleaningMode } }>(
    "/api/vacuum/mode",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { type: "string", enum: CLEANING_MODE_NAMES } },
        },
      },
    },
    async (req) => {
      if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
      try {
        await vacuum.setCleaningMode(req.body.mode);
      } catch (e) {
        if (e instanceof MiioError) throw new HttpError(502, e.message);
        throw e;
      }
      return { ok: true };
    },
  );

  // Suction and water, as general settings. The answer is 502 with the reason when the robot didn't take the value.
  for (const [path, names, apply] of [
    ["suction", SUCTION_NAMES, (v: Vacuum, level: string) => v.setSuction(level as SuctionLevel)],
    ["water", WATER_NAMES, (v: Vacuum, level: string) => v.setWater(level as WaterLevel)],
  ] as const) {
    const key = path;
    app.post<{ Body: { level: string } }>(
      `/api/vacuum/${path}`,
      { schema: { body: { type: "object", additionalProperties: false, required: ["level"], properties: { level: { type: "string", enum: names } } } } },
      async (req) => {
        if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
        try {
          await apply(vacuum, req.body.level);
        } catch (e) {
          if (e instanceof MiioError) throw new HttpError(502, e.message);
          throw e;
        }
        levels?.remember({ [key]: req.body.level });
        return { ok: true };
      },
    );
  }

  // The floor plan. vacuum-map-live.png is drawn from the robot's own map (tools/xiaomi-cloud.ts map); if it is not
  // there, a picture you put in the data dir (vacuum-map.png) is used. Private like everything under /api.
  const liveMapFile = join(ctx.cfg.dataDir, "vacuum-map-live.png");
  const staticMapFile = join(ctx.cfg.dataDir, "vacuum-map.png");
  const geometryFile = join(ctx.cfg.dataDir, "vacuum-map-live.json");
  const roomsFile = join(ctx.cfg.dataDir, "vacuum-map-live-rooms.json");
  app.get("/api/vacuum/map", async (_req, reply) => {
    const mapFile = existsSync(liveMapFile) ? liveMapFile : staticMapFile;
    if (!existsSync(mapFile)) throw new HttpError(404, "no floor plan yet (run tools/xiaomi-cloud.ts map, or put vacuum-map.png in backend/data)");
    return reply.header("content-type", "image/png").header("cache-control", "private, max-age=300").send(createReadStream(mapFile));
  });

  // Redraws the floor plan from the robot's own map: asks the robot for the map's file name, downloads that file from the
  // Xiaomi cloud (needs the sign-in made with tools/xiaomi-cloud.ts login) and draws it. One refresh at a time.
  // The robot sends map pieces to the cloud only while someone is asking for them (the app does that while its map is open),
  // so a cleaning started with no app open leaves nothing to draw. Ask for them ourselves, but not more often than every 20 s.
  const pokeEvery = Number(env.VACUUM_MAP_POKE_MS) || 20_000;
  let lastPoke = 0;
  const poke = async (robot: Vacuum) => {
    if (Date.now() - lastPoke < pokeEvery) return;
    lastPoke = Date.now();
    await robot.requestMap().catch(() => undefined); // a robot that won't send pieces just means no detail this time
  };

  // The map pieces of the robot's current cleaning, oldest first (about the last half hour).
  const recentPieces = async (objectName: string): Promise<MapPiece[]> => {
    const who = idsFromObjectName(objectName);
    if (!who) return [];
    const rows = await deviceData(ctx.cfg.dataDir, who, "6.1", 1000);
    const pieces: MapPiece[] = [];
    for (const row of [...rows].reverse()) {
      let list: unknown;
      try {
        list = JSON.parse(row.value);
      } catch {
        continue;
      }
      for (const item of Array.isArray(list) ? list : [list]) {
        const packed = String(item);
        if (packed.includes(",")) continue; // encrypted
        try {
          pieces.push(decodePiece(packed));
        } catch {
          /* one damaged piece is not worth failing for */
        }
      }
    }
    const current = pieces.at(-1)?.mapId; // the newest piece says which map the robot is working on
    return pieces.filter((p) => p.mapId === current);
  };

  let refreshing: Promise<void> | undefined;
  app.post("/api/vacuum/map/refresh", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    const robot = vacuum;
    refreshing ??= (async () => {
      try {
        const objectName = await robot.mapObjectName();
        void poke(robot); // not waited for: a slow robot must not hold the redraw back
        const saved = decodeCloudMap(await downloadCloudFile(ctx.cfg.dataDir, objectName));
        // The saved map is only the outline. What the robot has seen while cleaning (wall edges, furniture) and the way it
        // drove arrive in pieces; they are a bonus, so if they are not there the plain outline is drawn.
        let map = saved;
        let route: Point[][] = [];
        try {
          const pieces = await recentPieces(objectName);
          map = addDetail(saved, pieces);
          route = routeOf(geometryOf(saved), pieces);
        } catch {
          /* no detail this time */
        }
        const temp = `${liveMapFile}.tmp`;
        writeFileSync(temp, renderMapPng(map, 5, DEFAULT_COLORS, route));
        renameSync(temp, liveMapFile); // the picture is replaced whole, never half written
        writeFileSync(geometryFile, JSON.stringify(geometryOf(map)));
        writeFileSync(roomsFile, JSON.stringify(roomsOf(saved))); // from the saved map: the detail drawn over it has no rooms
      } finally {
        refreshing = undefined;
      }
    })();
    try {
      await refreshing;
    } catch (e) {
      if (e instanceof CloudError) throw new HttpError(e.needsLogin ? 409 : 502, e.message);
      if (e instanceof MiioError || e instanceof VacuumMapError) throw new HttpError(502, e.message);
      throw e;
    }
    return { ok: true };
  });

  // The rooms of the saved map, found when the floor plan was last redrawn. Empty while the robot has been taught no rooms.
  const savedRooms = (): Room[] => {
    try {
      const rooms = JSON.parse(readFileSync(roomsFile, "utf8"));
      return Array.isArray(rooms) ? (rooms as Room[]) : [];
    } catch {
      throw new HttpError(409, "update the floor plan first: the rooms are read from it");
    }
  };
  app.get("/api/vacuum/rooms", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    return { rooms: savedRooms() };
  });

  // Cleans the chosen rooms, in the order given, with the suction and water the robot has now. Starts the robot: only when it is idle or docked.
  app.post<{ Body: { rooms: number[] } }>(
    "/api/vacuum/clean-rooms",
    { schema: { body: { type: "object", additionalProperties: false, required: ["rooms"], properties: { rooms: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 63 } } } } } },
    async (req) => {
      if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
      const known = new Set(savedRooms().map((r) => r.id));
      const unknown = req.body.rooms.filter((id) => !known.has(id));
      if (unknown.length) throw new HttpError(400, `the saved map has no room ${unknown.join(", ")}`);
      try {
        const state = await vacuum.state();
        if (state.mode === "cleaning" || state.mode === "returning" || state.mode === "error" || state.mode === "updating") throw new HttpError(409, "the robot is busy: wait until it is idle or on its dock");
        await vacuum.cleanRooms(req.body.rooms, state.suction ?? "standard", state.water ?? "medium");
      } catch (e) {
        if (e instanceof MiioError) throw new HttpError(502, e.message);
        throw e;
      }
      levels?.afterStart(afterStartMs);
      return { ok: true };
    },
  );

  // Where the robot is right now and the trail it just drove, placed on the floor plan picture (in map cells).
  // The robot reports this to the Xiaomi cloud about every two seconds while it moves.
  let ids: { uid: string; did: string } | undefined;
  let liveAnswer: { at: number; body: unknown } | undefined;
  let liveLookup: Promise<unknown> | undefined;
  const lookUpLive = async (robot: Vacuum, geo: MapGeometry) => {
    ids ??= idsFromObjectName(await robot.mapObjectName());
    if (!ids) throw new MiioError("the vacuum did not report which account it belongs to");
    void poke(robot);
    const rows = await deviceData(ctx.cfg.dataDir, ids, "6.1", 20);
    const frames = rows.flatMap((row) => {
      try {
        const parsed = JSON.parse(row.value);
        const packed = String(Array.isArray(parsed) ? parsed[0] : row.value);
        return packed.includes(",") ? [] : [{ time: row.time, frame: decodeLiveFrame(packed) }]; // "data,key" frames are encrypted
      } catch {
        return []; // one damaged frame is not worth failing for
      }
    });
    const newest = frames[0];
    const age = newest ? Math.max(0, Math.round(Date.now() / 1000 - newest.time)) : null;
    const robotAt = frames.find((f) => f.frame.robot)?.frame.robot;
    const trail: Point[] = frames
      .slice()
      .reverse()
      .flatMap((f) => f.frame.path)
      .slice(-400)
      .map((p) => toCells(geo, p));
    return { map: { width: geo.width, height: geo.height }, robot: robotAt ? toCells(geo, robotAt) : null, trail, ageSeconds: age, live: age !== null && age <= 30 };
  };
  app.get("/api/vacuum/live", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    let geo: unknown;
    try {
      geo = JSON.parse(readFileSync(geometryFile, "utf8"));
    } catch {
      /* no floor plan from the robot's own map yet */
    }
    if (!isGeometry(geo)) throw new HttpError(409, "update the floor plan first: the robot's position is drawn on it");
    if (liveAnswer && Date.now() - liveAnswer.at < 2000) return liveAnswer.body; // a few open pages share one lookup
    const robot = vacuum;
    liveLookup ??= lookUpLive(robot, geo).finally(() => (liveLookup = undefined));
    try {
      const body = await liveLookup;
      liveAnswer = { at: Date.now(), body };
      return body;
    } catch (e) {
      if (e instanceof CloudError) throw new HttpError(e.needsLogin ? 409 : 502, e.message);
      if (e instanceof MiioError || e instanceof VacuumMapError) throw new HttpError(502, e.message);
      throw e;
    }
  });

  // The cleanings the Xiaomi cloud remembers (about the last twenty), newest first.
  app.get("/api/vacuum/history", async () => {
    if (!vacuum) throw new HttpError(404, "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)");
    try {
      ids ??= idsFromObjectName(await vacuum.mapObjectName());
      if (!ids) throw new MiioError("the vacuum did not report which account it belongs to");
      const rows = await deviceData(ctx.cfg.dataDir, ids, "4.1", 30, env, "event");
      return { cleanings: rows.flatMap((r) => parseCleaningRecord(r.value) ?? []) };
    } catch (e) {
      if (e instanceof CloudError) throw new HttpError(e.needsLogin ? 409 : 502, e.message);
      if (e instanceof MiioError) throw new HttpError(502, e.message);
      throw e;
    }
  });
}
