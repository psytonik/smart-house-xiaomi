/** Share of pixels whose brightness changed by more than `delta` between two gray frames. */
export function changedRatio(prev: Uint8Array, cur: Uint8Array, delta: number): number {
  let changed = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = (prev[i] as number) - (cur[i] as number);
    if (d > delta || d < -delta) changed++;
  }
  return changed / cur.length;
}

/**
 * ffmpeg's complaints about a damaged video stream. They show up when packets are lost between the camera
 * and go2rtc: the decoder then outputs broken pictures that flicker and look like motion.
 */
const DECODE_ERROR = /undecodable|error while decoding|corrupt|could not find ref|invalid nal|missing reference|non-existing (?:pps|sps)|(?:pps|sps) id out of range|concealing/i;

export const isDecodeError = (line: string): boolean => DECODE_ERROR.test(line);

/**
 * Changed pixels between two gray frames, as a share of ALL pixels:
 *  - `all`:    over the whole picture (used to recognise a lighting change);
 *  - `inZone`: only where `mask` is 1 (what counts as motion). Without a mask both are the same.
 * Both use the whole picture as denominator, so the threshold keeps meaning "this much of the picture"
 * and does not become hypersensitive when a small zone is drawn.
 */
export function changedStats(prev: Uint8Array, cur: Uint8Array, delta: number, mask?: Uint8Array): { all: number; inZone: number } {
  let all = 0;
  let inZone = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = (prev[i] as number) - (cur[i] as number);
    if (d > delta || d < -delta) {
      all++;
      if (!mask || mask[i]) inZone++;
    }
  }
  return { all: all / cur.length, inZone: inZone / cur.length };
}

export interface TrackerOptions {
  /** Ratio above which a frame counts as motion. */
  threshold: number;
  /** No motion for this long ends the event. */
  quietMs: number;
  /** An event longer than this is split. */
  maxMs: number;
  /**
   * A frame where at least this share of pixels changed is a lighting change (IR cut-filter,
   * auto exposure), not motion. Off when omitted.
   */
  lightChange?: number;
  /** Motion is ignored for this long after a lighting change, while the picture settles. */
  settleMs?: number;
}

export interface MotionSpan {
  startedAt: number;
  endedAt: number;
  /** Highest changed ratio seen. */
  peak: number;
}

interface Active {
  startedAt: number;
  lastMotion: number;
  peak: number;
}

/**
 * Turns a stream of per-frame change ratios into start/end events.
 * An event starts when 2 of the last 3 frames show motion, so a single flicker is ignored.
 */
export class MotionTracker {
  private recent: boolean[] = [];
  private active?: Active;
  private suppressUntil = 0;

  constructor(
    private o: TrackerOptions,
    private on: { start: (at: number) => void; end: (span: MotionSpan) => void },
  ) {}

  get recording(): boolean {
    return this.active !== undefined;
  }

  /** Ignore motion until `until` (ms timestamp), e.g. while the camera itself is turning. */
  suppress(until: number): void {
    this.suppressUntil = Math.max(this.suppressUntil, until);
    this.recent = [];
  }

  /**
   * `ratio`: share of the picture that changed inside the motion zones. `wholePicture`: share that changed anywhere;
   * a lighting change is judged by that, since a zone may hide most of it. Defaults to `ratio` (no zones).
   */
  feed(ratio: number, now: number, wholePicture: number = ratio): void {
    // Night mode or an exposure jump changes nearly every pixel at once and keeps drifting for a moment.
    // That is not an event: skip the spike and the settling frames after it.
    if (this.o.lightChange !== undefined && wholePicture >= this.o.lightChange) {
      this.suppress(now + (this.o.settleMs ?? 0));
    }
    const moving = now >= this.suppressUntil && ratio > this.o.threshold;

    if (!this.active) {
      this.recent.push(moving);
      if (this.recent.length > 3) this.recent.shift();
      if (this.recent.filter(Boolean).length >= 2) {
        this.recent = [];
        this.active = { startedAt: now, lastMotion: now, peak: ratio };
        this.on.start(now);
      }
      return;
    }

    const a = this.active;
    if (moving) {
      a.lastMotion = now;
      a.peak = Math.max(a.peak, ratio);
    }
    if (now - a.lastMotion >= this.o.quietMs) {
      this.finish(a.lastMotion);
    } else if (now - a.startedAt >= this.o.maxMs) {
      this.finish(now);
      if (moving) {
        this.active = { startedAt: now, lastMotion: now, peak: ratio };
        this.on.start(now);
      }
    }
  }

  /** Closes an open event (stream ended or the recorder is stopping). */
  stop(): void {
    if (this.active) this.finish(this.active.lastMotion);
    this.recent = [];
  }

  private finish(endedAt: number): void {
    const a = this.active;
    this.active = undefined;
    if (a) this.on.end({ startedAt: a.startedAt, endedAt, peak: a.peak });
  }
}
