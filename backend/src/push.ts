import type { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { MotionClip } from "./events.js";

/** Expo push tokens look like ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]. */
const TOKEN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,64}\]$/;
const MAX_DEVICES = 20;
/** Expo accepts at most 100 messages per request. */
const CHUNK = 100;

/** The caller sent something we refuse to store (bad token, too many devices). */
export class PushInputError extends Error {}

interface Message {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  priority: "high";
  channelId: "motion";
}

export interface PushDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Runs `fn` once after `ms`; returns a handle to cancel it. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  log?: (msg: string) => void;
}

const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function length(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/**
 * Push notifications for new motion clips through the Expo push service.
 *
 * What leaves this machine: the phone's push token, and a short text (time, length) plus the clip id.
 * No video, no picture: Expo can only show an image from a public URL, and this backend is private.
 *
 * Rate limit: the first clip is sent at once. Clips that arrive within `pushMinIntervalSec` of the last
 * notification are held back and become one summary ("N more events") when the interval is over,
 * so a busy hour does not turn into a hundred buzzes.
 */
export class PushService {
  private tokens: string[] = [];
  private readonly file: string;
  private saving: Promise<void> = Promise.resolve();

  private lastSentAt = Number.NEGATIVE_INFINITY;
  private held = 0;
  private heldLast?: MotionClip;
  private timer?: { cancel: () => void };

  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly schedule: NonNullable<PushDeps["schedule"]>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly cfg: Pick<Config, "dataDir" | "pushUrl" | "pushMinIntervalSec" | "expoAccessToken">,
    deps: PushDeps = {},
  ) {
    this.file = join(cfg.dataDir, "push-devices.json");
    this.doFetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return { cancel: () => clearTimeout(t) };
      });
  }

  async init(): Promise<void> {
    await mkdir(this.cfg.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { tokens?: unknown };
      this.tokens = Array.isArray(saved.tokens) ? saved.tokens.filter((t): t is string => typeof t === "string" && TOKEN.test(t)) : [];
    } catch {
      this.tokens = [];
    }
  }

  devices(): number {
    return this.tokens.length;
  }

  /** Returns true if the token is new. */
  async register(token: string): Promise<boolean> {
    if (!TOKEN.test(token)) throw new PushInputError("not an Expo push token (expected ExponentPushToken[...])");
    if (this.tokens.includes(token)) return false;
    if (this.tokens.length >= MAX_DEVICES) throw new PushInputError(`too many devices (max ${MAX_DEVICES}); remove one first`);
    this.tokens.push(token);
    await this.save();
    return true;
  }

  async unregister(token: string): Promise<boolean> {
    if (!this.tokens.includes(token)) return false;
    this.tokens = this.tokens.filter((t) => t !== token);
    await this.save();
    return true;
  }

  /** Subscribes to the recorder's "clip" events. */
  attach(recorder: EventEmitter): void {
    recorder.on("clip", (clip: MotionClip) => void this.notifyClip(clip));
  }

  /** Never rejects: it runs inside an event handler, where a rejection would take the process down. */
  async notifyClip(clip: MotionClip): Promise<void> {
    try {
      if (this.tokens.length === 0) return;
      const wait = this.lastSentAt + this.cfg.pushMinIntervalSec * 1000 - this.now();
      if (this.cfg.pushMinIntervalSec === 0 || wait <= 0) {
        this.timer?.cancel();
        this.timer = undefined;
        this.held = 0;
        this.lastSentAt = this.now();
        await this.deliver((to) => ({ to, title: "Motion detected", body: `${clock(new Date(clip.startedAt))} · ${length(clip.durationSec)}${clip.objects?.length ? ` · ${clip.objects.map((o) => o.label).join(", ")}` : ""}`, data: { clipId: clip.id, type: "motion" } }));
        return;
      }
      this.held++;
      this.heldLast = clip;
      this.timer ??= this.schedule(() => void this.flush(), wait);
    } catch (e) {
      this.log(`push: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A plain notification to every device (the vacuum uses it). Never rejects; returns how many devices it went to. */
  async notify(title: string, body: string, type: string): Promise<number> {
    const n = this.tokens.length;
    if (n === 0) return 0;
    try {
      await this.deliver((to) => ({ to, title, body, data: { type } }));
    } catch (e) {
      this.log(`push: ${e instanceof Error ? e.message : e}`);
    }
    return n;
  }

  /** Sends a test notification to every device, ignoring the rate limit. Returns how many devices it went to. */
  async sendTest(): Promise<number> {
    const n = this.tokens.length;
    if (n === 0) return 0;
    await this.deliver((to) => ({ to, title: "Test notification", body: "Push is working", data: { type: "test" } }));
    return n;
  }

  /** Drops the held-back summary (the server is stopping). */
  close(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.held = 0;
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const n = this.held;
    const last = this.heldLast;
    this.held = 0;
    if (n === 0 || !last) return;
    this.lastSentAt = this.now();
    try {
      await this.deliver((to) => ({
        to,
        title: "Motion detected",
        body: `${n} more event${n === 1 ? "" : "s"}, last at ${clock(new Date(last.startedAt))}`,
        data: { clipId: last.id, type: "motion" },
      }));
    } catch (e) {
      this.log(`push: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async deliver(make: (to: string) => Pick<Message, "to" | "title" | "body" | "data">): Promise<void> {
    const messages: Message[] = this.tokens.map((to) => ({ ...make(to), sound: "default", priority: "high", channelId: "motion" }));
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.cfg.expoAccessToken) headers.authorization = `Bearer ${this.cfg.expoAccessToken}`;

    const gone: string[] = [];
    for (let i = 0; i < messages.length; i += CHUNK) {
      const chunk = messages.slice(i, i + CHUNK);
      try {
        const res = await this.doFetch(this.cfg.pushUrl, { method: "POST", headers, body: JSON.stringify(chunk), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          this.log(`push: Expo answered ${res.status}`);
          continue;
        }
        const { data } = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
        (data ?? []).forEach((ticket, j) => {
          if (ticket.status !== "error") return;
          if (ticket.details?.error === "DeviceNotRegistered") gone.push(chunk[j]!.to);
          else this.log(`push: Expo rejected a message: ${ticket.details?.error ?? ticket.message ?? "unknown"}`);
        });
      } catch (e) {
        this.log(`push: could not reach Expo (${e instanceof Error ? e.message : e})`);
      }
    }
    if (gone.length) {
      this.tokens = this.tokens.filter((t) => !gone.includes(t));
      await this.save();
      this.log(`push: forgot ${gone.length} device(s) that are no longer registered`);
    }
  }

  private save(): Promise<void> {
    // Writes go one after another, through a temp file, so a crash never leaves half a file.
    this.saving = this.saving.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ tokens: this.tokens }, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.saving;
  }
}
