import { createSocket } from "node:dgram";
import { isPrivateIPv4, type DeviceKind, type Protocol } from "./devices.js";
import { HELLO } from "./miio.js";
import { listDevices, type CloudDevice } from "./xiaomiCloud.js";

/** What a scan found. `token` stays on the server: it is only copied into the registry when a candidate is added. */
export interface Candidate {
  /** `protocol:did`, or `protocol:host` when the device has no id of its own. How a candidate is chosen later. */
  key: string;
  protocol: Protocol;
  kind: DeviceKind;
  host?: string;
  name: string;
  model?: string;
  did?: string;
  token?: string;
  /** Did it answer on the network just now (false: it is only known from the Xiaomi account). */
  seen: boolean;
}

export interface ScanOptions {
  /** Where to shout. Tests point it at a fake device on this machine. */
  broadcast?: string;
  port?: number;
  /** How long to listen for answers. */
  timeoutMs?: number;
}

/** Sends `packet` to the broadcast address `repeat` times and collects every answer that `accept` turns into a value, one per address. */
function ask<T>(packet: Buffer, port: number, broadcast: string, timeoutMs: number, accept: (msg: Buffer, from: string) => T | undefined): Promise<Map<string, T>> {
  return new Promise((resolve) => {
    const found = new Map<string, T>();
    const sock = createSocket("udp4");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on("error", finish); // no network, no permission: nothing found
    sock.on("message", (msg, rinfo) => {
      const value = accept(msg, rinfo.address);
      if (value !== undefined) found.set(rinfo.address, value);
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        return finish();
      }
      // One UDP packet can be lost: shout three times.
      for (let i = 0; i < 3; i++) setTimeout(() => !done && sock.send(packet, port, broadcast, (err) => err && finish()), i * 150);
    });
  });
}

/** Xiaomi (miio) devices that answer the "hello" broadcast. The answer carries the device's own id; it needs no token. */
export async function scanMiio(opts: ScanOptions = {}): Promise<Array<{ host: string; did: string }>> {
  const found = await ask(HELLO, opts.port ?? 54321, opts.broadcast ?? "255.255.255.255", opts.timeoutMs ?? 2500, (msg) =>
    msg.length >= 32 && msg.readUInt16BE(0) === 0x2131 ? String(msg.readUInt32BE(8)) : undefined,
  );
  return [...found].map(([host, did]) => ({ host, did }));
}

/** CozyLife devices that answer the UDP broadcast on port 6095 (the same call tools/cozylife-probe.cjs makes). */
export async function scanCozyLife(opts: ScanOptions = {}): Promise<Array<{ host: string; did: string }>> {
  const probe = Buffer.from(JSON.stringify({ cmd: 0, pv: 0, sn: String(Date.now()), msg: {} }));
  const found = await ask(probe, opts.port ?? 6095, opts.broadcast ?? "255.255.255.255", opts.timeoutMs ?? 2500, (msg) => {
    try {
      const r = JSON.parse(msg.toString()) as { cmd?: number; msg?: { did?: unknown } };
      return r.cmd === 0 && typeof r.msg?.did === "string" && r.msg.did ? r.msg.did : undefined;
    } catch {
      return undefined;
    }
  });
  return [...found].map(([host, did]) => ({ host, did }));
}

/** What a Xiaomi model name says about the device: "dreame.vacuum.p2028a" is a vacuum, "chuangmi.camera.029a02" a camera. */
export function kindOfModel(model: string): DeviceKind {
  const type = model.toLowerCase().split(".")[1] ?? ""; // maker.type.code
  if (type.includes("vacuum")) return "vacuum";
  if (type.includes("camera")) return "camera";
  if (["light", "bulb", "lamp"].some((t) => type.includes(t))) return "light";
  if (type === "tv" || type === "tvbox") return "tv";
  if (["plug", "switch", "outlet"].some((t) => type.includes(t))) return "plug";
  return "other";
}

export type CloudStatus = "ok" | "not-signed-in" | "unavailable";

export interface DiscoverDeps {
  miio: () => Promise<Array<{ host: string; did: string }>>;
  cozylife: () => Promise<Array<{ host: string; did: string }>>;
  /** The Xiaomi account's device list (names, models and tokens). Throws when not signed in. */
  cloud: () => Promise<CloudDevice[]>;
}

export interface DiscoverResult {
  candidates: Candidate[];
  cloud: CloudStatus;
  /** Why the cloud list is missing, in words. */
  cloudMessage?: string;
}

/**
 * Looks for devices: asks the network (Xiaomi and CozyLife answer a broadcast) and joins the answers with the Xiaomi account's list,
 * which knows each device's name, model and token. A device that is only in the account (asleep, or in another room) is listed
 * with `seen: false` if the account knows its address.
 */
export async function discover(deps: DiscoverDeps): Promise<DiscoverResult> {
  const [miio, cozy, cloudResult] = await Promise.all([
    deps.miio().catch(() => []),
    deps.cozylife().catch(() => []),
    deps
      .cloud()
      .then((list) => ({ list, status: "ok" as CloudStatus, message: undefined as string | undefined }))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        return { list: [] as CloudDevice[], status: (/not signed in/i.test(message) ? "not-signed-in" : "unavailable") as CloudStatus, message };
      }),
  ]);

  const byDid = new Map(cloudResult.list.map((d) => [d.did, d]));
  const candidates = new Map<string, Candidate>();

  for (const { host, did } of miio) {
    if (!isPrivateIPv4(host)) continue;
    const c = byDid.get(did);
    candidates.set(`miio:${did}`, {
      key: `miio:${did}`,
      protocol: "miio",
      kind: c ? kindOfModel(c.model) : "other",
      host,
      name: c?.name || `Xiaomi ${did.slice(-4)}`,
      ...(c && { model: c.model, token: c.token }),
      did,
      seen: true,
    });
  }
  for (const c of cloudResult.list) {
    const key = `miio:${c.did}`;
    if (candidates.has(key) || !c.localip || !isPrivateIPv4(c.localip)) continue;
    candidates.set(key, { key, protocol: "miio", kind: kindOfModel(c.model), host: c.localip, name: c.name || c.model, model: c.model, token: c.token, did: c.did, seen: false });
  }
  for (const { host, did } of cozy) {
    if (!isPrivateIPv4(host)) continue;
    const key = `cozylife:${did}`;
    candidates.set(key, { key, protocol: "cozylife", kind: "light", host, name: `CozyLife ${did.slice(-4)}`, did, seen: true });
  }

  return { candidates: [...candidates.values()], cloud: cloudResult.status, ...(cloudResult.message && { cloudMessage: cloudResult.message }) };
}

/** The real scanners and the real account list. */
export function realDeps(dataDir: string, env: NodeJS.ProcessEnv = process.env): DiscoverDeps {
  return { miio: () => scanMiio(), cozylife: () => scanCozyLife(), cloud: () => listDevices(dataDir, env) };
}
