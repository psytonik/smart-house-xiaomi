import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { LightError } from "./light.js";

/**
 * Local client for Tuya / Smart Life bulbs that speak protocol 3.5 (port 6668, AES-128-GCM frames "6699").
 * No cloud: it needs only the bulb's address, its device id and its local key (see docs/tuya-lights.md for where the key comes from).
 *
 * Every call opens one short connection, agrees a session key with the bulb, does its work and closes, so the Smart Life app keeps its own
 * slot. Calls to one bulb are queued.
 */

const PREFIX = Buffer.from([0x00, 0x00, 0x66, 0x99]);
const SUFFIX = Buffer.from([0x00, 0x00, 0x99, 0x66]);
const HEADER_LEN = 18; // prefix 4, reserved 2, seqno 4, command 4, length 4
const CMD = { negStart: 3, negResp: 4, negFinish: 5, control: 0x0d, status: 8, query: 0x10 } as const;
/** "3.5" and twelve zero bytes: the commands that carry user data begin with it. */
const VERSION_HEADER = Buffer.concat([Buffer.from("3.5"), Buffer.alloc(12)]);
const TIMEOUT_MS = 4000;

/** Datapoints of a Tuya light ("dj" category). Values are in the bulb's units: brightness and saturation 0..1000. */
const DP = { power: "20", mode: "21", bright: "22", colour: "24" } as const;
const MIN_BRIGHT = 10;

export interface TuyaState {
  on: boolean;
  /** 0..100 */
  brightness: number;
  /** 0..360 (0 in white mode) */
  hue: number;
  /** 0..100 (0 in white mode) */
  saturation: number;
}

export interface TuyaPatch {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
}

