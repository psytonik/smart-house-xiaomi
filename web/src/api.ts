const KEY = "cam.token";

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(value: string): void {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* storage unavailable: the token lives for this session only */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

// Used when localStorage is unavailable.
let sessionToken = "";

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
  }
}

export function setToken(token: string): void {
  sessionToken = token;
  tokenStore.set(token);
}

export function currentToken(): string {
  return tokenStore.get() ?? sessionToken;
}

export function clearToken(): void {
  sessionToken = "";
  tokenStore.clear();
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${currentToken()}` },
  });
  if (res.status === 401) throw new AuthError();
  return res;
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    // Fastify's own 404 for a path it has no route for: the page is newer than the server that is running
    if (res.status === 404 && body.message?.startsWith("Route ")) return `${fallback}: the server is older than this page and doesn't have this yet. Restart it (./camera.sh restart backend).`;
    return body.error ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

export type Direction = "left" | "right" | "up" | "down";

export async function move(direction: Direction): Promise<void> {
  const res = await api("/api/ptz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction }),
  });
  if (!res.ok) throw new Error(await errorText(res, "The camera didn't move"));
}

export interface Status {
  reachable: boolean;
  stream: string;
}

export async function getStatus(): Promise<Status> {
  const res = await api("/api/status");
  return (await res.json()) as Status;
}

