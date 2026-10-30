/** Mi Home cloud regions, in the order people look for them. The code is what go2rtc expects. */
export const REGIONS = [
  { id: "de", label: "Europe" },
  { id: "us", label: "United States" },
  { id: "sg", label: "Singapore" },
  { id: "ru", label: "Russia" },
  { id: "i2", label: "India" },
  { id: "cn", label: "China" },
] as const;

export function regionLabel(id: string): string {
  return REGIONS.find((r) => r.id === id)?.label ?? id;
}

/**
 * A name for the go2rtc stream, taken from the camera's name: lowercase letters, digits and dashes
 * ("Living room" -> "living-room"). A name with no Latin letters or digits ("Гостиная") becomes "camera".
 * Never equal to a name in `taken`: a number is added instead.
 */
export function streamName(cameraName: string, taken: readonly string[]): string {
  const base =
    cameraName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/g, "") || "camera";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Same rule as the backend (CAMERA_NAME in src/xiaomi.ts), so a bad name is explained before the request. */
export const STREAM_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
