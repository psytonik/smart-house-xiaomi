import type { RecorderState } from "./recorder.js";

export interface HealthInput {
  go2rtc: { reachable: boolean };
  recorder: {
    enabled: boolean;
    state: RecorderState;
    /** Seconds since ffmpeg delivered a frame; null while there has been none yet. */
    frameAgeSec: number | null;
    /** Decoder warnings in the last minute (lost packets give a damaged picture). */
    damagedLastMinute: number;
    restarts: number;
    stalls: number;
  };
  storage: { clips: number; usedBytes: number; limitBytes: number; freeBytes: number };
  push: { devices: number };
  detection: { state: "ready" | "off" | "unavailable"; model?: string };
}

export type CheckLevel = "ok" | "info" | "warn" | "error";

export interface Check {
  id: "go2rtc" | "picture" | "detection" | "disk" | "storage" | "push";
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface Health {
  /** The worst of the checks; "info" never makes it worse. */
  level: "ok" | "warn" | "error";
  checks: Check[];
}

const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GB).toFixed(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Turns raw numbers into plain-language checks. Pure: everything it needs comes in as input. */
export function assess(input: HealthInput): Health {
  const { go2rtc, recorder: rec, storage, push, detection } = input;
  const checks: Check[] = [];

  checks.push(
    go2rtc.reachable
      ? { id: "go2rtc", level: "ok", title: "go2rtc is running", detail: "The bridge to the camera answers." }
      : { id: "go2rtc", level: "error", title: "go2rtc is not reachable", detail: "Without it there is no picture and no recording. Start everything with ./camera.sh (or ./camera.sh restart)." },
  );

  const restarts = rec.restarts > 0 ? ` ffmpeg restarted ${plural(rec.restarts, "time", "times")} since the app started${rec.stalls > 0 ? ` (${rec.stalls} because the stream froze)` : ""}.` : "";
  if (!rec.enabled) {
    checks.push({ id: "picture", level: "info", title: "Motion recording is off", detail: "MOTION_ENABLED=false in backend/.env. Live view still works." });
  } else if (rec.state === "ffmpeg-missing") {
    checks.push({ id: "picture", level: "error", title: "ffmpeg is missing", detail: "Motion recording and snapshots need it. Install it with brew install ffmpeg, then ./camera.sh restart." });
  } else if (rec.state === "restarting") {
    checks.push({ id: "picture", level: "warn", title: "Reconnecting to the camera stream", detail: `ffmpeg lost the stream and is starting again.${restarts}` });
  } else if (rec.state === "starting" || rec.frameAgeSec === null) {
    checks.push({ id: "picture", level: "info", title: "Connecting to the camera stream", detail: "No frame yet. The first one can take up to a few seconds." });
  } else if (rec.frameAgeSec > 10) {
    checks.push({
      id: "picture",
      level: "warn",
      title: `No picture for ${Math.round(rec.frameAgeSec)} s`,
      detail: `The stream froze; it is restarted automatically after the configured wait (MOTION_STALL_SEC).${restarts}`,
    });
  } else if (rec.damagedLastMinute > 0) {
    checks.push({
      id: "picture",
      level: "warn",
      title: `Damaged picture (${plural(rec.damagedLastMinute, "decoder warning", "decoder warnings")} in the last minute)`,
      detail: `Packets are being lost between the camera and go2rtc (go2rtc logs "pop buffer is full"). Motion is ignored while the picture is damaged. Try a lower resolution or bitrate in Xiaomi Home, check the camera's Wi-Fi, or connect the Mac with a cable.${restarts}`,
    });
  } else {
    checks.push({ id: "picture", level: "ok", title: "Picture is flowing", detail: `Frames are arriving.${restarts}` });
  }

  checks.push(
    detection.state === "ready"
      ? { id: "detection", level: "ok", title: `Object detection is on (${detection.model ?? "model"})`, detail: "New clips are labelled person, vehicle or animal." }
      : detection.state === "off"
        ? { id: "detection", level: "info", title: "Object detection is off", detail: "DETECT_ENABLED=false in backend/.env. Clips are recorded on motion only." }
        : { id: "detection", level: "info", title: "Object detection is not available", detail: "The model file or the runtime is missing. Run ./camera.sh fetch-model, then ./camera.sh restart. Clips are recorded on motion only." },
  );

  if (storage.freeBytes < 1 * GB) {
    checks.push({ id: "disk", level: "error", title: `Disk is almost full (${gb(storage.freeBytes)} GB free)`, detail: "Recording may fail. Free some space or lower MAX_STORAGE_GB." });
  } else if (storage.freeBytes < 5 * GB) {
    checks.push({ id: "disk", level: "warn", title: `Disk space is low (${gb(storage.freeBytes)} GB free)`, detail: "Free some space or lower MAX_STORAGE_GB so the clips cannot fill the disk." });
  } else {
    checks.push({ id: "disk", level: "ok", title: `${gb(storage.freeBytes)} GB free on the disk`, detail: "Enough room for recording." });
  }

  const nearLimit = storage.limitBytes > 0 && storage.usedBytes >= 0.9 * storage.limitBytes;
  checks.push({
    id: "storage",
    level: nearLimit ? "info" : "ok",
    title: `${plural(storage.clips, "motion clip", "motion clips")}, ${gb(storage.usedBytes)} of ${gb(storage.limitBytes)} GB`,
    detail: nearLimit
      ? "Close to the limit: the oldest clips are removed automatically to make room."
      : "Limit: MAX_STORAGE_GB. The oldest clips are removed automatically beyond it.",
  });

  checks.push({
    id: "push",
    level: "info",
    title: push.devices === 0 ? "No phone registered for notifications" : `${plural(push.devices, "phone", "phones")} registered for notifications`,
    detail: push.devices === 0 ? "Notifications start once the mobile app registers its push token." : "A notification is sent when a motion clip is ready.",
  });

  const level = checks.some((c) => c.level === "error") ? "error" : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { level, checks };
}