/** Checks a token against the backend without storing it. */
export async function checkToken(token: string): Promise<"ok" | "wrong" | "offline"> {
  try {
    const res = await fetch("/api/status", { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return "wrong";
    return res.ok ? "ok" : "offline";
  } catch {
    return "offline";
  }
}

export interface Snapshot {
  name: string;
  bytes: number;
  /** Signed, expiring link the <img> tag can open without an Authorization header. */
  url: string;
}

export async function listSnapshots(): Promise<Snapshot[]> {
  const res = await api("/api/snapshots");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load snapshots"));
  return ((await res.json()) as { items: Snapshot[] }).items;
}

export async function saveSnapshot(): Promise<Snapshot> {
  const res = await api("/api/snapshots", { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't save the snapshot"));
  return (await res.json()) as Snapshot;
}

export async function fetchFrame(): Promise<Blob> {
  const res = await api("/api/snapshot");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't get a frame"));
  return res.blob();
}

export interface MotionStatus {
  enabled: boolean;
  state: "off" | "starting" | "running" | "ffmpeg-missing" | "restarting";
  recording: boolean;
  /** Share of the picture that changed inside the motion zones, in percent. */
  level: number;
  /** Level (percent) from which a frame counts as motion. */
  threshold: number;
  /** The picture may be damaged (reconnecting, or the decoder complained a moment ago). */
  unstable?: boolean;
}

export async function getMotion(): Promise<MotionStatus> {
  const res = await api("/api/motion");
  return (await res.json()) as MotionStatus;
}

export interface Clip {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  peak: number;
  bytes: number;
  clip: string;
  thumb: string | null;
  /** Signed links for <video> and <img>. */
  clipUrl: string;
  thumbUrl: string | null;
  /** What the detector saw. Absent: never analysed. Empty: analysed, nothing found. */
  objects?: Array<{ label: "person" | "animal"; score: number }>;
}

export async function listClips(): Promise<Clip[]> {
  const res = await api("/api/events?limit=48");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load motion clips"));
  return ((await res.json()) as { items: Clip[] }).items;
}

export async function deleteClip(id: string): Promise<void> {
  const res = await api(`/api/events/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't delete the clip"));
}

export interface LightPatch {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
}

export interface Lamp {
  id: string;
  name: string;
  kind: "wifi" | "bluetooth";
  reachable: boolean;
  /** false when the lamp can't report its state, so the values shown are what was last sent. */
  stateKnown: boolean;
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
}

export async function getLamps(): Promise<Lamp[]> {
  const res = await api("/api/lights");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the lights"));
  return ((await res.json()) as { lights: Lamp[] }).lights;
}

export async function setLamp(id: string, patch: LightPatch): Promise<void> {
  const res = await api(`/api/lights/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't change the light"));
}

export interface Zone {
  id: string;
  /** watch: motion counts only here. ignore: motion here is ignored. privacy: ignored and hidden in pictures. */
  mode: "watch" | "ignore" | "privacy";
  /** Shares (0..1) of the picture, origin top left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function getZones(): Promise<Zone[]> {
  const res = await api("/api/zones");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load the zones"));
  return ((await res.json()) as { zones: Zone[] }).zones;
}

export async function saveZones(zones: Zone[]): Promise<Zone[]> {
  const res = await api("/api/zones", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ zones }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't save the zones"));
  return ((await res.json()) as { zones: Zone[] }).zones;
}

export interface SystemCheck {
  id: "go2rtc" | "picture" | "detection" | "disk" | "storage" | "push";
  level: "ok" | "info" | "warn" | "error";
  title: string;
  detail: string;
}

export interface SystemHealth {
  level: "ok" | "warn" | "error";
  checks: SystemCheck[];
  uptimeSec: number;
}

export async function getSystem(): Promise<SystemHealth> {
  const res = await api("/api/system");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load the system status"));
  return (await res.json()) as SystemHealth;
}

export interface Cameras {
  streams: Array<{ name: string; active: boolean }>;
  /** Mi Home accounts go2rtc is signed in to. */
  accounts: string[];
}

export async function getCameras(): Promise<Cameras> {
  const res = await api("/api/cameras");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load the cameras"));
  return (await res.json()) as Cameras;
}

export type LoginResult = { status: "ok" } | { status: "captcha"; image: string } | { status: "verify"; target: string };

export type LoginInput = { username: string; password: string } | { captcha: string } | { verify: string };

export async function xiaomiLogin(input: LoginInput): Promise<LoginResult> {
  const res = await api("/api/xiaomi/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorText(res, "Mi Home sign-in failed"));
  return (await res.json()) as LoginResult;
}

export interface XiaomiDevice {
  did: string;
  name: string;
  model: string;
  ip: string;
}

export async function listXiaomiDevices(account: string, region: string): Promise<XiaomiDevice[]> {
  const res = await api(`/api/xiaomi/devices?${new URLSearchParams({ account, region })}`);
  if (!res.ok) throw new Error(await errorText(res, "Couldn't list the cameras"));
  return ((await res.json()) as { devices: XiaomiDevice[] }).devices;
}

/** The browser names the device only; the backend takes the stream source from go2rtc. */
export async function addCamera(input: { account: string; region: string; did: string; name: string }): Promise<{ name: string; active: boolean }> {
  const res = await api("/api/cameras", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't add the camera"));
  return (await res.json()) as { name: string; active: boolean };
}

/**
 * Asks the backend to let go of the camera so the next connection starts fresh. The caller must close its own
 * player first, otherwise this tab is itself a viewer that keeps the session open.
 */
export async function resetStream(): Promise<{ otherViewers: number }> {
  const res = await api("/api/stream/reset", { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't reset the stream"));
  return (await res.json()) as { otherViewers: number };
}

export type VacuumMode = "cleaning" | "paused" | "idle" | "returning" | "charging" | "charged" | "emptying" | "updating" | "error" | "unknown";
export type VacuumAction = "start" | "pause" | "stop" | "dock" | "find" | "empty";

export type SuctionLevel = "quiet" | "standard" | "strong" | "turbo";
export type WaterLevel = "low" | "medium" | "high";

export interface VacuumState {
  configured: boolean;
  reachable?: boolean;
  battery?: number;
  mode?: VacuumMode;
  task?: "whole home" | "rooms" | "zone" | "spot" | "mapping";
  fault?: { code: number; title: string; hint: string };
  model?: string;
  firmware?: string;
  areaM2?: number;
  minutes?: number;
  cleaningMode?: CleaningMode;
  suction?: SuctionLevel;
  water?: WaterLevel;
  dustStation?: { autoEmpty: boolean; ready: boolean; emptying: boolean; limited: boolean };
}

export async function getVacuum(): Promise<VacuumState> {
  const res = await api("/api/vacuum");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the vacuum"));
  return (await res.json()) as VacuumState;
}

export interface PartWear {
  percent?: number;
  hoursLeft?: number;
}

export interface VacuumCare {
  mainBrush: PartWear;
  sideBrush: PartWear;
  filter: PartWear;
  sensor?: PartWear;
  totals: { firstCleanAt?: string; minutes?: number; cleanings?: number; areaM2?: number };
}

/** Brush and filter wear and the lifetime totals. */
export async function getVacuumCare(): Promise<VacuumCare> {
  const res = await api("/api/vacuum/care");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the vacuum's parts"));
  return (await res.json()) as VacuumCare;
}

export interface CleaningRecord {
  startedAt: string;
  minutes: number;
  areaM2: number;
}

/** The last cleanings the Xiaomi cloud remembers, newest first. */
export async function getVacuumHistory(): Promise<CleaningRecord[]> {
  const res = await api("/api/vacuum/history");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the cleaning history"));
  return ((await res.json()) as { cleanings: CleaningRecord[] }).cleanings;
}

export type VacuumPartName = "mainBrush" | "sideBrush" | "filter" | "sensor";

/** A room of the robot's saved map. */
export interface VacuumRoom {
  id: number;
  name: string;
  areaM2: number;
}

/** The rooms of the saved map. Empty while the robot has been taught none; the error says so when the floor plan was never drawn. */
export async function getVacuumRooms(): Promise<VacuumRoom[]> {
  const res = await api("/api/vacuum/rooms");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the rooms"));
  return ((await res.json()) as { rooms: VacuumRoom[] }).rooms;
}

/** Starts a cleaning of these rooms, in this order. */
export async function cleanVacuumRooms(rooms: number[]): Promise<void> {
  const res = await api("/api/vacuum/clean-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rooms }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't start the cleaning"));
}

export interface ScheduledTask {
  id: number;
  enabled: boolean;
  time: string;
  /** Seven digits, 1 = repeats that day. */
  days: string;
  once: boolean;
}

/** The schedule kept on the robot. Read only: it is changed in the Dreamehome app. */
export async function getVacuumSchedule(): Promise<ScheduledTask[]> {
  const res = await api("/api/vacuum/schedule");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the schedule"));
  return ((await res.json()) as { tasks: ScheduledTask[] }).tasks;
}

async function postValue(path: string, body: object, fallback: string): Promise<void> {
  const res = await api(`/api/vacuum/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorText(res, fallback));
}

/** 0..100. The robot says something at the new volume. */
export const sendVacuumVolume = (level: number) => postValue("volume", { level }, "Couldn't change the volume");
export const sendVacuumCarpet = (level: "low" | "medium" | "high") => postValue("carpet", { level }, "Couldn't change the carpet sensitivity");
/** How often the dock empties the bin by itself: after every 1st, 2nd or 3rd cleaning. */
export const sendVacuumAutoEmpty = (every: 1 | 2 | 3) => postValue("auto-empty", { every }, "Couldn't change how often the dock empties the bin");
/** "HH:MM" each. */
export const sendVacuumQuietHours = (from: string, to: string) => postValue("dnd-hours", { from, to }, "Couldn't change the quiet hours");

export type VacuumSwitch = "resumeCleaning" | "carpetBoost" | "obstacleAvoidance" | "childLock" | "dnd";

/** The robot's own settings. Whatever it doesn't report is missing. */
export interface VacuumSettings {
  resumeCleaning?: boolean;
  carpetBoost?: boolean;
  obstacleAvoidance?: boolean;
  customizedCleaning?: boolean;
  childLock?: boolean;
  carpetSensitivity?: "low" | "medium" | "high";
  dnd?: { enabled: boolean; from?: string; to?: string };
  volume?: number;
  autoEmptyFrequency?: number;
}

export async function getVacuumSettings(): Promise<VacuumSettings> {
  const res = await api("/api/vacuum/settings");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the robot's settings"));
  return (await res.json()) as VacuumSettings;
}

/** Switches one setting on or off. The error says why when the robot didn't take it. */
export async function sendVacuumSwitch(name: VacuumSwitch, on: boolean): Promise<void> {
  const res = await api("/api/vacuum/setting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, on }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't change the setting"));
}

/** After changing a brush or the filter: starts its wear counter again from 100%. */
export async function resetVacuumPart(part: VacuumPartName): Promise<void> {
  const res = await api("/api/vacuum/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't reset the counter"));
}

export async function sendVacuum(action: VacuumAction): Promise<void> {
  const res = await api("/api/vacuum", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't reach the vacuum"));
}

/** The floor plan picture, or null when none has been added. `fresh` skips the browser's cached copy. */
export async function fetchVacuumMap(fresh = false): Promise<Blob | null> {
  const res = await api("/api/vacuum/map", fresh ? { cache: "no-store" } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorText(res, "Couldn't load the floor plan"));
  return res.blob();
}

/** Asks the backend to redraw the floor plan from the robot's own map. */
export async function refreshVacuumMap(): Promise<void> {
  const res = await api("/api/vacuum/map/refresh", { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't update the floor plan"));
}

export type VacuumLive = {
  /** Size of the floor plan in map cells; `robot` and `trail` are positions in the same cells. */
  map: { width: number; height: number };
  robot: { x: number; y: number } | null;
  trail: Array<{ x: number; y: number }>;
  ageSeconds: number | null;
  live: boolean;
};

/** Where the robot is right now, and the trail it just drove. */
export async function getVacuumLive(): Promise<VacuumLive> {
  const res = await api("/api/vacuum/live");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the robot's position"));
  return res.json();
}

export type CleaningMode = "sweeping" | "mopping" | "both";

export async function sendSuction(level: SuctionLevel): Promise<void> {
  const res = await api("/api/vacuum/suction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level }) });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't change the suction"));
}

export async function sendWater(level: WaterLevel): Promise<void> {
  const res = await api("/api/vacuum/water", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level }) });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't change the water level"));
}

export async function sendCleaningMode(mode: CleaningMode): Promise<void> {
  const res = await api("/api/vacuum/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't change the cleaning mode"));
}

// ---------- TV (Google TV / Android TV on the local network) ----------
export type TvKey =
  | "power" | "home" | "back" | "up" | "down" | "left" | "right" | "ok" | "volumeUp" | "volumeDown" | "mute" | "menu" | "settings" | "input"
  | "channelUp" | "channelDown" | "playPause" | "play" | "pause" | "stop" | "next" | "previous" | "rewind" | "fastForward" | "info" | "guide" | "tv"
  | "search" | "captions" | "enter" | "backspace" | "hdmi1" | "hdmi2" | "hdmi3" | "hdmi4" | "red" | "green" | "yellow" | "blue"
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export interface TvState {
  configured: boolean;
  /** This app has been paired with the TV. */
  paired?: boolean;
  link?: "offline" | "connecting" | "ready";
  /** The TV is showing a code: type it in. */
  waitingForCode?: boolean;
  powered?: boolean;
  volume?: { level: number; max: number; muted: boolean };
  /** Android package of the app in front. */
  app?: string;
  apps?: Array<{ id: string; label: string }>;
  /** The TV's own source menu and inputs can be reached (over ADB). */
  adb?: boolean;
  /** A wake-up packet can reach the sleeping TV (TV_MAC is set): the power button works while it does not answer. */
  wake?: boolean;
}

export async function getTv(): Promise<TvState> {
  const res = await api("/api/tv");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the TV"));
  return (await res.json()) as TvState;
}

async function postTv(path: string, body: object, fallback: string): Promise<void> {
  const res = await api(`/api/tv/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await errorText(res, fallback));
}

/** What the TV's own Source Choice offers: Home, TV, HDMI 1, HDMI 2, AV, Media Player. */
export async function getTvSources(): Promise<Array<{ id: string; label: string }>> {
  const res = await api("/api/tv/sources");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the TV's sources"));
  return ((await res.json()) as { sources: Array<{ id: string; label: string }> }).sources;
}
export interface TvRunningApp {
  package: string;
  label: string;
  memoryMb: number;
  /** A helper (Chromecast receiver, installer), not an app a person opened. */
  helper: boolean;
}

/** The apps in the TV's memory that may be closed. */
export async function getTvRunning(): Promise<TvRunningApp[]> {
  const res = await api("/api/tv/running");
  if (!res.ok) throw new Error(await errorText(res, "Couldn't read the running apps"));
  return ((await res.json()) as { apps: TvRunningApp[] }).apps;
}

/** Stops the named apps, or all that may be closed. Returns the packages that were stopped. */
export async function closeTvApps(which: string[] | "all"): Promise<string[]> {
  const res = await api("/api/tv/running/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(which === "all" ? { all: true } : { packages: which }),
  });
  if (!res.ok) throw new Error(await errorText(res, "Couldn't close the apps"));
  return ((await res.json()) as { closed: string[] }).closed;
}

export const switchTvSource = (source: string) => postTv("source", { source }, "Couldn't switch the source");
export const sendTvKey = (key: TvKey) => postTv("key", { key }, "The TV didn't take that");
export const launchTvApp = (app: string) => postTv("app", { app }, "Couldn't open the app");
/** Asks the TV to show its pairing code. */
export const startTvPairing = () => postTv("pair", {}, "Couldn't start pairing");
export const sendTvCode = (code: string) => postTv("pair/code", { code }, "Couldn't pair");
export const cancelTvPairing = () => postTv("pair/cancel", {}, "Couldn't cancel pairing");
