import { MiioDevice, MiioError } from "./miio.js";
import { describeFault, type VacuumFault } from "./vacuumErrors.js";

export type VacuumAction = "start" | "pause" | "dock" | "find" | "empty";
export type VacuumMode = "cleaning" | "paused" | "idle" | "returning" | "charging" | "charged" | "emptying" | "updating" | "error" | "unknown";

export type CleaningMode = "sweeping" | "mopping" | "both";
export type SuctionLevel = "quiet" | "standard" | "strong" | "turbo";
export type WaterLevel = "low" | "medium" | "high";

export interface VacuumState {
  /** 0..100 */
  battery: number;
  mode: VacuumMode;
  /** The robot's own status number, kept for diagnosis. */
  statusCode: number;
  /** What is wrong, when the robot reports a fault. */
  fault?: VacuumFault;
  /** Area of the current or last cleaning, in m². Left out when the robot doesn't say. */
  areaM2?: number;
  /** Duration of the current or last cleaning, in minutes. */
  minutes?: number;
  cleaningMode?: CleaningMode;
  suction?: SuctionLevel;
  water?: WaterLevel;
  /** The self-emptying dock. `ready`: the robot sits on it and it can empty the bin now. Left out when the robot doesn't report a dock. */
  dustStation?: { autoEmpty: boolean; ready: boolean; emptying: boolean; /** the dock refuses: it was emptied too often */ limited: boolean };
}

/** Dreame MIoT spec: siid 2 is the robot, siid 3 the battery. */
const ACTIONS: Record<VacuumAction, { siid: number; aiid: number }> = {
  start: { siid: 2, aiid: 1 },
  pause: { siid: 2, aiid: 2 },
  dock: { siid: 3, aiid: 1 },
  /** Makes the robot say "I'm here", to find it under a sofa. */
  find: { siid: 7, aiid: 1 },
  /** Makes the dock suck the dust out of the robot's bin. Only does anything while the robot sits on the dock. */
  empty: { siid: 15, aiid: 1 },
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
  14: "updating",
  22: "emptying", // the dock is sucking the bin empty
  28: "emptying", // on its way to the dock to be emptied
  34: "emptying",
};

/** Checked against the Dreamehome app: 4/23 is the "Cleaning Mode" selector (only "both" = 2 has been seen on the robot so far). */
const CLEANING_MODES: Record<number, CleaningMode> = { 0: "sweeping", 1: "mopping", 2: "both" };
const CLEANING_MODE_VALUE: Record<CleaningMode, number> = { sweeping: 0, mopping: 1, both: 2 };
export const CLEANING_MODE_NAMES = Object.keys(CLEANING_MODE_VALUE) as CleaningMode[];

/** Dreame MIoT 4/4 and 4/5. With "Customized Cleaning" on in the app the robot keeps these per room and ignores the general ones. */
const SUCTION_VALUE: Record<SuctionLevel, number> = { quiet: 0, standard: 1, strong: 2, turbo: 3 };
const WATER_VALUE: Record<WaterLevel, number> = { low: 1, medium: 2, high: 3 };
export const SUCTION_NAMES = Object.keys(SUCTION_VALUE) as SuctionLevel[];
export const WATER_NAMES = Object.keys(WATER_VALUE) as WaterLevel[];
const nameOf = <T extends string>(table: Record<T, number>, value: number | undefined): T | undefined => (Object.keys(table) as T[]).find((k) => table[k] === value);

export const VACUUM_ACTIONS = Object.keys(ACTIONS) as VacuumAction[];

/** Wear counters the robot lets you reset after changing a part or cleaning the sensors (MIoT actions 9/1, 10/1, 11/1, 16/1). */
const PART_RESETS = { mainBrush: { siid: 9, aiid: 1 }, sideBrush: { siid: 10, aiid: 1 }, filter: { siid: 11, aiid: 1 }, sensor: { siid: 16, aiid: 1 } } as const;
export type VacuumPart = keyof typeof PART_RESETS;
export const VACUUM_PARTS = Object.keys(PART_RESETS) as VacuumPart[];

/** The robot's on/off settings. "Do not disturb" is a real boolean on the robot, the rest are 1 and 0. */
const SWITCHES = {
  resumeCleaning: { siid: 4, piid: 11 },
  carpetBoost: { siid: 4, piid: 12 },
  obstacleAvoidance: { siid: 4, piid: 21 },
  childLock: { siid: 4, piid: 27 },
  dnd: { siid: 5, piid: 1, boolean: true },
} as const;
export type SettingName = keyof typeof SWITCHES;
export const SETTING_NAMES = Object.keys(SWITCHES) as SettingName[];

