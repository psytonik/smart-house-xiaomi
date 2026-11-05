import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import type { Config } from "./config.js";

/** What a device does. The page, and the voice assistant, are chosen by it. */
export const DEVICE_KINDS = ["camera", "vacuum", "light", "tv", "plug", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** How we talk to it. */
export const PROTOCOLS = ["miio", "cozylife", "androidtv", "go2rtc", "other"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** A device we were told about (found on the network, or typed in). Lives in data/devices.json, which holds the tokens: mode 600. */
export interface DeviceRecord {
  id: string;
  kind: DeviceKind;
  protocol: Protocol;
  name: string;
  room?: string;
  host?: string;
  model?: string;
  /** The device's own id (Xiaomi "did", CozyLife "did"): how a scan recognises it again. */
  did?: string;
  /** The key for the local protocol (a Xiaomi token, 32 hex characters). Secret: never leaves the server. */
  token?: string;
  origin: "discovered" | "manual";
  addedAt: string;
}

/** What the web app and the assistant see: no token, and the devices still configured in .env are listed too (read-only). */
export interface DeviceView extends Omit<DeviceRecord, "token" | "origin"> {
  origin: "env" | "discovered" | "manual";
  hasToken: boolean;
  /** false for the devices that come from .env: rename them there. */
  editable: boolean;
}

export const MAX_DEVICES = 100;

/** The caller sent a device we refuse to store. */
export class DeviceError extends Error {}

/** Addresses of a home network. A device outside them is not "at home" and we never send it anything. */
export function isPrivateIPv4(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, label: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new DeviceError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new DeviceError(`${label} must be text`);
  const v = value.trim();
  if (!v) {
    if (required) throw new DeviceError(`${label} is required`);
    return undefined;
  }
  if (v.length > max) throw new DeviceError(`${label} is longer than ${max} characters`);
  if (CONTROL.test(v)) throw new DeviceError(`${label} has control characters`);
  return v;
}

export function parseName(value: unknown): string {
  return text(value, "name", 60, true)!;
}

export function parseRoom(value: unknown): string | undefined {
  return text(value, "room", 40, false);
}

/** Checks one device the way it will be stored. Throws DeviceError with the reason. */
export function parseDevice(raw: unknown, label = "device"): DeviceRecord {
  if (typeof raw !== "object" || raw === null) throw new DeviceError(`${label}: not an object`);
  const r = raw as Record<string, unknown>;
  const fail = (m: string): never => {
    throw new DeviceError(`${label}: ${m}`);
  };
  if (typeof r.id !== "string" || !/^[a-z0-9-]{3,40}$/.test(r.id)) fail("id must be 3..40 characters a-z, 0-9, -");
  if (!DEVICE_KINDS.includes(r.kind as DeviceKind)) fail(`kind must be one of ${DEVICE_KINDS.join(", ")}`);
  if (!PROTOCOLS.includes(r.protocol as Protocol)) fail(`protocol must be one of ${PROTOCOLS.join(", ")}`);
  if (r.origin !== "discovered" && r.origin !== "manual") fail('origin must be "discovered" or "manual"');
  let host: string | undefined;
  if (r.host !== undefined && r.host !== null && r.host !== "") {
    if (typeof r.host !== "string" || !isPrivateIPv4(r.host)) fail("host must be an address of the home network (10.x, 172.16-31.x, 192.168.x)");
    host = r.host as string;
  }
  let token: string | undefined;
  if (r.token !== undefined && r.token !== null && r.token !== "") {
    if (typeof r.token !== "string" || !/^[0-9a-fA-F]{32}$/.test(r.token)) fail("token must be 32 hex characters");
    token = (r.token as string).toLowerCase();
  }
  let addedAt = typeof r.addedAt === "string" ? r.addedAt : "";
  if (Number.isNaN(Date.parse(addedAt))) addedAt = new Date(0).toISOString();
  const rec: DeviceRecord = {
    id: r.id as string,
    kind: r.kind as DeviceKind,
    protocol: r.protocol as Protocol,
    name: parseName(r.name),
    origin: r.origin as "discovered" | "manual",
    addedAt,
  };
  const room = parseRoom(r.room);
  if (room) rec.room = room;
  if (host) rec.host = host;
  const model = text(r.model, "model", 80, false);
  if (model) rec.model = model;
  const did = text(r.did, "did", 80, false);
  if (did) rec.did = did;
  if (token) rec.token = token;
  return rec;
}

export function parseDevices(input: unknown): DeviceRecord[] {
  if (!Array.isArray(input)) throw new DeviceError("devices must be a list");
  if (input.length > MAX_DEVICES) throw new DeviceError(`at most ${MAX_DEVICES} devices`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const rec = parseDevice(raw, `device ${i + 1}`);
    if (seen.has(rec.id)) throw new DeviceError(`device ${i + 1}: duplicate id "${rec.id}"`);
    seen.add(rec.id);
    return rec;
  });
}

export const newDeviceId = (): string => `dev-${randomBytes(4).toString("hex")}`;

export function viewOf(d: DeviceRecord): DeviceView {
  const { token, ...rest } = d;
  return { ...rest, hasToken: token !== undefined, editable: true };
}

/**
 * The devices that are still configured in .env (the camera, the lamp, the vacuum, the TV), shown in the same list.
 * They are not copied into the file: .env stays their one source until their drivers read the registry.
 */
export function envDevices(cfg: Pick<Config, "lightIp" | "stream">, env: NodeJS.ProcessEnv = process.env, camera: { host?: string; did?: string } = {}): DeviceView[] {
  const base = { addedAt: new Date(0).toISOString(), origin: "env" as const, editable: false };
  const list: DeviceView[] = [{ ...base, id: "env-camera", kind: "camera", protocol: "go2rtc", name: "Camera", model: cfg.stream, hasToken: false, ...(camera.host && { host: camera.host }), ...(camera.did && { did: camera.did }) }];
  if (cfg.lightIp) list.push({ ...base, id: "env-light", kind: "light", protocol: "cozylife", name: "Lamp", host: cfg.lightIp, hasToken: false });
  const vacuumIp = env.VACUUM_IP?.trim();
  if (vacuumIp) list.push({ ...base, id: "env-vacuum", kind: "vacuum", protocol: "miio", name: "Vacuum", host: vacuumIp, hasToken: !!env.VACUUM_TOKEN });
  const tvIp = env.TV_IP?.trim();
  if (tvIp) list.push({ ...base, id: "env-tv", kind: "tv", protocol: "androidtv", name: "TV", host: tvIp, hasToken: false });
  return list;
}

/** The registry on disk (data/devices.json, mode 600: it holds tokens). Writes are one at a time and replace the file whole. */
export class DeviceStore {
  private devices: DeviceRecord[] = [];
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, "devices.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      this.devices = []; // no file yet
      return;
    }
    // A damaged file is a mistake worth knowing about: do not silently start over and overwrite it later.
    this.devices = parseDevices((JSON.parse(raw) as { devices?: unknown }).devices);
  }

  list(): DeviceRecord[] {
    return this.devices;
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.find((d) => d.id === id);
  }

  /** Is there a stored device with this address or this own id? */
  find(match: { host?: string; did?: string }): DeviceRecord | undefined {
    return this.devices.find((d) => (match.did !== undefined && d.did === match.did) || (match.host !== undefined && d.host === match.host));
  }

  /**
   * Changes the list and writes it. The change is worked out when its turn comes, from the list as the previous change left it:
   * two adds at once both land. `change` may throw (nothing is written) or return the new list and the answer.
   */
  private mutate<T>(change: (current: DeviceRecord[]) => { next: DeviceRecord[]; result: T }): Promise<T> {
    const run = this.chain.then(async () => {
      const { next, result } = change(this.devices);
      if (next === this.devices) return result; // nothing changed: no write
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ devices: next }, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
      this.devices = next;
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async add(input: Omit<DeviceRecord, "id" | "addedAt"> & { id?: string }): Promise<DeviceRecord> {
    const rec = parseDevice({ ...input, id: input.id ?? newDeviceId(), addedAt: new Date().toISOString() });
    return this.mutate((cur) => {
      if (cur.length >= MAX_DEVICES) throw new DeviceError(`at most ${MAX_DEVICES} devices`);
      if (cur.some((d) => d.id === rec.id)) throw new DeviceError(`id "${rec.id}" is taken`);
      return { next: [...cur, rec], result: rec };
    });
  }

  async update(id: string, patch: { name?: unknown; room?: unknown }): Promise<DeviceRecord | undefined> {
    const name = patch.name !== undefined ? parseName(patch.name) : undefined;
    const room = patch.room !== undefined ? parseRoom(patch.room) : undefined;
    return this.mutate((cur) => {
      const old = cur.find((d) => d.id === id);
      if (!old) return { next: cur, result: undefined };
      const updated: DeviceRecord = { ...old };
      if (name !== undefined) updated.name = name;
      if (patch.room !== undefined) {
        if (room) updated.room = room;
        else delete updated.room;
      }
      return { next: cur.map((d) => (d.id === id ? updated : d)), result: updated };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((cur) => (cur.some((d) => d.id === id) ? { next: cur.filter((d) => d.id !== id), result: true } : { next: cur, result: false }));
  }
}
