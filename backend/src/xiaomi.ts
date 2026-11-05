import type { Config } from "./config.js";
import { HttpError } from "./go2rtc.js";

/** Mi Home cloud regions that go2rtc understands. */
export const REGIONS = ["cn", "de", "i2", "ru", "sg", "us"] as const;
export type Region = (typeof REGIONS)[number];

const ACCOUNT = /^\d{1,20}$/;
const DID = /^[\w.-]{1,64}$/;
/** A go2rtc stream name; also the name of the entry written to go2rtc.yaml. */
export const CAMERA_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Logging in can take several round trips to the Xiaomi cloud. */
const LOGIN_TIMEOUT_MS = 30_000;
const TIMEOUT_MS = 15_000;

export type LoginInput = { username: string; password: string } | { captcha: string } | { verify: string };

/** `captcha` and `verify` mean Mi Home wants one more step before it lets the account in. */
export type LoginResult = { status: "ok" } | { status: "captcha"; image: string } | { status: "verify"; target: string };

export interface Device {
  did: string;
  name: string;
  model: string;
  ip: string;
}

interface Source {
  name?: string;
  info?: string;
  url?: string;
}

/** The camera that is already used by the app cannot be replaced by accident. */
export interface CameraStream {
  name: string;
  active: boolean;
}

/**
 * Mi Home sign-in and camera discovery on top of go2rtc's own Xiaomi module.
 *
 * go2rtc keeps the account token (in go2rtc.yaml) and builds the `xiaomi://` source for a device. This class never
 * lets the browser choose a source: a go2rtc stream source can also be `exec:`, which runs a command, so the browser
 * only names a device (`did`) and the source is taken from what go2rtc itself listed for that account.
 */
export class XiaomiSetup {
  constructor(private cfg: Config) {}

  private async call(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
    try {
      return await fetch(`${this.cfg.go2rtcUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new HttpError(502, "go2rtc is unreachable");
    }
  }

  /** Ids of the Mi Home accounts go2rtc is already signed in to. */
  async accounts(): Promise<string[]> {
    const res = await this.call("/api/xiaomi");
    if (!res.ok) throw new HttpError(502, `go2rtc has no Xiaomi support (${res.status})`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body.filter((a): a is string => typeof a === "string") : [];
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const form = new URLSearchParams(input);
    const res = await this.call("/api/xiaomi", { method: "POST", body: form }, LOGIN_TIMEOUT_MS);
    if (res.ok) return { status: "ok" };

    if (res.status === 401) {
      const e = (await res.json().catch(() => ({}))) as { captcha?: string; verify_email?: string; verify_phone?: string };
      if (e.captcha) return { status: "captcha", image: e.captcha };
      const target = e.verify_email || e.verify_phone;
      if (target) return { status: "verify", target };
    }
    // go2rtc answers with the cloud's own wording ("wrong password" and the like); keep it short for the screen.
    const text = (await res.text().catch(() => "")).trim().slice(0, 200);
    throw new HttpError(res.status === 401 ? 400 : 502, text || "Mi Home refused the sign-in");
  }

  /** Cameras of an account in one region, as go2rtc lists them. `src` never leaves this class. */
  private async sources(account: string, region: Region): Promise<Array<Device & { src: string }>> {
    if (!ACCOUNT.test(account)) throw new HttpError(400, "bad account id");
    if (!(REGIONS as readonly string[]).includes(region)) throw new HttpError(400, "bad region");
    const q = new URLSearchParams({ id: account, region });
    const res = await this.call(`/api/xiaomi?${q}`, {}, LOGIN_TIMEOUT_MS);
    // go2rtc answers 404 "no sources" when the account has no camera in that region
    if (res.status === 404) return [];
    if (!res.ok) throw new HttpError(502, (await res.text().catch(() => "")).trim().slice(0, 200) || `Mi Home answered ${res.status}`);
    const body = (await res.json()) as { sources?: Source[] };
    const out: Array<Device & { src: string }> = [];
    for (const s of body.sources ?? []) {
      const src = s.url ?? "";
      if (!src.startsWith("xiaomi://")) continue;
      const params = new URLSearchParams(src.split("?")[1] ?? "");
      const did = params.get("did") ?? "";
      if (!DID.test(did)) continue;
      out.push({
        did,
        name: s.name ?? "Camera",
        model: params.get("model") ?? "",
        ip: /@([^?]*)\?/.exec(src)?.[1] ?? "",
        src,
      });
    }
    return out;
  }

  async devices(account: string, region: Region): Promise<Device[]> {
    return (await this.sources(account, region)).map(({ src: _src, ...d }) => d);
  }

  /**
   * The address (and own id, when go2rtc still lists the source) of the camera behind the main stream. Only these facts leave:
   * a source carries the account token. A running stream lists the camera's `remote_addr` instead of its source; a stream that is
   * not connected lists the `xiaomi://` source. Best effort: an empty answer when go2rtc is down or the stream is not a camera.
   */
  async cameraIdentity(): Promise<{ host?: string; did?: string }> {
    try {
      const res = await this.call("/api/streams", {}, 1500);
      if (!res.ok) return {};
      const body = (await res.json()) as Record<string, { producers?: Array<{ url?: string; remote_addr?: string }> } | undefined>;
      const producers = body[this.cfg.stream]?.producers ?? [];
      const url = producers.find((p) => p.url?.startsWith("xiaomi://"))?.url ?? "";
      const host = /@([^?:/]+)(?:[?:/]|$)/.exec(url)?.[1] ?? producers.map((p) => /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(p.remote_addr ?? "")?.[1]).find(Boolean);
      const did = new URLSearchParams(url.split("?")[1] ?? "").get("did") ?? undefined;
      return { ...(host && { host }), ...(did && DID.test(did) && { did }) };
    } catch {
      return {};
    }
  }

  /** Names of the streams go2rtc has, never their sources (those carry tokens). */
  async streams(): Promise<CameraStream[]> {
    const res = await this.call("/api/streams");
    if (!res.ok) throw new HttpError(502, `go2rtc answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    return Object.keys(body)
      .sort()
      .map((name) => ({ name, active: name === this.cfg.stream }));
  }

  /** Adds the camera to go2rtc (live, and saved in go2rtc.yaml). An existing stream is never overwritten. */
  async add(input: { account: string; region: Region; did: string; name: string }): Promise<CameraStream> {
    if (!CAMERA_NAME.test(input.name)) throw new HttpError(400, "name: use lowercase letters, digits, - and _ (up to 40)");
    if (!DID.test(input.did)) throw new HttpError(400, "bad device id");
    if ((await this.streams()).some((s) => s.name === input.name)) {
      throw new HttpError(409, `a camera named "${input.name}" already exists`);
    }
    const device = (await this.sources(input.account, input.region)).find((d) => d.did === input.did);
    if (!device) throw new HttpError(404, "that camera is not in this account and region");

    const q = new URLSearchParams({ name: input.name, src: device.src });
    const res = await this.call(`/api/streams?${q}`, { method: "PUT" });
    if (!res.ok) throw new HttpError(502, (await res.text().catch(() => "")).trim().slice(0, 200) || `go2rtc answered ${res.status}`);
    return { name: input.name, active: input.name === this.cfg.stream };
  }
}
