import type { Zone } from "./api";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The server refuses anything smaller than this in either direction. */
const MIN_SIZE = 0.01;
const round = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Two corners (0..1 of the picture, in any order, possibly outside it) to a rectangle the server accepts, or null. */
export function rectFromDrag(a: Point, b: Point): Rect | null {
  const [ax, ay, bx, by] = [clamp(a.x), clamp(a.y), clamp(b.x), clamp(b.y)];
  const rect = { x: round(Math.min(ax, bx)), y: round(Math.min(ay, by)), w: round(Math.abs(bx - ax)), h: round(Math.abs(by - ay)) };
  return rect.w < MIN_SIZE || rect.h < MIN_SIZE ? null : rect;
}

export const CORNER_PRESETS = [
  { id: "top-left", label: "Top left corner" },
  { id: "top-right", label: "Top right corner" },
  { id: "bottom-left", label: "Bottom left corner" },
  { id: "bottom-right", label: "Bottom right corner" },
] as const;

export type Corner = (typeof CORNER_PRESETS)[number]["id"];

/** A strip the size of a burned-in clock, in a corner. */
export function cornerZone(corner: Corner, mode: Zone["mode"], id: string): Zone {
  const w = 0.35;
  const h = 0.12;
  return {
    id,
    mode,
    x: corner.endsWith("left") ? 0 : round(1 - w),
    y: corner.startsWith("top") ? 0 : round(1 - h),
    w,
    h,
  };
}

/** "zone-N" with N one above the highest in use. */
export function nextZoneId(zones: Array<{ id: string }>): string {
  const used = zones.map((z) => /^zone-(\d+)$/.exec(z.id)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  return `zone-${Math.max(0, ...used) + 1}`;
}
