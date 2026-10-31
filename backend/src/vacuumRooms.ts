import type { VacuumMap } from "./vacuumMap.js";

/** A room of the saved map, as the robot numbers it. */
export interface Room {
  /** The segment number the robot cleans by. */
  id: number;
  name: string;
  areaM2: number;
  /** The middle of the room in map cells, on the picture (Y counted from the top, like the floor plan). */
  center: { x: number; y: number };
}

/** What the robot calls the kinds of room it lets you pick in its app (the numbers are in the map's `seg_inf`). */
const ROOM_TYPES: Record<number, string> = {
  1: "Living room",
  2: "Primary bedroom",
  3: "Study",
  4: "Kitchen",
  5: "Dining hall",
  6: "Bathroom",
  7: "Balcony",
  8: "Corridor",
  9: "Utility room",
  10: "Closet",
  11: "Meeting room",
  12: "Office",
  13: "Fitness area",
  14: "Recreation area",
  15: "Secondary bedroom",
};

/** A patch of floor smaller than this is noise at the edge of a room, not a room. */
const MIN_AREA_M2 = 0.5;

/**
 * The rooms in a saved map. A floor cell's low six bits are its room number; walls (high bit) and empty cells belong to none.
 * `seg_inf` says what kind of room each is. A map the robot has not been taught rooms on has a single segment: nothing to pick
 * from, so the list is empty (the whole home is one "room").
 */
export function roomsOf(map: VacuumMap): Room[] {
  const found = new Map<number, { cells: number; sx: number; sy: number }>();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const v = map.cells[y * map.width + x]!;
      if (v === 0 || v & 0x80) continue;
      const id = v & 0x3f;
      if (id === 0) continue;
      const r = found.get(id) ?? { cells: 0, sx: 0, sy: 0 };
      r.cells++;
      r.sx += x;
      r.sy += y;
      found.set(id, r);
    }
  }
  const cellM2 = (map.gridMm / 1000) ** 2;
  const rooms: Room[] = [];
  const counts: Record<number, number> = {};
  for (const [id, r] of [...found].sort((a, b) => a[0] - b[0])) {
    const areaM2 = Math.round(r.cells * cellM2 * 10) / 10;
    if (areaM2 < MIN_AREA_M2) continue;
    const type = Number(map.segments?.[String(id)]?.type ?? 0);
    const kind = ROOM_TYPES[type];
    counts[type] = (counts[type] ?? 0) + 1;
    const name = kind ? (counts[type]! > 1 ? `${kind} ${counts[type]}` : kind) : `Room ${id}`;
    rooms.push({ id, name, areaM2, center: { x: Math.round(r.sx / r.cells), y: Math.round(map.height - 1 - r.sy / r.cells) } });
  }
  return rooms.length > 1 ? rooms : [];
}
