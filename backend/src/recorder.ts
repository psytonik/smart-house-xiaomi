import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ObjectSummary } from "./detect.js";
import { EventStore, type MotionClip } from "./events.js";
import { MotionTracker, changedStats, isDecodeError, type MotionSpan } from "./motion.js";
import { thumbnailFilter } from "./privacy.js";
import { buildMask, type Zone } from "./zones.js";

/** Anything that can say what is in a finished clip (the object detector). */
export interface ClipAnalyzer {
  analyzeClip(ffmpegPath: string, clipFile: string, durationSec: number, maxFrames: number): Promise<ObjectSummary[]>;
}

export type RecorderState = "off" | "starting" | "running" | "ffmpeg-missing" | "restarting";

export interface StorageStatus {
  clips: number;
  /** Space taken by the clips. */
  usedBytes: number;
  /** Configured limit (MAX_STORAGE_GB). */
  limitBytes: number;
  /** Free space on the volume that holds the data. */
  freeBytes: number;
}

export interface RecorderStatus {
  enabled: boolean;
  state: RecorderState;
  /** An event is being recorded right now. */
  recording: boolean;
  /** Share of the last frame that changed inside the motion zones, in percent. */
  level: number;
  /** Level (percent) from which a frame counts as motion. */
  threshold: number;
  /** The picture may be damaged: ffmpeg is (re)connecting, just started, or the decoder complained a moment ago. */
  unstable: boolean;
}

/** After ffmpeg (re)starts the stream needs this long to settle (no keyframe yet, lost packets). */
const SETTLE_AFTER_START_MS = 20_000;
/** The picture counts as damaged until this long after the last decoder warning. */
const DAMAGE_HOLD_MS = 5_000;

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

/**
 * One ffmpeg process reads the camera stream and writes two things:
 *  - copy segments (no re-encoding) into a short rolling ring, which gives "pre-roll";
 *  - small gray frames on stdout for motion detection.
 * When the tracker closes an event, the matching segments are joined into <id>.mp4.
 */
export class MotionRecorder extends EventEmitter {
  readonly store: EventStore;
  private ring: string;
  private proc?: ChildProcess;
  private tracker: MotionTracker;
  private state: RecorderState = "off";
  private level = 0;
  private stopping = false;
  private restartDelay = 2000;
  private restartTimer?: NodeJS.Timeout;
  private timers = new Set<NodeJS.Timeout>();
  private sweepers: NodeJS.Timeout[] = [];
  private prev: Buffer | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private storageCache?: { at: number; value: StorageStatus };
  private mask: Uint8Array | null = null;
  private zones: Zone[] = [];
  private analyzer?: ClipAnalyzer;
  /** Whether ffmpeg has delivered a frame since it was last started. */
  private gotFrame = false;
  private launchedAt = 0;
  private lastDamageAt = 0;
  /** Decoder warnings per second (key: unix second), kept for the last minute. */
  private damagedBySecond = new Map<number, number>();
  private restarts = 0;
  private stalls = 0;
  /** When ffmpeg last delivered a frame (or was started): a long silence means the stream is frozen. */
  private lastFrameAt = Date.now();
  /** Decoder warnings since the last summary line; one line per damaged frame would flood the log. */
  private damaged = 0;
  private damagedLoggedAt = 0;

  constructor(
    private cfg: Config,
    private log: (msg: string) => void = () => {},
  ) {
    super();
    this.store = new EventStore(join(cfg.dataDir, "events"));
    this.ring = join(cfg.dataDir, "ring");
    const m = cfg.motion;
    this.tracker = new MotionTracker(
      {
        threshold: m.threshold,
        quietMs: m.quietSec * 1000,
        maxMs: m.maxClipSec * 1000,
        lightChange: m.lightChange,
        settleMs: m.settleMs,
      },
      {
        start: () => this.log("motion: started"),
        end: (span) => this.scheduleAssemble(span),
      },
    );
  }

