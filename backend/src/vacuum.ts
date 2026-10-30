import { MiioDevice, MiioError } from "./miio.js";

export type VacuumAction = "start" | "pause" | "dock" | "find";
export type VacuumMode = "cleaning" | "paused" | "idle" | "returning" | "charging" | "charged" | "error" | "unknown";

export type CleaningMode = "sweeping" | "mopping" | "both";

export interface VacuumState {
  /** 0..100 */
  battery: number;
  mode: VacuumMode;
  /** The robot's own status number, kept for diagnosis. */
  statusCode: number;
  /** Area of the current or last cleaning, in m². Left out when the robot doesn't say. */
  areaM2?: number;
  /** Duration of the current or last cleaning, in minutes. */
  minutes?: number;
  cleaningMode?: CleaningMode;
}

/** Dreame MIoT spec: siid 2 is the robot, siid 3 the battery. */
const ACTIONS: Record<VacuumAction, { siid: number; aiid: number }> = {
  start: { siid: 2, aiid: 1 },
  pause: { siid: 2, aiid: 2 },
  dock: { siid: 3, aiid: 1 },
  /** Makes the robot say "I'm here", to find it under a sofa. */
  find: { siid: 7, aiid: 1 },
};

const MODES: Record<number, VacuumMode> = {
  1: "cleaning",
  2: "idle",
  3: "paused",
  4: "error",
  5: "returning",
  6: "charging",
  7: "cleaning", // mopping
  12: "cleaning", // sweeping and mopping
  13: "charged",
};

/** Checked against the Dreamehome app: 4/23 is the "Cleaning Mode" selector (only "both" = 2 has been seen on the robot so far). */
const CLEANING_MODES: Record<number, CleaningMode> = { 0: "sweeping", 1: "mopping", 2: "both" };
const CLEANING_MODE_VALUE: Record<CleaningMode, number> = { sweeping: 0, mopping: 1, both: 2 };
export const CLEANING_MODE_NAMES = Object.keys(CLEANING_MODE_VALUE) as CleaningMode[];

export const VACUUM_ACTIONS = Object.keys(ACTIONS) as VacuumAction[];

export interface VacuumInfo {
  model: string;
  firmware: string;
}

/** How worn a part is: percent left and, when the robot says so, hours left. */
export interface PartWear {
  percent?: number;
  hoursLeft?: number;
}

export interface VacuumCare {
  mainBrush: PartWear;
  sideBrush: PartWear;
  filter: PartWear;
  /** Everything the robot has cleaned since it was set up. Parts the robot doesn't report are left out. */
  totals: { firstCleanAt?: string; minutes?: number; cleanings?: number; areaM2?: number };
}

/** One finished cleaning, as the cloud keeps it. */
export interface CleaningRecord {
  startedAt: string;
  minutes: number;
  areaM2: number;
}

/**
 * Reads the robot's "cleaning finished" event (MIoT event 4.1) as the cloud stores it: a list of {piid, value}. Checked against
 * real records: piid 8 is the start (unix seconds), 2 the minutes and 3 the area in m². Returns nothing for a record that doesn't
 * look like that, or for an attempt that cleaned nothing.
 */
