import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../go2rtc.js";
import { HomeError, HomeStore, currentWeather, describeWeather, forgetWeather, geocode } from "../weather.js";
import { join } from "node:path";

/** Where the house is (said as a city, or taken from the browser's GPS) and the weather outside. */
export function homeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const store = new HomeStore(join(ctx.cfg.dataDir));
  // Read on first use, not when the routes are registered: the data folder may not exist yet.
  let started: Promise<void> | undefined;
  const ready = () => (started ??= store.init());

  app.get("/api/home", async () => {
    await ready();
    const home = store.get();
    return home ? { set: true, ...home } : { set: false };
  });

  // The browser's GPS point.
  app.put<{ Body: { lat: number; lon: number; name?: string } }>(
    "/api/home",
    { schema: { body: { type: "object", required: ["lat", "lon"], additionalProperties: false, properties: { lat: { type: "number" }, lon: { type: "number" }, name: { type: "string", maxLength: 80 } } } } },
    async (req) => {
      await ready();
      try {
        forgetWeather();
        return { set: true, ...(await store.set(req.body)) };
      } catch (e) {
        if (e instanceof HomeError) throw new HttpError(400, e.message);
        throw e;
      }
    },
  );

  // A city said in words.
  app.post<{ Body: { name: string } }>(
    "/api/home/place",
    { schema: { body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 80 } } } } },
    async (req) => {
      await ready();
      let found;
      try {
        found = await geocode(req.body.name.trim());
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message : "the geocoding service failed");
      }
      if (!found) throw new HttpError(404, `не нашёл место «${req.body.name.trim()}»: скажите город иначе`);
      forgetWeather();
      return { set: true, ...(await store.set(found)) };
    },
  );

  app.get("/api/weather", async () => {
    await ready();
    const home = store.get();
    if (!home) throw new HttpError(409, "home-not-set");
    try {
      const weather = await currentWeather(home);
      return { place: home.name, weather, text: describeWeather(weather) };
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : "the weather service failed");
    }
  });
}