  status(): RecorderStatus {
    return {
      enabled: this.cfg.motion.enabled,
      state: this.state,
      recording: this.tracker.recording,
      level: Math.round(this.level * 1000) / 10,
      threshold: Math.round(this.cfg.motion.threshold * 1000) / 10,
      unstable: this.unstable(),
    };
  }

  private unstable(): boolean {
    if (!this.cfg.motion.enabled || this.state === "off") return false;
    const now = Date.now();
    return this.state !== "running" || now - this.launchedAt < SETTLE_AFTER_START_MS || now - this.lastDamageAt < DAMAGE_HOLD_MS;
  }

  /** What the system panel needs to judge the video pipeline. */
  health(): { enabled: boolean; state: RecorderState; frameAgeSec: number | null; damagedLastMinute: number; restarts: number; stalls: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    let damaged = 0;
    for (const [sec, n] of this.damagedBySecond) if (sec > nowSec - 60) damaged += n;
    return {
      enabled: this.cfg.motion.enabled,
      state: this.state,
      frameAgeSec: this.gotFrame && this.proc ? Math.round(((Date.now() - this.lastFrameAt) / 1000) * 10) / 10 : null,
      damagedLastMinute: damaged,
      restarts: this.restarts,
      stalls: this.stalls,
    };
  }

  /** New clips are labelled with what the analyzer finds in them. */
  setDetector(analyzer: ClipAnalyzer): void {
    this.analyzer = analyzer;
  }

  /** Applies motion zones right away (the next frame already uses them). */
  setZones(zones: Zone[]): void {
    this.zones = zones;
    this.mask = buildMask(zones, this.cfg.motion.width, this.cfg.motion.height);
  }

  /** Clip count, disk usage and free space. Cached briefly: the web app asks every few seconds. */
  async storage(): Promise<StorageStatus> {
    if (!this.storageCache || Date.now() - this.storageCache.at > 15_000) {
      const [usage, fs] = await Promise.all([this.store.usage(), statfs(this.cfg.dataDir)]);
      this.storageCache = {
        at: Date.now(),
        value: { clips: usage.clips, usedBytes: usage.bytes, limitBytes: this.cfg.maxStorageBytes, freeBytes: fs.bavail * fs.bsize },
      };
    }
    return this.storageCache.value;
  }

  /** Call after clips are added or removed so the next `storage()` is fresh. */
  invalidateStorage(): void {
    this.storageCache = undefined;
  }

  /** Ignore motion for a while: the camera itself is moving. */
  suppress(ms: number): void {
    this.tracker.suppress(Date.now() + ms);
  }

  async start(): Promise<void> {
    await this.store.init();
    if (!this.cfg.motion.enabled) return;
    rmSync(this.ring, { recursive: true, force: true });
    mkdirSync(this.ring, { recursive: true });
    this.state = "starting";
    this.launch();
    const sweep = () => void this.sweep().catch((e) => this.log(`sweep failed: ${e}`));
    this.sweepers.push(setInterval(() => void this.cleanRing(), 10_000));
    this.sweepers.push(setInterval(() => this.watch(), 1000));
    this.sweepers.push(setInterval(sweep, 30 * 60_000));
    sweep();
    for (const t of this.sweepers) t.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.sweepers.forEach(clearInterval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.proc?.kill("SIGTERM");
    this.tracker.stop(); // would schedule an assembly; cancelled right below
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.state = "off";
  }

  // ---------------------------------------------------------------- ffmpeg

  private args(): string[] {
    const m = this.cfg.motion;
    const input = /^rtsps?:\/\//.test(this.cfg.input) ? ["-rtsp_transport", "tcp"] : ["-re"];
    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      ...input,
      "-i",
      this.cfg.input,
      // 1) rolling copy segments for clips
      "-map", "0:v:0", "-c", "copy", "-an",
      "-f", "segment", "-segment_time", String(m.segmentSec), "-reset_timestamps", "1", "-strftime", "1",
      join(this.ring, "seg-%Y%m%dT%H%M%S.ts"),
      // 2) small gray frames for motion detection
      "-map", "0:v:0", "-vf", `fps=${m.fps},scale=${m.width}:${m.height},format=gray`, "-an",
      "-f", "rawvideo", "pipe:1",
    ];
  }

