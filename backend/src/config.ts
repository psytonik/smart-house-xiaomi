import { resolve } from "node:path";

export interface MotionConfig {
  enabled: boolean;
  /** Share of changed pixels (0..1) above which a frame counts as motion. */
  threshold: number;
  /** Per-pixel brightness change (0..255) that counts as "changed". */
  pixelDelta: number;
  /** Frames per second analysed, and their size. */
  fps: number;
  width: number;
  height: number;
  /** Seconds without motion before an event ends. */
  quietSec: number;
  /** Seconds kept before the first and after the last motion. */
  preRollSec: number;
  postRollSec: number;
  /** A longer event is split into several clips. */
  maxClipSec: number;
  /** Length of the rolling copy segments (clip start/end precision). */
  segmentSec: number;
  /** Motion is ignored for this long after a PTZ command (the camera itself is moving). */
  suppressAfterPtzMs: number;
  /** A frame where this share of the picture changed is a lighting change (IR cut-filter, exposure), not motion. */
  lightChange: number;
  /** Motion is ignored for this long after a lighting change or a damaged frame. */
  settleMs: number;
  /** ffmpeg is restarted when it delivers no frame for this long. */
  stallSec: number;
  /** Decoder warnings are not counted as damage this long after ffmpeg starts (no keyframe yet). */
  startupGraceSec: number;
  /** Keep the camera's sound in the clips (the camera sends A-law 16 kHz; clips store it as AAC). */
  audio: boolean;
}

export function defaultMotion(over: Partial<MotionConfig> = {}): MotionConfig {
  return {
    enabled: true,
    threshold: 0.012,
    pixelDelta: 22,
    fps: 4,
    width: 320,
    height: 180,
    quietSec: 8,
    preRollSec: 6,
    postRollSec: 4,
    maxClipSec: 120,
    segmentSec: 4,
    suppressAfterPtzMs: 4000,
    lightChange: 0.6,
    settleMs: 2000,
    stallSec: 15,
    startupGraceSec: 10,
    audio: true,
    ...over,
  };
}

export interface DetectConfig {
  enabled: boolean;
  modelPath: string;
  /** Detections below this confidence (0..1) are dropped. */
  minScore: number;
  /** Frames of a finished clip that are analysed. */
  maxFrames: number;
  /** A clip in which the detector found nothing is deleted instead of saved. */
  discardEmpty: boolean;
}

export interface Config {
  port: number;
  host: string;
  apiToken: string;
  go2rtcUrl: string;
  stream: string;
  dataDir: string;
  /** Built web app (web/ builds into backend/public). Served at "/" when the folder exists. */
  publicDir: string;
  /** What ffmpeg reads for recording and motion detection: go2rtc's RTSP output. */
  input: string;
  ffmpegPath: string;
  motion: MotionConfig;
  /** CozyLife lamp on the local network. Lamp control is off when this is empty. */
  lightIp?: string;
  lightPort?: number;
  /** Motion clips older than this many days are deleted. */
  retentionDays: number;
  /** Lifetime of signed media links, in seconds. */
  signedUrlTtlSec: number;
  detect: DetectConfig;
  /** The oldest clips are removed beyond this size. */
  maxStorageBytes: number;
  /** At most one push notification per this many seconds; the rest become one summary. */
  pushMinIntervalSec: number;
  pushUrl: string;
  expoAccessToken: string;
  /** Wrong tokens from one address within the window before it is locked out. */
  authMaxFailures: number;
  authWindowSec: number;
  /** How long the backend keeps its own consumer on the stream after a PTZ call. */
  keepAliveMs: number;
  /** Poll interval / attempts while waiting for the camera session to come up. */
  warmupPollMs: number;
  warmupAttempts: number;
}

/** Reads a number from the environment and fails loudly on a typo instead of quietly using a default. */
function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.POSITIVE_INFINITY, minExclusive = false): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  const ok = Number.isFinite(v) && (minExclusive ? v > min : v >= min) && v <= max;
  if (!ok) throw new Error(`${name} must be a number ${minExclusive ? ">" : ">="} ${min}${Number.isFinite(max) ? ` and <= ${max}` : ""} (got "${raw}")`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.API_TOKEN ?? "";
  if (apiToken.length < 16) {
    throw new Error("API_TOKEN is missing or too short (min 16 chars). Generate: openssl rand -hex 24");
  }
  const stream = env.STREAM_NAME ?? "psytonik_base";
  const threshold = num(env, "MOTION_THRESHOLD", 1.2, 0, 100, true) / 100;
  const lightChange = num(env, "MOTION_LIGHT_CHANGE", 60, 0, 100, true) / 100;
  if (lightChange <= threshold) throw new Error("MOTION_LIGHT_CHANGE must be larger than MOTION_THRESHOLD, or real motion would be taken for a lighting change");
  return {
    port: num(env, "PORT", 3100, 1, 65535),
    host: env.HOST ?? "127.0.0.1",
    apiToken,
    go2rtcUrl: (env.GO2RTC_URL ?? "http://127.0.0.1:1984").replace(/\/+$/, ""),
    stream,
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    publicDir: resolve(env.PUBLIC_DIR ?? "./public"),
    input: env.RTSP_URL ?? `rtsp://127.0.0.1:8554/${stream}`,
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    retentionDays: num(env, "RETENTION_DAYS", 7, 0, undefined, true),
    signedUrlTtlSec: num(env, "SIGNED_URL_TTL_SEC", 3600, 60),
    lightIp: env.LIGHT_IP || undefined,
    lightPort: num(env, "LIGHT_PORT", 5555, 1, 65535),
    motion: defaultMotion({
      enabled: env.MOTION_ENABLED !== "false",
      // MOTION_THRESHOLD is a percent of the frame that must change (default 1.2)
      threshold,
      lightChange,
      stallSec: num(env, "MOTION_STALL_SEC", 15, 2),
      audio: env.MOTION_AUDIO !== "false",
    }),
    detect: {
      enabled: env.DETECT_ENABLED !== "false",
      modelPath: env.DETECT_MODEL ?? resolve(import.meta.dirname, "..", "models", "yolox_tiny.onnx"),
      minScore: num(env, "DETECT_MIN_SCORE", 40, 5, 99) / 100,
      maxFrames: 5,
      discardEmpty: env.DETECT_DISCARD_EMPTY !== "false",
    },
    maxStorageBytes: num(env, "MAX_STORAGE_GB", 20, 0, undefined, true) * 1024 ** 3,
    pushMinIntervalSec: num(env, "PUSH_MIN_INTERVAL_SEC", 120, 0),
    pushUrl: env.EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send",
    expoAccessToken: env.EXPO_ACCESS_TOKEN ?? "",
    authMaxFailures: num(env, "AUTH_MAX_FAILURES", 10, 1),
    authWindowSec: num(env, "AUTH_WINDOW_SEC", 60, 1),
    keepAliveMs: 15_000,
    warmupPollMs: 500,
    warmupAttempts: 12,
  };
}
