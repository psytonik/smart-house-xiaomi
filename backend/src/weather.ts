import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the house is. Only this point (to about a kilometre) is ever sent to the weather service. */
export interface Home {
  lat: number;
  lon: number;
  name?: string;
}

export class HomeError extends Error {}

export function parseHome(raw: unknown): Home {
  if (typeof raw !== "object" || raw === null) throw new HomeError("the place must be an object with lat and lon");
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new HomeError(`${what} must be a number from ${lo} to ${hi}`);
    return Math.round(v * 100) / 100;
  };
  const lat = num(r.lat, -90, 90, "lat");
  const lon = num(r.lon, -180, 180, "lon");
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : undefined;
  return { lat, lon, ...(name ? { name } : {}) };
}

/** The house's place on disk (data/home.json). */
export class HomeStore {
  private home: Home | undefined;
  private readonly file: string;
  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, "home.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.home = parseHome(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.home = undefined;
    }
  }

  get(): Home | undefined {
    return this.home;
  }

  async set(raw: unknown): Promise<Home> {
    const home = parseHome(raw);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(home), { mode: 0o600 });
    await rename(tmp, this.file);
    this.home = home;
    return home;
  }
}

type Fetch = typeof fetch;

/** A city name to a place, by Open-Meteo's free geocoding (no key). The name is the only thing sent. */
export async function geocode(name: string, f: Fetch = globalThis.fetch): Promise<Home | undefined> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&format=json&name=${encodeURIComponent(name)}`;
  const res = await f(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`the geocoding service answered ${res.status}`);
  const hit = ((await res.json()) as { results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string; country?: string }> }).results?.[0];
  if (!hit) return undefined;
  return parseHome({ lat: hit.latitude, lon: hit.longitude, name: [hit.name, hit.country].filter(Boolean).join(", ") });
}

export interface Weather {
  temperature: number;
  feelsLike: number;
  code: number;
  windMs: number;
  precipitationMm: number;
}

const FRESH_MS = 15 * 60_000;
let cache: { key: string; at: number; weather: Weather } | undefined;

/** The weather outside now, from Open-Meteo (no key). Remembered for 15 minutes. */
export async function currentWeather(home: Home, f: Fetch = globalThis.fetch, now = Date.now()): Promise<Weather> {
  const key = `${home.lat},${home.lon}`;
  if (cache && cache.key === key && now - cache.at < FRESH_MS) return cache.weather;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${home.lat}&longitude=${home.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&wind_speed_unit=ms&timezone=auto`;
  const res = await f(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
  const c = ((await res.json()) as { current?: Record<string, number> }).current;
  if (!c || typeof c.temperature_2m !== "number") throw new Error("the weather service sent no current weather");
  const weather = { temperature: c.temperature_2m, feelsLike: c.apparent_temperature ?? c.temperature_2m, code: c.weather_code ?? 0, windMs: c.wind_speed_10m ?? 0, precipitationMm: c.precipitation ?? 0 };
  cache = { key, at: now, weather };
  return weather;
}

export function forgetWeather(): void {
  cache = undefined;
}

const plural = (n: number, one: string, few: string, many: string) => (n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many);

const SKY: Array<[(c: number) => boolean, string]> = [
  [(c) => c === 0, "ясно"],
  [(c) => c === 1, "почти ясно"],
  [(c) => c === 2, "переменная облачность"],
  [(c) => c === 3, "пасмурно"],
  [(c) => c === 45 || c === 48, "туман"],
  [(c) => c >= 51 && c <= 57, "морось"],
  [(c) => c >= 61 && c <= 67, "дождь"],
  [(c) => c >= 71 && c <= 77, "снег"],
  [(c) => c >= 80 && c <= 82, "ливень"],
  [(c) => c === 85 || c === 86, "снегопад"],
  [(c) => c >= 95, "гроза"],
];

/** The weather as a person would say it, with a word on the umbrella when it is wet. */
export function describeWeather(w: Weather, place?: string): string {
  const deg = (t: number) => {
    const n = Math.round(t);
    return `${n < 0 ? "минус " : ""}${Math.abs(n)} ${plural(Math.abs(n), "градус", "градуса", "градусов")}`;
  };
  const sky = SKY.find(([test]) => test(w.code))?.[1] ?? "";
  const wind = Math.round(w.windMs);
  const wet = (w.code >= 51 && w.code <= 67) || (w.code >= 80 && w.code <= 82) || w.code >= 95;
  const parts = [`${place ? `${place}: ` : "На улице "}${deg(w.temperature)}`, sky];
  if (Math.round(w.feelsLike) !== Math.round(w.temperature)) parts.push(`ощущается как ${deg(w.feelsLike)}`);
  if (wind >= 1) parts.push(`ветер ${wind} ${plural(wind, "метр", "метра", "метров")} в секунду`);
  return parts.filter(Boolean).join(", ") + (wet ? ". Лучше взять зонт" : "");
}