  private launch(): void {
    const frameSize = this.cfg.motion.width * this.cfg.motion.height;
    this.prev = null;
    this.buf = Buffer.alloc(0);
    this.lastFrameAt = Date.now();
    this.launchedAt = Date.now();
    this.gotFrame = false;
    const proc = spawn(this.cfg.ffmpegPath, this.args(), { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;

    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        this.state = "ffmpeg-missing";
        this.log(`motion: ffmpeg not found ("${this.cfg.ffmpegPath}"). Install it (brew install ffmpeg) or set FFMPEG_PATH.`);
        return;
      }
      this.log(`motion: ffmpeg failed: ${e.message}`);
    });

    proc.stderr.on("data", (c: Buffer) => {
      for (const line of c.toString().split("\n")) {
        const text = line.trim();
        if (!text) continue;
        if (isDecodeError(text)) {
          this.lastDamageAt = Date.now();
          // Lost packets give a broken picture that flickers like motion: ignore motion while it lasts.
          // The first seconds after a start are always full of these (no keyframe yet): do not call that damage.
          if (Date.now() - this.launchedAt >= this.cfg.motion.startupGraceSec * 1000) {
            this.damaged++;
            const sec = Math.floor(Date.now() / 1000);
            this.damagedBySecond.set(sec, (this.damagedBySecond.get(sec) ?? 0) + 1);
          }
          this.tracker.suppress(Date.now() + this.cfg.motion.settleMs);
        } else {
          this.log(`ffmpeg: ${text}`);
        }
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      while (this.buf.length >= frameSize) {
        const frame = Buffer.from(this.buf.subarray(0, frameSize));
        this.buf = this.buf.subarray(frameSize);
        this.onFrame(frame);
      }
    });

    proc.on("close", (code) => {
      if (this.proc === proc) this.proc = undefined;
      this.tracker.stop();
      if (this.stopping || this.state === "ffmpeg-missing") return;
      this.state = "restarting";
      this.restarts++;
      this.log(`motion: ffmpeg exited (${code}); restarting in ${this.restartDelay / 1000}s`);
      this.restartTimer = setTimeout(() => this.launch(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    });
  }

  private onFrame(frame: Buffer): void {
    this.lastFrameAt = Date.now();
    this.gotFrame = true;
    if (this.state !== "running") {
      this.state = "running";
      this.restartDelay = 2000;
    }
    if (this.prev) {
      const stats = changedStats(this.prev, frame, this.cfg.motion.pixelDelta, this.mask ?? undefined);
      this.level = stats.inZone;
      this.tracker.feed(stats.inZone, Date.now(), stats.all);
    }
    this.prev = frame;
  }

  /** Once a second: summarise decoder warnings, and deal with a stream that has frozen. */
  private watch(): void {
    const now = Date.now();
    for (const sec of this.damagedBySecond.keys()) if (sec <= Math.floor(now / 1000) - 60) this.damagedBySecond.delete(sec);
    if (this.damaged > 0 && now - this.damagedLoggedAt >= 10_000) {
      this.log(`motion: the picture is damaged (${this.damaged} decoder warnings): packets are being lost between the camera and go2rtc. Motion is ignored while it lasts.`);
      this.damaged = 0;
      this.damagedLoggedAt = now;
    }

    const stallMs = this.cfg.motion.stallSec * 1000;
    const proc = this.proc;
    if (proc && !this.stopping && now - this.lastFrameAt > stallMs) {
      // ffmpeg is alive but silent (the link to the camera froze). Without frames the tracker never learns that
      // the event is over, so it would stay "recording" with a stale level. Close it and start over.
      this.stalls++;
      this.log(`motion: no frames for ${this.cfg.motion.stallSec}s, restarting ffmpeg`);
      this.lastFrameAt = now;
      this.level = 0;
      this.tracker.stop();
      proc.kill("SIGKILL");
    }
  }

  // ---------------------------------------------------------------- clips

  private scheduleAssemble(span: MotionSpan): void {
    const m = this.cfg.motion;
    const winStart = span.startedAt - m.preRollSec * 1000;
    const winEnd = span.endedAt + m.postRollSec * 1000;
    // wait until the segment containing the end of the window has been closed
    const delay = Math.max(0, winEnd + m.segmentSec * 1000 + 1500 - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.assemble(span, winStart, winEnd).catch((e) => this.log(`motion: clip failed: ${e}`));
    }, delay);
    this.timers.add(t);
  }

  private async assemble(span: MotionSpan, winStart: number, winEnd: number): Promise<void> {
    const segMs = this.cfg.motion.segmentSec * 1000;
    const files = (await readdir(this.ring))
      .map((name) => ({ name, at: segmentStart(name) }))
      .filter((f): f is { name: string; at: number } => f.at !== null && f.at >= winStart - segMs && f.at <= winEnd)
      .sort((a, b) => a.at - b.at);
    if (files.length === 0) {
      this.log("motion: no segments for this event (stream too short?)");
      return;
    }

    const id = new Date(span.startedAt).toISOString().replace(/[-:.]/g, "");
    const list = join(this.ring, `concat-${id}.txt`);
    await writeFile(list, files.map((f) => `file '${join(this.ring, f.name).replace(/'/g, "'\\''")}'`).join("\n"));

    const probe = await run(this.cfg.ffmpegPath, ["-hide_banner", "-i", join(this.ring, files[0]!.name)]);
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
        "-frames:v", "1", "-vf", thumbnailFilter(this.zones), "-q:v", "4", thumb,
      ]);
      if (t.code === 0 && (await this.store.size(id, "jpg"))) {
        hasThumb = true;
        break;
      }
    }

    // What is in the clip? A failure here must never cost the clip: it is saved without labels.
    let objects: ObjectSummary[] | undefined;
    if (this.analyzer) {
      try {
        objects = (await this.analyzer.analyzeClip(this.cfg.ffmpegPath, out, durationSec, this.cfg.detect.maxFrames)).map((o) => ({
          label: o.label,
          score: Math.round(o.score * 100) / 100,
        }));
      } catch (e) {
        this.log(`detect: could not analyse ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Analysed and empty: nothing worth keeping. A clip that could not be analysed (objects undefined) is always kept.
    if (objects && objects.length === 0 && this.cfg.detect.discardEmpty) {
      await rm(out, { force: true });
      await rm(thumb, { force: true });
      this.log(`motion: discarded ${id} (nothing recognised)`);
      return;
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
    this.invalidateStorage();
    await this.enforceSizeLimit();
    this.log(`motion: saved ${id} (${clip.durationSec}s, ${(clip.bytes / 1e6).toFixed(1)} MB${objects ? `, ${objects.length ? objects.map((o) => o.label).join("+") : "nothing recognised"}` : ""})`);
    this.emit("clip", clip);
  }

  // ---------------------------------------------------------------- housekeeping

  /** Deletes ring segments that no event can need anymore. */
  private async cleanRing(): Promise<void> {
    const m = this.cfg.motion;
    const keepMs = (m.maxClipSec + m.preRollSec + m.postRollSec + m.segmentSec) * 1000 + 30_000;
    const cutoff = Date.now() - keepMs;
    for (const name of await readdir(this.ring).catch(() => [])) {
      const at = segmentStart(name);
      if (at !== null && at < cutoff) await rm(join(this.ring, name), { force: true });
    }
  }

  private async sweep(): Promise<void> {
    const removed = await this.store.prune(Date.now() - this.cfg.retentionDays * 86_400_000);
    if (removed) this.log(`retention: removed ${removed} old clip(s)`);
    await this.enforceSizeLimit();
  }

  /** Deletes the oldest clips when they take more than MAX_STORAGE_GB. */
  private async enforceSizeLimit(): Promise<void> {
    const removed = await this.store.pruneToSize(this.cfg.maxStorageBytes);
    if (removed) {
      this.invalidateStorage();
      this.log(`storage: over the limit, removed ${removed} oldest clip(s)`);
    }
  }
}
