import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Something went wrong talking to the Xiaomi cloud. `needsLogin` means: sign in again with tools/xiaomi-cloud.ts. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly needsLogin = false,
  ) {
    super(message);
  }
}

/** The cloud gave a link but the file is not there (or the server refused it): worth trying another region. */
class DownloadFailed extends CloudError {}

/** The keys of one Xiaomi sign-in. Lives in backend/data/xiaomi-session.json (mode 600) and never leaves this machine. */
export type CloudSession = { serviceToken: string; ssecurity: string; userId: string; clientId: string; region?: string };

export const REGIONS = ["de", "sg", "us", "ru", "i2", "cn"];
const SESSION_FILE = "xiaomi-session.json";

export const sessionPath = (dataDir: string) => join(dataDir, SESSION_FILE);

export function loadSession(dataDir: string): CloudSession | undefined {
  const file = sessionPath(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<CloudSession>;
    if (typeof s.serviceToken === "string" && typeof s.ssecurity === "string" && typeof s.userId === "string" && typeof s.clientId === "string") {
      return { serviceToken: s.serviceToken, ssecurity: s.ssecurity, userId: s.userId, clientId: s.clientId, region: typeof s.region === "string" ? s.region : undefined };
    }
  } catch {
    /* a damaged file is the same as no session */
  }
  return undefined;
}

export function saveSession(dataDir: string, session: CloudSession): void {
  mkdirSync(dataDir, { recursive: true });
  const file = sessionPath(dataDir);
  writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const userAgent = (clientId: string) => `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${clientId} APP/xiaomi.smarthome APPV/62830`;

// ---------- RC4 (Node's OpenSSL has it disabled, so it is written out) ----------
export function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  let a = 0;
  let b = 0;
  const step = () => {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    return s[(s[a]! + s[b]!) & 255]!;
  };
  for (let i = 0; i < 1024; i++) step(); // the cloud throws away the first 1024 bytes of key stream
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ step();
  return out;
}

// ---------- request signing ----------
export function signedNonce(ssecurity: string, nonce: string): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")])).digest("base64");
}
export function makeNonce(): string {
  const minutes = Math.floor(Date.now() / 60000);
  const hex = minutes.toString(16);
  return Buffer.concat([randomBytes(8), Buffer.from(hex.padStart(Math.ceil(hex.length / 2) * 2, "0"), "hex")]).toString("base64");
}
export function encSignature(method: string, apiPath: string, signed: string, params: Record<string, string>): string {
  const parts = [method.toUpperCase(), `/${apiPath}`, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), signed];
  return createHash("sha1").update(parts.join("&")).digest("base64");
}

/** Where the cloud lives. XIAOMI_CLOUD_BASE may point at a loopback address, so tests can use a pretend cloud. */
export function apiBase(region: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.XIAOMI_CLOUD_BASE;
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return override.replace(/\/$/, "");
    } catch {
      /* not a URL: ignore it */
    }
  }
  return `https://${region === "cn" ? "" : region + "."}api.io.mi.com/app`;
}

/** One signed, encrypted call. Returns the decoded JSON answer, or null when the cloud refused or the answer was unreadable. */
export async function cloudCall(s: CloudSession, region: string, apiPath: string, payload: unknown, env: NodeJS.ProcessEnv = process.env): Promise<any> {
  const nonce = makeNonce();
  const signed = signedNonce(s.ssecurity, nonce);
  const key = Buffer.from(signed, "base64");
  const params: Record<string, string> = { data: JSON.stringify(payload) };
  params.rc4_hash__ = encSignature("POST", apiPath, signed, params);
  for (const k of Object.keys(params)) params[k] = rc4(key, Buffer.from(params[k]!)).toString("base64");
  params.signature = encSignature("POST", apiPath, signed, params);
  params.ssecurity = s.ssecurity;
  params._nonce = nonce;

  const res = await fetch(`${apiBase(region, env)}/${apiPath}`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent(s.clientId),
      "Accept-Encoding": "identity",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "content-type": "application/x-www-form-urlencoded",
      "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      Cookie: [`userId=${s.userId}`, `yetAnotherServiceToken=${s.serviceToken}`, `serviceToken=${s.serviceToken}`, "locale=en_US", "channel=MI_APP_STORE"].join("; "),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(rc4(key, Buffer.from(await res.text(), "base64")).toString("utf8"));
  } catch {
    return null;
  }
}

/** The real cloud hands out https links; plain http is accepted only when the cloud itself is the loopback test cloud. */
export function isFollowable(url: string, base: string): boolean {
  return url.startsWith("https://") || (url.startsWith("http://") && base.startsWith("http://"));
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // a map is a few kilobytes; anything near this is not a map
const OVERALL_LIMIT_MS = 25_000;

/** Downloads a robot file (the map) from the cloud by the object name the robot reports. Returns its text. */
export async function downloadCloudFile(dataDir: string, objectName: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await downloadCloudBytes(dataDir, objectName, env)).toString("utf8");
}

