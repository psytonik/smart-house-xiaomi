/** The microphone is closed by itself after this long, so it is never left open by accident. */
export const TALK_MAX_MS = 60_000;

/** Why talking to the camera is not possible here, or null when it is. */
export function talkBlockedReason(env: { secure: boolean; hasMic: boolean }): string | null {
  if (!env.secure) return "The browser gives the microphone only to HTTPS pages or localhost. Open the app on the Mac itself (localhost) or over HTTPS.";
  if (!env.hasMic) return "This browser has no microphone access.";
  return null;
}
