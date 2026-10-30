import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Motion zones, as rectangles in the picture (0..1 of its width and height, origin top left).
 *  - "ignore": motion inside does not count. Typical use: the camera's burned-in clock, a tree, a road.
 *  - "watch":  when at least one exists, motion counts ONLY inside the watch zones.
 *  - "privacy": like "ignore" for motion, and the area is also hidden (black) in snapshots, thumbnails
 *    and the live view. Recorded clips are not changed.
 * An ignore or privacy zone cuts a hole in a watch zone. With no zones motion counts everywhere,
 * the same rule camera.ui uses ("a zone kind only filters once it exists").
 */
export type ZoneMode = "watch" | "ignore" | "privacy";

export interface Zone {
  id: string;
  mode: ZoneMode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZONES = 20;
const MIN_SIZE = 0.01;

/** The caller sent zones we refuse to store. */
export class ZoneError extends Error {}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export function parseZones(input: unknown): Zone[] {
  if (!Array.isArray(input)) throw new ZoneError("zones must be a list");
  if (input.length > MAX_ZONES) throw new ZoneError(`at most ${MAX_ZONES} zones`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const label = `zone ${i + 1}`;
    if (typeof raw !== "object" || raw === null) throw new ZoneError(`${label}: not an object`);
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length < 1 || r.id.length > 40) throw new ZoneError(`${label}: id must be 1..40 characters`);
    if (seen.has(r.id)) throw new ZoneError(`${label}: duplicate id "${r.id}"`);
    seen.add(r.id);
    if (r.mode !== "watch" && r.mode !== "ignore" && r.mode !== "privacy") throw new ZoneError(`${label}: mode must be "watch", "ignore" or "privacy"`);
    const num = (key: "x" | "y" | "w" | "h"): number => {
      const v = r[key];
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ZoneError(`${label}: ${key} must be a number`);
      return round(v);
    };
    const [x, y, w, h] = [num("x"), num("y"), num("w"), num("h")];
    if (x < 0 || y < 0) throw new ZoneError(`${label}: starts outside the picture`);
    if (w < MIN_SIZE || h < MIN_SIZE) throw new ZoneError(`${label}: too small (at least ${MIN_SIZE * 100}% each way)`);
    if (x + w > 1.0001 || y + h > 1.0001) throw new ZoneError(`${label}: sticks out of the picture`);
    return { id: r.id, mode: r.mode, x, y, w, h };
  });
}

/**
 * One byte per pixel of the motion grid: 1 = motion counts here, 0 = ignored.
 * Null when there are no zones, so the detector keeps its cheap whole-picture path.
 */
export function buildMask(zones: Zone[], width: number, height: number): Uint8Array | null {
  if (zones.length === 0) return null;
  const mask = new Uint8Array(width * height);
  const fill = (z: Zone, value: 0 | 1) => {
    const x0 = Math.max(0, Math.floor(z.x * width + 1e-9));
    const x1 = Math.min(width, Math.ceil((z.x + z.w) * width - 1e-9));
    const y0 = Math.max(0, Math.floor(z.y * height + 1e-9));
    const y1 = Math.min(height, Math.ceil((z.y + z.h) * height - 1e-9));
    for (let y = y0; y < y1; y++) mask.fill(value, y * width + x0, y * width + x1);
  };
  const watch = zones.filter((z) => z.mode === "watch");
  if (watch.length === 0) mask.fill(1);
  else watch.forEach((z) => fill(z, 1));
  zones.filter((z) => z.mode !== "watch").forEach((z) => fill(z, 0));
  return mask;
}

/** Zones on disk (data/zones.json). */
export class ZoneStore {
  private zones: Zone[] = [];
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, "zones.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.zones = parseZones((JSON.parse(await readFile(this.file, "utf8")) as { zones?: unknown }).zones);
    } catch {
      this.zones = []; // missing or damaged: no zones, motion counts everywhere
    }
  }

  get(): Zone[] {
    return this.zones;
  }

  async set(zones: Zone[]): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ zones }, null, 2));
    await rename(tmp, this.file);
    this.zones = zones;
  }
}