/** MIoT 4/28. */
const CARPET_SENSITIVITY_VALUE = { low: 1, medium: 2, high: 3 } as const;

export interface VacuumSettings {
  resumeCleaning?: boolean;
  carpetBoost?: boolean;
  obstacleAvoidance?: boolean;
  /** Read only: with it on, the robot keeps suction and water per room (see the note on suction and water). */
  customizedCleaning?: boolean;
  childLock?: boolean;
  carpetSensitivity?: keyof typeof CARPET_SENSITIVITY_VALUE;
  /** "Do not disturb": the robot stays quiet and the dock doesn't empty the bin in these hours. */
  dnd?: { enabled: boolean; from?: string; to?: string };
  /** 0..100 */
  volume?: number;
  /** The dock's auto-empty frequency as the robot numbers it. */
  autoEmptyFrequency?: number;
}

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
  /** How long until the sensors need wiping. Left out when the robot doesn't say. */
  sensor?: PartWear;
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
      { did: "x", siid: 2, piid: 2 }, // fault code, 0 = none
      { did: "x", siid: 4, piid: 2 }, // cleaning time, minutes
      { did: "x", siid: 4, piid: 3 }, // cleaned area, m²
      { did: "x", siid: 4, piid: 23 }, // cleaning mode
      { did: "x", siid: 4, piid: 4 }, // suction
      { did: "x", siid: 4, piid: 5 }, // water
      { did: "x", siid: 15, piid: 1 }, // dock: empties the bin by itself after a cleaning (1 = on)
      { did: "x", siid: 15, piid: 3 }, // dock: 1 when the robot is on it and it can empty the bin now
      { did: "x", siid: 15, piid: 5 }, // dock: 0 idle, 1 emptying right now, 2 not done (do-not-disturb)
    ])) as Array<{ siid: number; piid: number; code?: number; value?: number }>;
    const value = (siid: number, piid: number) => {
      const v = rows.find((r) => r.siid === siid && r.piid === piid && r.code === 0)?.value;
      return typeof v === "number" ? v : undefined;
    };
    const battery = value(3, 1);
    const status = value(2, 1);
    if (battery === undefined || status === undefined) throw new MiioError("the vacuum did not report its state");
    const state: VacuumState = { battery: Math.max(0, Math.min(100, battery)), mode: MODES[status] ?? "unknown", statusCode: status };
    const fault = describeFault(value(2, 2) ?? 0);
    if (fault) state.fault = fault;
    // The rest is nice to have: a robot that doesn't answer for it still shows its state.
    const minutes = value(4, 2);
    const area = value(4, 3);
    const cleaning = value(4, 23);
    if (minutes !== undefined) state.minutes = minutes;
    if (area !== undefined) state.areaM2 = area;
    if (cleaning !== undefined && CLEANING_MODES[cleaning]) state.cleaningMode = CLEANING_MODES[cleaning];
    const suction = nameOf(SUCTION_VALUE, value(4, 4));
    const water = nameOf(WATER_VALUE, value(4, 5));
    if (suction) state.suction = suction;
    if (water) state.water = water;
    const auto = value(15, 1);
    const ready = value(15, 3);
    const emptying = value(15, 5);
    if (auto !== undefined || ready !== undefined || emptying !== undefined) state.dustStation = { autoEmpty: auto === 1, ready: ready === 1, emptying: emptying === 1, limited: ready === 2 };
    return state;
  }

  /** Brush and filter wear plus lifetime cleaning totals (Dreame MIoT services 9 to 12). Read only. */
  async care(): Promise<VacuumCare> {
    const ids: Array<[number, number]> = [[9, 1], [9, 2], [10, 1], [10, 2], [11, 1], [11, 2], [12, 1], [12, 2], [12, 3], [12, 4], [16, 1], [16, 2]];
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
    const sensor = wear(16, 1, 2);
    const care: VacuumCare = { mainBrush: wear(9, 2, 1), sideBrush: wear(10, 2, 1), filter: wear(11, 1, 2), ...(Object.keys(sensor).length > 0 && { sensor }), totals };
    const known = [care.mainBrush, care.sideBrush, care.filter].some((p) => p.percent !== undefined || p.hoursLeft !== undefined) || Object.keys(totals).length > 0;
    if (!known) throw new MiioError("the vacuum did not report its parts");
    return care;
  }

  async run(action: VacuumAction): Promise<void> {
    const a = ACTIONS[action];
    const res = (await this.device.call("action", { did: "x", siid: a.siid, aiid: a.aiid, in: [] })) as { code?: number } | undefined;
    if (res?.code !== undefined && res.code !== 0) throw new MiioError(`the vacuum could not ${action} (code ${res.code})`);
  }

  /** Tells the robot a part was changed: its wear counter goes back to 100%. */
  async resetPart(part: VacuumPart): Promise<void> {
    const a = PART_RESETS[part];
    const res = (await this.device.call("action", { did: "x", siid: a.siid, aiid: a.aiid, in: [] })) as { code?: number } | undefined;
    if (res?.code !== undefined && res.code !== 0) throw new MiioError(`the vacuum could not reset the ${part} counter (code ${res.code})`);
  }

  async setCleaningMode(mode: CleaningMode): Promise<void> {
    const rows = (await this.device.call("set_properties", [{ did: "x", siid: 4, piid: 23, value: CLEANING_MODE_VALUE[mode] }])) as
      | Array<{ code?: number }>
      | undefined;
    if (!rows?.length || rows.some((r) => r.code !== undefined && r.code !== 0)) throw new MiioError(`the vacuum could not switch to ${mode}`);
  }

  async setSuction(level: SuctionLevel): Promise<void> {
    await this.setChecked(4, 4, SUCTION_VALUE[level], `suction ${level}`);
  }

  async setWater(level: WaterLevel): Promise<void> {
    await this.setChecked(4, 5, WATER_VALUE[level], `water ${level}`);
  }

  /** The robot's own settings (MIoT 4, 5, 7, 15). What it doesn't report is left out; none at all is an error. */
  async settings(): Promise<VacuumSettings> {
    const ids: Array<[number, number]> = [[4, 11], [4, 12], [4, 21], [4, 26], [4, 27], [4, 28], [5, 1], [5, 2], [5, 3], [7, 1], [15, 2]];
    const rows = (await this.device.call(
      "get_properties",
      ids.map(([siid, piid]) => ({ did: "x", siid, piid })),
    )) as Array<{ siid: number; piid: number; code?: number; value?: unknown }>;
    const raw = (siid: number, piid: number) => rows.find((r) => r.siid === siid && r.piid === piid && r.code === 0)?.value;
    const on = (siid: number, piid: number) => {
      const v = raw(siid, piid);
      return v === undefined ? undefined : v === true || v === 1 || v === 2; // some robots keep 2 for "on"
    };
    const num = (siid: number, piid: number) => {
      const v = raw(siid, piid);
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const out: VacuumSettings = {};
    for (const [key, siid, piid] of [["resumeCleaning", 4, 11], ["carpetBoost", 4, 12], ["obstacleAvoidance", 4, 21], ["customizedCleaning", 4, 26], ["childLock", 4, 27]] as const) {
      const v = on(siid, piid);
      if (v !== undefined) out[key] = v;
    }
    const sensitivity = nameOf(CARPET_SENSITIVITY_VALUE, num(4, 28));
    if (sensitivity) out.carpetSensitivity = sensitivity;
    const dnd = on(5, 1);
    if (dnd !== undefined) {
      const clock = (piid: number) => {
        const v = raw(5, piid);
        return typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v) ? v : undefined;
      };
      const from = clock(2);
      const to = clock(3);
      out.dnd = { enabled: dnd, ...(from && { from }), ...(to && { to }) };
    }
    const volume = num(7, 1);
    if (volume !== undefined) out.volume = Math.min(100, volume);
    const frequency = num(15, 2);
    if (frequency !== undefined) out.autoEmptyFrequency = frequency;
    if (Object.keys(out).length === 0) throw new MiioError("the vacuum did not report its settings");
    return out;
  }

  /** Switches one of the robot's settings on or off and reads it back. */
  async setSetting(name: SettingName, on: boolean): Promise<void> {
    const s = SWITCHES[name];
    await this.setChecked(s.siid, s.piid, "boolean" in s ? on : on ? 1 : 0, `${name} ${on ? "on" : "off"}`);
  }

  /** Sets a property and reads it back: a robot using "Customized Cleaning" says yes and keeps its old value. */
  private async setChecked(siid: number, piid: number, value: number | boolean, what: string): Promise<void> {
    const rows = (await this.device.call("set_properties", [{ did: "x", siid, piid, value }])) as Array<{ code?: number }> | undefined;
    if (!rows?.length || rows.some((r) => r.code !== undefined && r.code !== 0)) throw new MiioError(`the vacuum could not switch to ${what}`);
    const back = (await this.device.call("get_properties", [{ did: "x", siid, piid }])) as Array<{ code?: number; value?: number }> | undefined;
    if (back?.[0]?.code === 0 && back[0].value !== value) {
      throw new MiioError(`the vacuum kept its old setting instead of ${what}: Customized Cleaning is probably on in the app, and it keeps these per room`);
    }
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
