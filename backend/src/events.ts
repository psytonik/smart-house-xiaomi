import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectSummary } from "./detect.js";

export const EVENT_ID = /^\d{8}T\d{9}Z$/;

export interface MotionClip {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  /** Highest share of the frame that changed, in percent. */
  peak: number;
  bytes: number;
  clip: string;
  thumb: string | null;
  /**
   * What the detector saw in the clip. Absent: not analysed (older clip, detection off or failed).
   * Empty: analysed and nothing found. Not the same thing.
   */
  objects?: ObjectSummary[];
}

/** Motion clips on disk: <id>.json (metadata), <id>.mp4 (clip), <id>.jpg (thumbnail). */
export class EventStore {
  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  file(name: string): string {
    return join(this.dir, name);
  }

  async add(clip: MotionClip): Promise<void> {
    await writeFile(this.file(`${clip.id}.json`), JSON.stringify(clip));
  }

  async get(id: string): Promise<MotionClip | null> {
    if (!EVENT_ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.file(`${id}.json`), "utf8")) as MotionClip;
    } catch {
      return null;
    }
  }

  async list(limit = 50): Promise<MotionClip[]> {
    const ids = (await readdir(this.dir))
      .filter((n) => n.endsWith(".json") && EVENT_ID.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse()
      .slice(0, limit);
    const clips = await Promise.all(ids.map((id) => this.get(id)));
    return clips.filter((c): c is MotionClip => c !== null);
  }

  async remove(id: string): Promise<boolean> {
    if (!EVENT_ID.test(id)) return false;
    const existed = (await this.get(id)) !== null;
    await Promise.all([".json", ".mp4", ".jpg"].map((ext) => rm(this.file(id + ext), { force: true })));
    return existed;
  }

  /** Deletes clips that started before `cutoffMs`; returns how many were removed. */
  async prune(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const clip of await this.list(100_000)) {
      if (Date.parse(clip.startedAt) < cutoffMs) {
        await this.remove(clip.id);
        removed++;
      }
    }
    return removed;
  }

  /** Number of clips and the space their videos take. */
  async usage(): Promise<{ clips: number; bytes: number }> {
    const clips = await this.list(100_000);
    return { clips: clips.length, bytes: clips.reduce((sum, c) => sum + c.bytes, 0) };
  }

  /**
   * Deletes the oldest clips until the videos fit in `maxBytes`; returns how many were removed.
   * The newest clip always stays, so a fresh recording is never thrown away.
   */
  async pruneToSize(maxBytes: number): Promise<number> {
    const clips = await this.list(100_000); // newest first
    let total = clips.reduce((sum, c) => sum + c.bytes, 0);
    let removed = 0;
    for (let i = clips.length - 1; i > 0 && total > maxBytes; i--) {
      await this.remove(clips[i]!.id);
      total -= clips[i]!.bytes;
      removed++;
    }
    return removed;
  }

  async size(id: string, ext: "mp4" | "jpg"): Promise<number | null> {
    try {
      return (await stat(this.file(`${id}.${ext}`))).size;
    } catch {
      return null;
    }
  }
}
