import type { FastifyInstance } from "fastify";
import { DownMemo } from "./breaker.js";
import { HttpError } from "./go2rtc.js";
import { CozyLight, LightError } from "./light.js";

/** What the web app sees for one lamp. */
export interface LampView {
  id: LampId;
  name: string;
  kind: "wifi" | "bluetooth";
  reachable: boolean;
  /** false when the lamp cannot report its state (Bluetooth strips are write-only). */
  stateKnown: boolean;
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
}

export type LampId = "wifi" | "ble";
export interface LampPatch {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Hue 0..360 and saturation 0..100 at full value, as rrggbb (brightness is sent separately). */
export function hsToHex(hue: number, saturation: number): string {
  const s = clamp(saturation, 0, 100) / 100;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const sectors: Array<[number, number, number]> = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]];
  const [r, g, b] = sectors[Math.min(5, Math.floor(h))] ?? [1, 0, 0];
  const ch = (v: number) =>
    Math.round((v * s + (1 - s)) * 255)
      .toString(16)
      .padStart(2, "0");
  return ch(r) + ch(g) + ch(b);
}

/**
 * Client for tools/ble_helper.py, a small local program that holds the Bluetooth connection.
 * The strip cannot say what it is doing, so the last values we sent stand in for its state.
 */
export class BleLamp {
  private last = { on: false, brightness: 100, hue: 30, saturation: 100 };
  private touched = false;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  /** A strip the helper could not find (or a helper that is not running) is not asked again for a few seconds: each try takes seconds. */
  private readonly down = new DownMemo(10_000);
  private downReason = "";

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    if (this.down.isDown) throw new LightError(this.downReason);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000), // a cold Bluetooth connect can take a few seconds
      });
    } catch {
      this.downReason = "Bluetooth helper is not running (./camera.sh starts it from Terminal.app)";
      this.down.fail();
      throw new LightError(this.downReason);
    }
    if (!res.ok) {
      const detail = await res.json().then((j: { error?: string }) => j.error, () => undefined);
      const reason = detail ?? `Bluetooth helper answered ${res.status}`;
      if (res.status >= 500) {
        this.downReason = reason;
        this.down.fail();
      }
      throw new LightError(reason);
    }
    this.down.ok();
    return res.json();
  }

  async view(): Promise<Omit<LampView, "id" | "name" | "kind">> {
    try {
      await this.call("/state");
    } catch {
      return { reachable: false, stateKnown: false };
    }
    return { reachable: true, stateKnown: this.touched, ...this.last };
  }

  async set(patch: LampPatch): Promise<void> {
    const next = { ...this.last, ...patch };
    const body: { on?: boolean; color?: string; brightness?: number } = {};
    if (patch.hue !== undefined || patch.saturation !== undefined) {
      body.color = hsToHex(next.hue, next.saturation);
      if (!this.last.on && patch.on === undefined) next.on = true; // a colour command lights the strip
    }
    if (patch.brightness !== undefined) body.brightness = clamp(patch.brightness, 0, 100);
    if (patch.on !== undefined || next.on !== this.last.on) body.on = next.on;
    await this.call("/light", { method: "POST", body: JSON.stringify(body) });
    this.last = next;
    this.touched = true;
  }
}

/** How often a lamp that is down is tried again. */
const PROBE_EVERY_MS = 10_000;

export interface LightsDeps {
  cozy?: CozyLight;
  env?: NodeJS.ProcessEnv;
}

/** One place for every lamp: GET /api/lights and POST /api/lights/:id. */
export function registerLights(app: FastifyInstance, { cozy, env = process.env }: LightsDeps): void {
  const token = env.BLE_HELPER_TOKEN ?? "";
  const ble =
    token.length >= 16 ? new BleLamp(`http://127.0.0.1:${Number(env.BLE_HELPER_PORT ?? 3200)}`, token) : undefined;

  // A lamp that does not answer must not slow the list down: while it is down, answer "unreachable" at once
  // and look again in the background (at most one probe at a time, no more often than every PROBE_EVERY_MS).
  let cozyDown = false;
  let cozyProbedAt = 0;
  let cozyProbing = false;
  const probeCozy = () => {
    if (!cozy || cozyProbing) return;
    cozyProbing = true;
    cozyProbedAt = Date.now();
    cozy
      .state()
      .then(() => void (cozyDown = false), () => void (cozyDown = true))
      .finally(() => void (cozyProbing = false));
  };

  const wifiView = async (): Promise<LampView> => {
    const down: LampView = { id: "wifi", name: "Wi-Fi strip", kind: "wifi", reachable: false, stateKnown: false };
    if (cozyDown) {
      if (Date.now() - cozyProbedAt >= PROBE_EVERY_MS) probeCozy();
      return down;
    }
    try {
      return { id: "wifi", name: "Wi-Fi strip", kind: "wifi", reachable: true, stateKnown: true, ...(await cozy!.state()) };
    } catch {
      cozyDown = true;
      cozyProbedAt = Date.now();
      return down;
    }
  };

  app.get("/api/lights", async () => {
    // Both lamps are asked at the same time, so the slower one does not add to the other.
    const views = await Promise.all([cozy ? wifiView() : undefined, ble ? ble.view().then((v): LampView => ({ id: "ble", name: "Bluetooth strip", kind: "bluetooth", ...v })) : undefined]);
    return { lights: views.filter((v): v is LampView => v !== undefined) };
  });

  app.post<{ Params: { id: string }; Body: LampPatch }>(
    "/api/lights/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            on: { type: "boolean" },
            brightness: { type: "integer", minimum: 0, maximum: 100 },
            hue: { type: "integer", minimum: 0, maximum: 360 },
            saturation: { type: "integer", minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      try {
        if (id === "wifi") {
          if (!cozy) throw new HttpError(404, "Wi-Fi strip is not configured (set LIGHT_IP)");
          await cozy.set(req.body);
          cozyDown = false;
        } else if (id === "ble") {
          if (!ble) throw new HttpError(404, "Bluetooth strip is not configured (./camera.sh ble-setup)");
          await ble.set(req.body);
        } else {
          throw new HttpError(404, "unknown lamp");
        }
      } catch (e) {
        if (e instanceof LightError) throw new HttpError(502, e.message);
        throw e;
      }
      return { ok: true };
    },
  );
}