/** The same, as raw bytes (for archives). */
export async function downloadCloudBytes(dataDir: string, objectName: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  const session = loadSession(dataDir);
  if (!session) throw new CloudError("not signed in to Xiaomi yet: run tools/xiaomi-cloud.ts login", true);

  const giveUpAt = Date.now() + OVERALL_LIMIT_MS;
  let lastFailure: DownloadFailed | undefined;
  const regions = session.region ? [session.region, ...REGIONS.filter((r) => r !== session.region)] : REGIONS;
  for (const region of regions) {
    for (const apiPath of ["v2/home/get_interim_file_url_pro", "v2/home/get_interim_file_url", "home/getfileurl_v3", "home/getfileurl"]) {
      if (Date.now() > giveUpAt) throw new CloudError("the Xiaomi cloud took too long to answer");
      let answer: any;
      try {
        answer = await cloudCall(session, region, apiPath, { obj_name: objectName }, env);
      } catch {
        continue; // an unreachable region is not fatal, try the next one
      }
      const url = answer?.result?.url;
      if (typeof url !== "string") continue;
      // the real cloud hands out https links; plain http is accepted only for the loopback test cloud
      if (!isFollowable(url, apiBase(region, env))) throw new CloudError("the cloud gave a download link I won't follow");
      // Every region hands out a link, also for a file it doesn't have: the link of the wrong one is a 404. So the region is
      // only remembered once the download worked, and a dead link means "try the next region", not "give up".
      try {
        const bytes = await fetchBytes(url);
        if (session.region !== region) saveSession(dataDir, { ...session, region });
        return bytes;
      } catch (e) {
        if (!(e instanceof DownloadFailed)) throw e;
        lastFailure = e;
        break; // the other paths of this region would give the same link
      }
    }
  }
  if (lastFailure) throw lastFailure;
  throw new CloudError("the cloud did not give a download link: the Xiaomi session may have expired, run tools/xiaomi-cloud.ts login again", true);
}

async function fetchBytes(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new CloudError("could not download the map file from the Xiaomi cloud");
  }
  if (!res.ok) throw new DownloadFailed(`the map download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) throw new CloudError("the map file is too big to be a map");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_FILE_BYTES) throw new CloudError("the map file is too big to be a map");
  return body;
}

/** Splits a robot file name "uid/did/slot" into the ids the cloud wants for per-device data. */
export function idsFromObjectName(objectName: string): { uid: string; did: string } | undefined {
  const [uid, did] = objectName.split("/");
  return uid && did && /^\d+$/.test(uid) && /^\d+$/.test(did) ? { uid, did } : undefined;
}

export type CloudRow = { time: number; value: string };

/** The latest values the robot has reported to the cloud for one property key such as "6.1" (siid.piid), newest first. */
export async function deviceData(dataDir: string, ids: { uid: string; did: string }, key: string, limit = 20, env: NodeJS.ProcessEnv = process.env, type = "prop"): Promise<CloudRow[]> {
  const session = loadSession(dataDir);
  if (!session) throw new CloudError("not signed in to Xiaomi yet: run tools/xiaomi-cloud.ts login", true);
  let answer: any;
  try {
    answer = await cloudCall(session, session.region ?? REGIONS[0]!, "user/get_user_device_data", { uid: ids.uid, did: ids.did, time_end: 9999999999, time_start: 0, limit, key, type }, env);
  } catch {
    throw new CloudError("could not reach the Xiaomi cloud");
  }
  if (!answer) throw new CloudError("the Xiaomi cloud refused the request: the session may have expired, run tools/xiaomi-cloud.ts login again", true);
  const rows: unknown = answer.result;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is { time: number | string; value: string } => typeof r?.value === "string" && r.time !== undefined)
    .map((r) => ({ time: Number(r.time), value: r.value }));
}

/** A device of the Xiaomi account, as the cloud lists it. `token` is the key for the local miio protocol: never print it. */
export type CloudDevice = { did: string; name: string; model: string; localip?: string; token: string; isOnline: boolean; region: string };

/**
 * Every device of the signed-in account, from all the cloud regions (a device lives in the region it was added in, and a region
 * that doesn't know it answers with an empty list). The same device is listed once.
 */
export async function listDevices(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<CloudDevice[]> {
  const session = loadSession(dataDir);
  if (!session) throw new CloudError("not signed in to Xiaomi yet: run tools/xiaomi-cloud.ts login", true);
  const regions = session.region ? [session.region, ...REGIONS.filter((r) => r !== session.region)] : REGIONS;
  const found = new Map<string, CloudDevice>();
  let anyAnswer = false;
  for (const region of regions) {
    for (const [apiPath, payload] of [
      ["home/device_list", { getVirtualModel: false, getHuamiDevices: 0 }],
      ["v2/home/device_list_page", { get_split_device: false, support_smart_home: true, get_cariot_device: true, get_third_device: true, limit: 200 }],
    ] as const) {
      let answer: any;
      try {
        answer = await cloudCall(session, region, apiPath, payload, env);
      } catch {
        continue; // an unreachable region is not fatal
      }
      if (answer) anyAnswer = true;
      const list: unknown = answer?.result?.list ?? answer?.result?.device_info;
      if (!Array.isArray(list) || !list.length) continue;
      for (const d of list as Array<Record<string, unknown>>) {
        if (typeof d.did !== "string" || typeof d.token !== "string" || typeof d.model !== "string") continue;
        if (!found.has(d.did)) {
          found.set(d.did, { did: d.did, name: String(d.name ?? ""), model: d.model, localip: typeof d.localip === "string" ? d.localip : undefined, token: d.token, isOnline: d.isOnline === true, region });
        }
      }
      break; // this region answered with devices: the second kind of list is not needed
    }
  }
  if (!anyAnswer) throw new CloudError("the Xiaomi cloud refused the request: the session may have expired, run tools/xiaomi-cloud.ts login again", true);
  return [...found.values()];
}
