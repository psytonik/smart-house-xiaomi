import { connect } from "node:net";

/** CozyLife attribute ids (same for every light model we have seen). */
const ATTR = { power: "1", mode: "2", temp: "3", bright: "4", hue: "5", sat: "6" } as const;

const CMD_QUERY = 2;
const CMD_SET = 3;
const TIMEOUT_MS = 3000;

export interface LightState {
  on: boolean;
  /** 0..100 */
  brightness: number;
  /** 0..360 */
  hue: number;
  /** 0..100 */
  saturation: number;
  /** 0..100, white tone. */
  temperature: number;
}

export type LightPatch = Partial<LightState>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Turns a user-facing patch into the lamp's own units (brightness and saturation are 0..1000 there). */
export function toDevice(patch: LightPatch): Record<string, number> {
  const data: Record<string, number> = {};
  if (patch.on !== undefined) data[ATTR.power] = patch.on ? 255 : 0;
  const visual =
    patch.brightness !== undefined || patch.hue !== undefined || patch.saturation !== undefined || patch.temperature !== undefined;
  // Picking a brightness or colour leaves any running effect and goes back to a static picture.
  if (visual) data[ATTR.mode] = 0;
  if (patch.brightness !== undefined) data[ATTR.bright] = clamp(patch.brightness * 10, 0, 1000);
  if (patch.hue !== undefined) data[ATTR.hue] = clamp(patch.hue, 0, 360);
  if (patch.saturation !== undefined) data[ATTR.sat] = clamp(patch.saturation * 10, 0, 1000);
  if (patch.temperature !== undefined) data[ATTR.temp] = clamp(patch.temperature * 10, 0, 1000);
  return data;
}

export function fromDevice(data: Record<string, number>): LightState {
  const n = (k: string) => (typeof data[k] === "number" ? data[k]! : 0);
  return {
    on: n(ATTR.power) > 0,
    brightness: Math.round(n(ATTR.bright) / 10),
    hue: n(ATTR.hue),
    saturation: Math.round(n(ATTR.sat) / 10),
    temperature: Math.round(n(ATTR.temp) / 10),
  };
}

export class LightError extends Error {}

/**
 * Local CozyLife client: one short TCP connection per call (the lamp only serves a few clients and
 * the phone app needs a slot too). Calls are queued so two requests never hold two connections.
 */
export class CozyLight {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly ip: string,
    private port = 5555,
  ) {}

  private exchange(cmd: number, msg: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sn = String(Date.now());
      const socket = connect(this.port, this.ip);
      let buf = "";
      const timer = setTimeout(() => done(new LightError("lamp did not answer")), TIMEOUT_MS);
      const done = (err: Error | null, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value!);
      };
      socket.on("connect", () => socket.write(JSON.stringify({ cmd, pv: 0, sn, msg }) + "\r\n"));
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\r\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          let r: { cmd?: number; res?: number; msg?: { data?: Record<string, number> } };
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (r.cmd !== cmd) continue; // state reports (cmd 10) can arrive in between
          if (r.res !== undefined && r.res !== 0) return done(new LightError(`lamp rejected the command (${r.res})`));
          return done(null, r as Record<string, unknown>);
        }
      });
      socket.on("error", (e) => done(new LightError(`lamp unreachable: ${e.message}`)));
    });
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  state(): Promise<LightState> {
    return this.serial(async () => {
      const r = (await this.exchange(CMD_QUERY, { attr: [0] })) as { msg?: { data?: Record<string, number> } };
      return fromDevice(r.msg?.data ?? {});
    });
  }

  set(patch: LightPatch): Promise<LightState> {
    return this.serial(async () => {
      // This lamp drops a hue that arrives without its saturation (it falls back to 0, red). Colour goes as a pair.
      if ((patch.hue === undefined) !== (patch.saturation === undefined)) {
        const r = (await this.exchange(CMD_QUERY, { attr: [0] })) as { msg?: { data?: Record<string, number> } };
        const now = fromDevice(r.msg?.data ?? {});
        patch = { ...patch, hue: patch.hue ?? now.hue, saturation: patch.saturation ?? now.saturation };
      }
      const data = toDevice(patch);
      if (Object.keys(data).length > 0) {
        await this.exchange(CMD_SET, { attr: Object.keys(data).map(Number), data });
      }
      const r = (await this.exchange(CMD_QUERY, { attr: [0] })) as { msg?: { data?: Record<string, number> } };
      return fromDevice(r.msg?.data ?? {});
    });
  }
}
