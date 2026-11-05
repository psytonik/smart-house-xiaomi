import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MOTOR_MAX, MOTOR_MIN, type Pos } from "./ptzGoto.js";

/** A named place the camera can go back to ("door", "window"). */
export interface PtzPreset extends Pos {
  id: string;
  name: string;
  savedAt: string;
}

export const MAX_PRESETS = 20;

/** The caller sent a preset we refuse to store. */
export class PtzPresetError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parsePresetPosition(raw: unknown): Pos {
  if (typeof raw !== "object" || raw === null) throw new PtzPresetError("the position must be an object with angle and elevation");
  const r = raw as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MOTOR_MIN && n <= MOTOR_MAX;
  if (!ok(r.angle) || !ok(r.elevation)) throw new PtzPresetError(`angle and elevation must be whole numbers ${MOTOR_MIN}..${MOTOR_MAX}`);
  return { angle: r.angle, elevation: r.elevation };
}

export function parsePresetName(raw: unknown): string {
  if (typeof raw !== "string") throw new PtzPresetError("the name must be text");
  const name = raw.trim();
  if (!name) throw new PtzPresetError("the name is required");
  if (name.length > 40) throw new PtzPresetError("the name is longer than 40 characters");
  if (CONTROL.test(name)) throw new PtzPresetError("the name has control characters");
  return name;
}

const key = (name: string) => name.trim().toLocaleLowerCase();

/** Saved camera positions on disk (data/ptz-presets.json). Writes are one at a time and replace the file whole. */
export class PtzPresetStore {
  private presets: PtzPreset[] = [];
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, "ptz-presets.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      this.presets = [];
      return;
    }
    // A damaged file is not silently replaced: starting over would overwrite the saved places on the next save.
    const list = (JSON.parse(raw) as { presets?: unknown }).presets;
    if (!Array.isArray(list)) throw new PtzPresetError("data/ptz-presets.json is damaged");
    this.presets = list.map((p: Record<string, unknown>) => ({
      id: String(p.id),
      name: parsePresetName(p.name),
      ...parsePresetPosition(p),
      savedAt: typeof p.savedAt === "string" ? p.savedAt : new Date(0).toISOString(),
    }));
  }

  list(): PtzPreset[] {
    return this.presets;
  }

  get(id: string): PtzPreset | undefined {
    return this.presets.find((p) => p.id === id);
  }

  findByName(name: string): PtzPreset | undefined {
    return this.presets.find((p) => key(p.name) === key(name));
  }

  private mutate<T>(change: (cur: PtzPreset[]) => { next: PtzPreset[]; result: T }): Promise<T> {
    const run = this.chain.then(async () => {
      const { next, result } = change(this.presets);
      if (next === this.presets) return result;
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ presets: next }, null, 2));
      await rename(tmp, this.file);
      this.presets = next;
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Saves a place under a name. The same name (any case) replaces the position of the existing preset. */
  async save(name: string, position: Pos): Promise<PtzPreset> {
    const clean = parsePresetName(name);
    const pos = parsePresetPosition(position);
    return this.mutate((cur) => {
      const old = cur.find((p) => key(p.name) === key(clean));
      const rec: PtzPreset = { id: old?.id ?? `pz-${randomBytes(3).toString("hex")}`, name: old?.name ?? clean, ...pos, savedAt: new Date().toISOString() };
      if (!old && cur.length >= MAX_PRESETS) throw new PtzPresetError(`at most ${MAX_PRESETS} presets`);
      return { next: old ? cur.map((p) => (p.id === old.id ? rec : p)) : [...cur, rec], result: rec };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate((cur) => (cur.some((p) => p.id === id) ? { next: cur.filter((p) => p.id !== id), result: true } : { next: cur, result: false }));
  }
}
