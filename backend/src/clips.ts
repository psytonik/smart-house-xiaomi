import { spawn } from "node:child_process";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ObjectSummary } from "./detect.js";
import type { EventStore, MotionClip } from "./events.js";
import type { MotionSpan } from "./motion.js";
import { thumbnailFilter } from "./privacy.js";
import type { ClipAnalyzer } from "./recorder.js";
import type { Zone } from "./zones.js";

const SEGMENT_FILE = /^seg-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.ts$/;

/** Segment names are written by ffmpeg in local time. */
export function segmentStart(name: string): number | null {
  const m = SEGMENT_FILE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function run(bin: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    p.on("error", (e) => resolve({ code: null, stderr: String(e) }));
    p.on("close", (code) => resolve({ code, stderr }));
  });
}


export interface ClipBuilderDeps {
  /** Folder with the rolling copy segments. */
  ring: string;
  zones: () => Zone[];
  analyzer: () => ClipAnalyzer | undefined;
  log: (msg: string) => void;
}

/** Turns the ring segments around one motion event into a saved clip (mp4, thumbnail, labels). */
export class ClipBuilder {
  constructor(
    private readonly cfg: Config,
    private readonly store: EventStore,
    private readonly deps: ClipBuilderDeps,
  ) {}

  /** Joins the ring segments of one event into a clip, makes the thumbnail, labels it. Null when nothing was saved. */
  async assemble(span: MotionSpan, winStart: number, winEnd: number): Promise<MotionClip | null> {
    const segMs = this.cfg.motion.segmentSec * 1000;
    const files = (await readdir(this.deps.ring))
      .map((name) => ({ name, at: segmentStart(name) }))
      .filter((f): f is { name: string; at: number } => f.at !== null && f.at >= winStart - segMs && f.at <= winEnd)
      .sort((a, b) => a.at - b.at);
    if (files.length === 0) {
      this.deps.log("motion: no segments for this event (stream too short?)");
      return null;
    }

    const id = new Date(span.startedAt).toISOString().replace(/[-:.]/g, "");
    const list = join(this.deps.ring, `concat-${id}.txt`);
    await writeFile(list, files.map((f) => `file '${join(this.deps.ring, f.name).replace(/'/g, "'\\''")}'`).join("\n"));

    const probe = await run(this.cfg.ffmpegPath, ["-hide_banner", "-i", join(this.deps.ring, files[0]!.name)]);
    const hevc = /Video: hevc/.test(probe.stderr);
    const out = this.store.file(`${id}.mp4`);
    const r = await run(this.cfg.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", list,
      "-c", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart", out,
    ]);
    await rm(list, { force: true });
    if (r.code !== 0) {
      await rm(out, { force: true });
      throw new Error(`ffmpeg concat exited ${r.code}: ${r.stderr.trim().split("\n").slice(-1)[0]}`);
    }

    const info = await run(this.cfg.ffmpegPath, ["-hide_banner", "-i", out]);
    const d = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(info.stderr);
    const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : (winEnd - winStart) / 1000;

    // thumbnail from the moment motion began (just after the pre-roll)
    const thumb = this.store.file(`${id}.jpg`);
    let hasThumb = false;
    for (const at of [this.cfg.motion.preRollSec + 0.5, 0]) {
      const t = await run(this.cfg.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", out,
        "-frames:v", "1", "-vf", thumbnailFilter(this.deps.zones()), "-q:v", "4", thumb,
      ]);
      if (t.code === 0 && (await this.store.size(id, "jpg"))) {
        hasThumb = true;
        break;
      }
    }

    // What is in the clip? A failure here must never cost the clip: it is saved without labels.
    let objects: ObjectSummary[] | undefined;
    const analyzer = this.deps.analyzer();
    if (analyzer) {
      try {
        objects = (await analyzer.analyzeClip(this.cfg.ffmpegPath, out, durationSec, this.cfg.detect.maxFrames)).map((o) => ({
          label: o.label,
          score: Math.round(o.score * 100) / 100,
        }));
      } catch (e) {
        this.deps.log(`detect: could not analyse ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Analysed and empty: nothing worth keeping. A clip that could not be analysed (objects undefined) is always kept.
    if (objects && objects.length === 0 && this.cfg.detect.discardEmpty) {
      await rm(out, { force: true });
      await rm(thumb, { force: true });
      this.deps.log(`motion: discarded ${id} (nothing recognised)`);
      return null;
    }

    const clip: MotionClip = {
      id,
      startedAt: new Date(span.startedAt).toISOString(),
      endedAt: new Date(span.endedAt).toISOString(),
      durationSec: Math.round(durationSec * 10) / 10,
      peak: Math.round(span.peak * 1000) / 10,
      bytes: (await stat(out)).size,
      clip: `${id}.mp4`,
      thumb: hasThumb ? `${id}.jpg` : null,
      ...(objects ? { objects } : {}),
    };
    await this.store.add(clip);
    return clip;
  }
}