export interface TuyaConfig {
  id: string;
  name: string;
  ip: string;
  deviceId: string;
  /** 16 characters. */
  localKey: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/** One frame, ready to send. `key` is the local key before the session is agreed and the session key after. */
export function packFrame(seq: number, cmd: number, payload: Buffer, key: Buffer, iv: Buffer = randomBytes(12)): Buffer {
  const head = Buffer.alloc(HEADER_LEN - 4);
  head.writeUInt16BE(0, 0);
  head.writeUInt32BE(seq, 2);
  head.writeUInt32BE(cmd, 6);
  head.writeUInt32BE(12 + payload.length + 16, 10);
  const cipher = createCipheriv("aes-128-gcm", key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([PREFIX, head, iv, body, cipher.getAuthTag(), SUFFIX]);
}

export interface Frame {
  seq: number;
  cmd: number;
  /** Decrypted bytes: for answers, still starting with the 4-byte return code. */
  payload: Buffer;
}

/** The first whole frame in `buf` and how many bytes it took, or undefined when more bytes are needed. */
export function unpackFrame(buf: Buffer, key: Buffer): { frame: Frame; used: number } | undefined {
  const start = buf.indexOf(PREFIX);
  if (start < 0 || buf.length - start < HEADER_LEN) return undefined;
  const len = buf.readUInt32BE(start + 14);
  const total = HEADER_LEN + len + 4;
  if (len < 28 || len > 65536) throw new LightError("bulb sent a damaged frame");
  if (buf.length - start < total) return undefined;
  const head = buf.subarray(start + 4, start + HEADER_LEN);
  const iv = buf.subarray(start + HEADER_LEN, start + HEADER_LEN + 12);
  const tag = buf.subarray(start + total - 4 - 16, start + total - 4);
  const body = buf.subarray(start + HEADER_LEN + 12, start + total - 4 - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, iv);
  decipher.setAAD(head);
  decipher.setAuthTag(tag);
  let payload: Buffer;
  try {
    payload = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new LightError("bulb answer did not check out (wrong local key?)");
  }
  return { frame: { seq: head.readUInt32BE(2), cmd: head.readUInt32BE(6), payload }, used: start + total };
}

/** The session key both sides derive from their two nonces. */
export function sessionKey(localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
  const mixed = Buffer.from(localNonce.map((b, i) => b ^ remoteNonce[i]!));
  const cipher = createCipheriv("aes-128-gcm", localKey, localNonce.subarray(0, 12));
  return Buffer.concat([cipher.update(mixed), cipher.final()]).subarray(0, 16);
}

/** `hhhhssssvvvv` in hex: hue 0..360, saturation and value 0..1000. */
export function toColourDp(hue: number, saturation: number, value: number): string {
  return hex4(clamp(hue, 0, 360)) + hex4(clamp(saturation, 0, 1000)) + hex4(clamp(value, 0, 1000));
}

function fromColourDp(v: unknown): { hue: number; sat: number; val: number } | undefined {
  if (typeof v !== "string" || !/^[0-9a-f]{12}$/i.test(v)) return undefined;
  return { hue: parseInt(v.slice(0, 4), 16), sat: parseInt(v.slice(4, 8), 16), val: parseInt(v.slice(8, 12), 16) };
}

export function fromDps(dps: Record<string, unknown>): TuyaState {
  const on = dps[DP.power] === true;
  const colour = dps[DP.mode] === "colour" ? fromColourDp(dps[DP.colour]) : undefined;
  if (colour) return { on, brightness: Math.round(colour.val / 10), hue: colour.hue, saturation: Math.round(colour.sat / 10) };
  const b = typeof dps[DP.bright] === "number" ? (dps[DP.bright] as number) : 1000;
  return { on, brightness: Math.round(b / 10), hue: 0, saturation: 0 };
}

/** What to send to make `patch` true when the bulb is in `now`. Empty when there is nothing to change. */
export function toDps(patch: TuyaPatch, now: Record<string, unknown>): Record<string, unknown> {
  const dps: Record<string, unknown> = {};
  if (patch.on !== undefined) dps[DP.power] = patch.on;
  const wantsColour = patch.hue !== undefined || patch.saturation !== undefined;
  if (wantsColour) {
    const cur = fromDps(now);
    const value = Math.max(MIN_BRIGHT, patch.brightness !== undefined ? patch.brightness * 10 : cur.brightness * 10);
    if (patch.saturation === 0) {
      // no colour at all: the bulb's own white (its warmth stays as it was)
      dps[DP.mode] = "white";
      dps[DP.bright] = value;
    } else {
      dps[DP.mode] = "colour";
      dps[DP.colour] = toColourDp(patch.hue ?? cur.hue, (patch.saturation ?? (cur.saturation || 100)) * 10, value);
    }
    if (patch.on === undefined && now[DP.power] !== true) dps[DP.power] = true; // a colour command lights the bulb
  } else if (patch.brightness !== undefined) {
    const value = Math.max(MIN_BRIGHT, clamp(patch.brightness * 10, 0, 1000));
    const colour = now[DP.mode] === "colour" ? fromColourDp(now[DP.colour]) : undefined;
    if (colour) dps[DP.colour] = toColourDp(colour.hue, colour.sat, value);
    else dps[DP.bright] = value;
  }
  return dps;
}

/** Return code (4 bytes) and the "3.5" header are not part of the JSON. */
function parseAnswer(payload: Buffer): Record<string, unknown> | undefined {
  let p = payload;
  if (p.length >= 4 && p.readUInt32BE(0) < 256 && p[4] !== undefined && (p[4] === 0x7b || p[4] === 0x33)) p = p.subarray(4);
  if (p.subarray(0, 3).toString() === "3.5") p = p.subarray(VERSION_HEADER.length);
  try {
    const j = JSON.parse(p.toString());
    return j && typeof j === "object" ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class TuyaBulb {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly cfg: TuyaConfig,
    private port = 6668,
  ) {}

  /** Runs `work` on a fresh authenticated session. */
  private session<T>(work: (send: (cmd: number, json: object | undefined) => Promise<Frame>) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const realKey = Buffer.from(this.cfg.localKey, "utf8");
      if (realKey.length !== 16) return reject(new LightError(`${this.cfg.name}: local key must be 16 characters`));
      const socket = connect({ host: this.cfg.ip, port: this.port });
      let key: Buffer = realKey;
      let seq = 1;
      let buf = Buffer.alloc(0);
      let waiter: ((f: Frame) => void) | undefined;
      let failed: ((e: Error) => void) | undefined;
      let finished = false;
      const finish = (err: Error | null, value?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err instanceof LightError ? err : new LightError(`${this.cfg.name}: ${err.message}`));
        else resolve(value as T);
      };
      const timer = setTimeout(() => finish(new LightError(`${this.cfg.name}: lamp did not answer`)), TIMEOUT_MS);
      socket.on("error", () => finish(new LightError(`${this.cfg.name}: lamp did not answer`)));
      socket.on("close", () => finish(new LightError(`${this.cfg.name}: lamp closed the connection`)));
      const drain = () => {
        try {
          for (;;) {
            const got = unpackFrame(buf, key);
            if (!got) return;
            buf = buf.subarray(got.used);
            const w = waiter;
            if (w) {
              waiter = undefined;
              w(got.frame);
            }
          }
        } catch (e) {
          failed?.(e as Error);
        }
      };
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        drain();
      });
      const exchange = (cmd: number, payload: Buffer, accept: (c: number) => boolean): Promise<Frame> =>
        new Promise<Frame>((res, rej) => {
          failed = rej;
          const wait = () => {
            waiter = (f) => (accept(f.cmd) ? res(f) : wait());
          };
          wait();
          socket.write(packFrame(seq++, cmd, payload, key));
        });
      socket.on("connect", () => {
        void (async () => {
          // 1. agree on a session key
          const localNonce = randomBytes(16);
          const r = await exchange(CMD.negStart, localNonce, (c) => c === CMD.negResp);
          let p = r.payload;
          if (p.length >= 52) p = p.subarray(p.length - 48);
          if (p.length < 48) throw new LightError(`${this.cfg.name}: bulb did not agree a session`);
          const remoteNonce = p.subarray(0, 16);
          const expect = createHmac("sha256", realKey).update(localNonce).digest();
          if (!expect.equals(p.subarray(16, 48))) throw new LightError(`${this.cfg.name}: wrong local key`);
          const finishPayload = createHmac("sha256", realKey).update(remoteNonce).digest();
          seqSend(CMD.negFinish, finishPayload);
          key = sessionKey(realKey, localNonce, Buffer.from(remoteNonce));
          // 2. the actual work
          const send = (cmd: number, json: object | undefined) => {
            const body = json ? Buffer.from(JSON.stringify(json)) : Buffer.alloc(0);
            const payload = cmd === CMD.query ? body : Buffer.concat([VERSION_HEADER, body]);
            return exchange(cmd, payload, (c) => (cmd === CMD.query ? c === CMD.query : c === CMD.control || c === CMD.status));
          };
          return work(send);
        })().then(
          (v) => finish(null, v),
          (e: Error) => finish(e),
        );
      });
      const seqSend = (cmd: number, payload: Buffer) => socket.write(packFrame(seq++, cmd, payload, key));
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readDps(send: (cmd: number, json: object | undefined) => Promise<Frame>): Promise<Record<string, unknown>> {
    const f = await send(CMD.query, {});
    const dps = (parseAnswer(f.payload)?.dps ?? undefined) as Record<string, unknown> | undefined;
    if (!dps) throw new LightError(`${this.cfg.name}: bulb gave no state`);
    return dps;
  }

  state(): Promise<TuyaState> {
    return this.enqueue(() => this.session(async (send) => fromDps(await this.readDps(send))));
  }

  set(patch: TuyaPatch): Promise<void> {
    return this.enqueue(() =>
      this.session(async (send) => {
        const needsNow = patch.brightness !== undefined || patch.hue !== undefined || patch.saturation !== undefined;
        const now = needsNow ? await this.readDps(send) : {};
        const dps = toDps(patch, now);
        if (Object.keys(dps).length === 0) return;
        await send(CMD.control, { protocol: 5, t: Math.floor(Date.now() / 1000), data: { dps } });
      }),
    );
  }
}