export function parseCleaningRecord(raw: string): CleaningRecord | undefined {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const num = (piid: number) => {
    const v = (list as Array<{ piid?: number; value?: unknown }>).find((p) => p?.piid === piid)?.value;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  const start = num(8);
  const minutes = num(2);
  const area = num(3);
  if (!start || minutes === undefined || area === undefined || (minutes === 0 && area === 0)) return undefined;
  return { startedAt: new Date(start * 1000).toISOString(), minutes, areaM2: area };
}

export class Vacuum {
  private known?: VacuumInfo;

  constructor(private device: MiioDevice) {}

  private infoRetryAt = 0;

  /** Model and firmware never change, so they are asked for once. After a failure wait a minute before asking again,
   *  so a robot that doesn't answer for it doesn't slow down every status request. */
  async info(): Promise<VacuumInfo | undefined> {
    if (!this.known && Date.now() >= this.infoRetryAt) {
      try {
        const r = (await this.device.call("miIO.info", [])) as { model?: string; fw_ver?: string } | undefined;
        if (r?.model) this.known = { model: r.model, firmware: r.fw_ver ?? "" };
      } catch {
        this.infoRetryAt = Date.now() + 60_000;
      }
    }
    return this.known;
  }

  async state(): Promise<VacuumState> {
    const rows = (await this.device.call("get_properties", [
      { did: "x", siid: 3, piid: 1 }, // battery
      { did: "x", siid: 2, piid: 1 }, // status
      { did: "x", siid: 4, piid: 2 }, // cleaning time, minutes
      { did: "x", siid: 4, piid: 3 }, // cleaned area, m²
      { did: "x", siid: 4, piid: 23 }, // cleaning mode
    ])) as Array<{ siid: number; piid: number; code?: number; value?: number }>;
    const value = (siid: number, piid: number) => {
      const v = rows.find((r) => r.siid === siid && r.piid === piid && r.code === 0)?.value;
      return typeof v === "number" ? v : undefined;
    };
    const battery = value(3, 1);
    const status = value(2, 1);
    if (battery === undefined || status === undefined) throw new MiioError("the vacuum did not report its state");
    const state: VacuumState = { battery: Math.max(0, Math.min(100, battery)), mode: MODES[status] ?? "unknown", statusCode: status };
    // The rest is nice to have: a robot that doesn't answer for it still shows its state.
    const minutes = value(4, 2);
    const area = value(4, 3);
    const cleaning = value(4, 23);
    if (minutes !== undefined) state.minutes = minutes;
    if (area !== undefined) state.areaM2 = area;
    if (cleaning !== undefined && CLEANING_MODES[cleaning]) state.cleaningMode = CLEANING_MODES[cleaning];
    return state;
  }

  /** Brush and filter wear plus lifetime cleaning totals (Dreame MIoT services 9 to 12). Read only. */
  async care(): Promise<VacuumCare> {
    const ids: Array<[number, number]> = [[9, 1], [9, 2], [10, 1], [10, 2], [11, 1], [11, 2], [12, 1], [12, 2], [12, 3], [12, 4]];
    const rows = (await this.device.call(
      "get_properties",
      ids.map(([siid, piid]) => ({ did: "x", siid, piid })),
    )) as Array<{ siid: number; piid: number; code?: number; value?: number }>;
    const value = (siid: number, piid: number) => {
      const v = rows.find((r) => r.siid === siid && r.piid === piid && r.code === 0)?.value;
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const wear = (siid: number, percentPiid: number, hoursPiid: number): PartWear => {
      const percent = value(siid, percentPiid);
      const hours = value(siid, hoursPiid);
      return { ...(percent !== undefined && { percent: Math.min(100, percent) }), ...(hours !== undefined && { hoursLeft: hours }) };
    };
    const first = value(12, 1);
    const totals: VacuumCare["totals"] = {};
    if (first) totals.firstCleanAt = new Date(first * 1000).toISOString();
    const minutes = value(12, 2);
    const cleanings = value(12, 3);
    const area = value(12, 4);
    if (minutes !== undefined) totals.minutes = minutes;
    if (cleanings !== undefined) totals.cleanings = cleanings;
    if (area !== undefined) totals.areaM2 = area;
    const care: VacuumCare = { mainBrush: wear(9, 2, 1), sideBrush: wear(10, 2, 1), filter: wear(11, 1, 2), totals };
    const known = [care.mainBrush, care.sideBrush, care.filter].some((p) => p.percent !== undefined || p.hoursLeft !== undefined) || Object.keys(totals).length > 0;
    if (!known) throw new MiioError("the vacuum did not report its parts");
    return care;
  }

  async run(action: VacuumAction): Promise<void> {
    const a = ACTIONS[action];
    const res = (await this.device.call("action", { did: "x", siid: a.siid, aiid: a.aiid, in: [] })) as { code?: number } | undefined;
    if (res?.code !== undefined && res.code !== 0) throw new MiioError(`the vacuum could not ${action} (code ${res.code})`);
  }

  async setCleaningMode(mode: CleaningMode): Promise<void> {
    const rows = (await this.device.call("set_properties", [{ did: "x", siid: 4, piid: 23, value: CLEANING_MODE_VALUE[mode] }])) as
      | Array<{ code?: number }>
      | undefined;
    if (!rows?.length || rows.some((r) => r.code !== undefined && r.code !== 0)) throw new MiioError(`the vacuum could not switch to ${mode}`);
  }

  /** The cloud file name of the robot's map (property 6/8). Only the name, never the map itself. */
  async mapObjectName(): Promise<string> {
    const rows = (await this.device.call("get_properties", [{ did: "x", siid: 6, piid: 8 }])) as Array<{ code?: number; value?: unknown }> | undefined;
    const row = rows?.[0];
    let name: unknown;
    if (row && (row.code === undefined || row.code === 0)) {
      try {
        name = (JSON.parse(String(row.value)) as { object_name?: unknown }).object_name;
      } catch {
        /* handled below */
      }
    }
    if (typeof name !== "string" || !name) throw new MiioError("the vacuum did not report where its map is");
    return name.split(",")[0]!; // a "name,key" pair means encrypted: the key part is not needed for the file name
  }

  /** Asks the robot to send its current map (a full "I" frame) to the cloud, the way the app does when you open the map. */
  async requestMap(): Promise<void> {
    const res = (await this.device.call("action", { did: "x", siid: 6, aiid: 1, in: [{ piid: 2, value: '{"frame_type":"I"}' }] })) as { code?: number } | undefined;
    if (res?.code !== undefined && res.code !== 0) throw new MiioError("the vacuum would not send its map");
  }
}
