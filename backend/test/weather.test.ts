import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import Fastify from "fastify";
import type { AppContext } from "../src/context.js";
import { homeRoutes } from "../src/routes/home.js";
import { HomeError, HomeStore, currentWeather, describeWeather, forgetWeather, geocode, parseHome } from "../src/weather.js";
import { planFollowUp, planQuick, ASK_HOME } from "../src/quick.js";
import { plain, runAssistant, type ApiCall } from "../src/assistant.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "home-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(() => {
  mock.restoreAll();
  forgetWeather();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fakeFetch = (routes: Record<string, unknown>) =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([k]) => u.includes(k));
    return hit ? json(hit[1]) : json({}, 404);
  }) as typeof fetch;

const CURRENT = { current: { temperature_2m: 18.4, apparent_temperature: 16.2, weather_code: 2, wind_speed_10m: 3.4, precipitation: 0 } };

describe("the home place", () => {
  it("keeps the point to about a kilometre and refuses nonsense", () => {
    assert.deepEqual(parseHome({ lat: 32.794044, lon: 34.989571, name: " Хайфа " }), { lat: 32.79, lon: 34.99, name: "Хайфа" });
    assert.throws(() => parseHome({ lat: 91, lon: 0 }), HomeError);
    assert.throws(() => parseHome({ lat: 0, lon: "x" }), HomeError);
  });

  it("is remembered between runs", async () => {
    const dir = tmp();
    const a = new HomeStore(dir);
    await a.init();
    assert.equal(a.get(), undefined);
    await a.set({ lat: 10, lon: 20, name: "Тест" });
    const b = new HomeStore(dir);
    await b.init();
    assert.deepEqual(b.get(), { lat: 10, lon: 20, name: "Тест" });
  });

  it("finds a city by name, and says nothing was found", async () => {
    const f = fakeFetch({ "geocoding-api": { results: [{ name: "Хайфа", latitude: 32.794, longitude: 34.9896, country: "Израиль" }] } });
    assert.deepEqual(await geocode("хайфа", f), { lat: 32.79, lon: 34.99, name: "Хайфа, Израиль" });
    assert.equal(await geocode("нигде", fakeFetch({ "geocoding-api": {} })), undefined);
  });
});

describe("the weather", () => {
  it("is read from the service and remembered for fifteen minutes", async () => {
    let asked = 0;
    const f = (async () => (asked++, json(CURRENT))) as unknown as typeof fetch;
    const home = { lat: 1, lon: 2 };
    const first = await currentWeather(home, f, 1_000);
    await currentWeather(home, f, 1_000 + 14 * 60_000);
    assert.equal(asked, 1);
    await currentWeather(home, f, 1_000 + 16 * 60_000);
    assert.equal(asked, 2);
    assert.equal(first.temperature, 18.4);
  });

  it("is said the way people say it", () => {
    assert.equal(describeWeather({ temperature: 18.4, feelsLike: 16.2, code: 2, windMs: 3.4, precipitationMm: 0 }), "На улице 18 градусов, переменная облачность, ощущается как 16 градусов, ветер 3 метра в секунду");
    assert.equal(describeWeather({ temperature: -3.2, feelsLike: -3.2, code: 71, windMs: 0.4, precipitationMm: 0 }), "На улице минус 3 градуса, снег");
    assert.match(describeWeather({ temperature: 12, feelsLike: 12, code: 63, windMs: 1, precipitationMm: 2 }), /дождь.*Лучше взять зонт$/);
  });
});

describe("the home routes", () => {
  const build = async () => {
    const app = Fastify();
    homeRoutes(app, { cfg: testConfig({ dataDir: tmp() }) } as unknown as AppContext);
    return app;
  };

  it("asks for a home before it can tell the weather, then takes the GPS point", async () => {
    const app = await build();
    assert.equal((await app.inject("/api/weather")).statusCode, 409);
    assert.deepEqual((await app.inject("/api/home")).json(), { set: false });
    const put = await app.inject({ method: "PUT", url: "/api/home", payload: { lat: 32.794, lon: 34.989 } });
    assert.equal(put.statusCode, 200);
    mock.method(globalThis, "fetch", fakeFetch({ "api.open-meteo": CURRENT }));
    const w = (await app.inject("/api/weather")).json();
    assert.match(w.text, /^На улице 18 градусов/);
    assert.equal((await app.inject({ method: "PUT", url: "/api/home", payload: { lat: 200, lon: 0 } })).statusCode, 400);
  });

  it("takes a city by name and refuses one it cannot find", async () => {
    const app = await build();
    mock.method(globalThis, "fetch", fakeFetch({ "geocoding-api": { results: [{ name: "Хайфа", latitude: 32.79, longitude: 34.99 }] } }));
    const ok = await app.inject({ method: "POST", url: "/api/home/place", payload: { name: "Хайфа" } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().name, "Хайфа");
    mock.restoreAll();
    mock.method(globalThis, "fetch", fakeFetch({ "geocoding-api": {} }));
    assert.equal((await app.inject({ method: "POST", url: "/api/home/place", payload: { name: "Нигде" } })).statusCode, 404);
  });
});

describe("the assistant and the weather", () => {
  it("knows weather questions and «я живу в …»", () => {
    for (const q of ["Какая сегодня погода на улице", "сколько градусов на улице", "нужен ли зонт"]) assert.equal(planQuick(plain(q))?.[0]?.tool, "weather", q);
    assert.deepEqual(planQuick(plain("Я живу в Хайфе"))?.map((s) => [s.tool, s.input.name]), [["home_place", "хайфе"]]);
  });

  it("asks where the house is, takes the answer, and tells the weather", async () => {
    let known = false;
    const call: ApiCall = async (_m, u, b) => {
      if (u === "/api/weather") return known ? { status: 200, body: { text: "На улице 18 градусов" } } : { status: 409, body: { error: "home-not-set" } };
      if (u === "/api/home/place") return (known = true), { status: 200, body: { set: true, name: String((b as { name: string }).name) } };
      return { status: 404, body: {} };
    };
    const brain = {} as never;
    const first = await runAssistant({ brain, model: "m", call, text: "какая погода" });
    assert.equal(first.reply, ASK_HOME);
    const second = await runAssistant({ brain, model: "m", call, text: "в Хайфе", history: [{ role: "user", content: "какая погода" }, { role: "assistant", content: ASK_HOME }] });
    assert.match(second.reply, /Запомнил.*На улице 18 градусов/);
    assert.deepEqual(planFollowUp("в хайфе", ASK_HOME)?.map((s) => s.input.name), ["хайфе", undefined]);
  });
});
