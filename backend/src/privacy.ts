import { spawn } from "node:child_process";
import type { Zone } from "./zones.js";

/**
 * ffmpeg filter that paints every privacy zone black. Coordinates are shares of the picture
 * (validated numbers, 4 decimals), so the same filter fits any resolution.
 */
export function privacyFilter(zones: Zone[]): string {
  return zones
    .filter((z) => z.mode === "privacy")
    .map((z) => `drawbox=x=iw*${z.x}:y=ih*${z.y}:w=iw*${z.w}:h=ih*${z.h}:color=black:t=fill`)
    .join(",");
}

/** Filter for clip thumbnails: scale down, then hide the private areas. */
export function thumbnailFilter(zones: Zone[]): string {
  const hide = privacyFilter(zones);
  return hide ? `scale=480:-2,${hide}` : "scale=480:-2";
}

/**
 * Burns the privacy zones into a JPEG. Without privacy zones the same buffer comes back.
 * It FAILS rather than return the picture unhidden: showing a private area because the redaction broke
 * is the one outcome this feature must never have.
 */
export function blackout(jpeg: Buffer, zones: Zone[], ffmpegPath: string): Promise<Buffer> {
  const filter = privacyFilter(zones);
  if (!filter) return Promise.resolve(jpeg);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 10_000);
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const image = Buffer.concat(out);
      if (code === 0 && image.length > 0) resolve(image);
      else reject(new Error(`ffmpeg could not hide the private areas (exit ${code}): ${err.trim().split("\n").slice(-1)[0] ?? ""}`));
    });
    p.stdin.on("error", () => {}); // ffmpeg may exit before it has read everything
    p.stdin.end(jpeg);
  });
}
