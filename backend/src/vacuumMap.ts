import { deflateSync, inflateSync } from "node:zlib";

export class VacuumMapError extends Error {}

export type VacuumMap = {
  name: string;
  mapId: number;
  width: number;
  height: number;
  /** Size of one cell in millimetres. */
  gridMm: number;
  /** Map origin in millimetres. */
  leftMm: number;
  topMm: number;
  /** One byte per cell: 0 outside, high bit set = wall, anything else = floor (the low bits can be a room number). */
  cells: Uint8Array;
  /** Same size as `cells`, 1 where something stands on the floor (furniture and the like). Kept apart because room numbers use the same bytes. */
  obstacles?: Uint8Array;
  /** Dock and robot positions in cells, if the frame says so. */
  charger?: { x: number; y: number };
  robot?: { x: number; y: number };
};

const HEADER = 27;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const MAX_CELLS = 4_000_000; // 200 m x 200 m at 5 cm: far more than any home

/** Url-safe base64 of a zlib stream -> the frame bytes (27-byte header, one byte per cell, JSON tail). Size-limited. */
export function unpackFrame(packed: string): Buffer {
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.from(packed.replace(/_/g, "/").replace(/-/g, "+"), "base64"), { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new VacuumMapError("the map could not be unpacked");
  }
  if (raw.length < HEADER) throw new VacuumMapError("the map header is too short");
  return raw;
}

/**
 * Reads the map file the Xiaomi cloud hands out for a Dreame robot: JSON `{mapstr:[{id,name,map}]}` where `map` is
 * url-safe base64 of a zlib stream, which is a 27-byte header, one byte per cell, then a small JSON tail.
 */
export function decodeCloudMap(fileText: string): VacuumMap {
  let outer: { mapstr?: Array<{ id?: number; name?: string; map?: string }>; curr_id?: number };
  try {
    outer = JSON.parse(fileText);
  } catch {
    throw new VacuumMapError("the map file is not JSON");
  }
  const entry = outer.mapstr?.find((m) => typeof m.map === "string");
  if (!entry?.map) throw new VacuumMapError("the map file has no map");

  const raw = unpackFrame(entry.map);
  const width = raw.readUInt16LE(19);
  const height = raw.readUInt16LE(21);
  const gridMm = raw.readUInt16LE(17);
  if (!width || !height || !gridMm || raw.length < HEADER + width * height) throw new VacuumMapError("the map size does not add up");
  if (width * height > MAX_CELLS) throw new VacuumMapError("the map is too large");

  const leftMm = raw.readInt16LE(23);
  const topMm = raw.readInt16LE(25);
  const cell = (xMm: number, yMm: number) => ({ x: Math.round((xMm - leftMm) / gridMm), y: Math.round((yMm - topMm) / gridMm) });
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;

  const chargerXY = { x: raw.readInt16LE(11), y: raw.readInt16LE(13) };
  const robotXY = { x: raw.readInt16LE(5), y: raw.readInt16LE(7) };
  const charger = cell(chargerXY.x, chargerXY.y);
  const robot = cell(robotXY.x, robotXY.y);

  return {
    name: entry.name ?? "",
    mapId: raw.readUInt16LE(0),
    width,
    height,
    gridMm,
    leftMm,
    topMm,
    cells: new Uint8Array(raw.subarray(HEADER, HEADER + width * height)),
    // (0, 0) in millimetres means "unknown" in this format
    charger: (chargerXY.x || chargerXY.y) && inside(charger) ? charger : undefined,
    robot: (robotXY.x || robotXY.y) && inside(robot) ? robot : undefined,
  };
}

// ---------- PNG ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

type Rgba = readonly [number, number, number, number];
export type MapColors = { floor: Rgba; wall: Rgba; obstacle: Rgba; route: Rgba; charger: Rgba; robot: Rgba };
export const DEFAULT_COLORS: MapColors = {
  floor: [54, 70, 98, 255],
  wall: [170, 190, 225, 255],
  obstacle: [136, 148, 176, 255], // 3:1 against the floor, so objects can be told apart
  route: [225, 232, 255, 255],
  charger: [60, 200, 120, 255],
  robot: [255, 170, 60, 255],
};

/** Draws the map as a transparent-background PNG, `scale` pixels per cell. */
export function renderMapPng(map: VacuumMap, scale = 5, colors: MapColors = DEFAULT_COLORS, route: Point[][] = []): Buffer {
  const W = map.width * scale;
  const H = map.height * scale;
  const rgba = Buffer.alloc(W * H * 4); // transparent
  const put = (x: number, y: number, c: Rgba) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    rgba.set(c, (y * W + x) * 4);
  };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      // the robot's Y axis points up, a picture's points down: draw the rows from the bottom
      const v = map.cells[(map.height - 1 - y) * map.width + x]!;
      if (v === 0) continue;
      const c = v & 0x80 ? colors.wall : map.obstacles?.[(map.height - 1 - y) * map.width + x] ? colors.obstacle : colors.floor;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x * scale + dx, y * scale + dy, c);
    }
  }
  // the way the robot drove, as a line two pixels thick; points are in picture cells (see toCells)
  for (const line of route) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i]!;
      const b = line[i + 1] ?? a;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * scale));
      for (let k = 0; k <= steps; k++) {
        const px = Math.round((a.x + ((b.x - a.x) * k) / steps) * scale);
        const py = Math.round((a.y + ((b.y - a.y) * k) / steps) * scale);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(px + dx, py + dy, colors.route);
      }
    }
  }
  const dot = (p: { x: number; y: number } | undefined, c: Rgba) => {
    if (!p) return;
    const r = Math.max(3, Math.round(scale * 2.4));
    const row = map.height - 1 - p.y;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(Math.round((p.x + 0.5) * scale) + dx, Math.round((row + 0.5) * scale) + dy, c);
  };
  dot(map.charger, colors.charger);
  dot(map.robot, colors.robot);

  return encodePng(rgba, W, H);
}

/** 8-bit RGBA pixels -> a PNG file. */
function encodePng(rgba: Buffer, W: number, H: number): Buffer {
  const stride = W * 4;
  const filtered = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A grid of raw cell values as a picture, rows drawn bottom-up like the floor plan. `colorOf` returns undefined for a transparent cell. */
export function renderGridPng(width: number, height: number, cells: Uint8Array, colorOf: (v: number) => Rgba | undefined, scale = 5): Buffer {
  const W = width * scale;
  const H = height * scale;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colorOf(cells[(height - 1 - y) * width + x]!);
      if (!c) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) rgba.set(c, ((y * scale + dy) * W + x * scale + dx) * 4);
    }
  }
  return encodePng(rgba, W, H);
}

// ---------- live frames (what the robot reports while it moves) ----------
export type Point = { x: number; y: number };
export type LiveFrame = { mapId: number; frameId: number; robot?: Point; path: Point[] };

/** The robot's trail: tokens like "L12,-5" (a step from the last point) or "M-3000,3400" / "l..." (an absolute point), in millimetres. */
export function parsePath(trail: string): Point[] {
  const out: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  for (const m of trail.matchAll(/([MWSLl])(-?\d+),(-?\d+)/g)) {
    const x = Number(m[2]);
    const y = Number(m[3]);
    cur = m[1] === "L" ? { x: cur.x + x, y: cur.y + y } : { x, y };
    out.push(cur);
  }
  return out;
}

/** One frame from the robot's property 6.1: where it is, and the bit of trail it just drove. Millimetres. */
export function decodeLiveFrame(packed: string): LiveFrame {
  const raw = unpackFrame(packed);
  const cellsEnd = HEADER + raw.readUInt16LE(19) * raw.readUInt16LE(21);
  let trail = "";
  try {
    const tail = JSON.parse(raw.subarray(Math.min(cellsEnd, raw.length)).toString("utf8")) as { tr?: unknown };
    if (typeof tail.tr === "string") trail = tail.tr;
  } catch {
    /* a frame without a JSON tail has no trail */
  }
  const x = raw.readInt16LE(5);
  const y = raw.readInt16LE(7);
  return { mapId: raw.readUInt16LE(0), frameId: raw.readUInt16LE(2), robot: x || y ? { x, y } : undefined, path: parsePath(trail) };
}

/** What the picture needs to place things on it. Written next to the picture when it is drawn. */
export type MapGeometry = { width: number; height: number; gridMm: number; leftMm: number; topMm: number };
export const geometryOf = (m: VacuumMap): MapGeometry => ({ width: m.width, height: m.height, gridMm: m.gridMm, leftMm: m.leftMm, topMm: m.topMm });
export const isGeometry = (g: unknown): g is MapGeometry =>
  !!g && typeof g === "object" && ["width", "height", "gridMm", "leftMm", "topMm"].every((k) => Number.isFinite((g as Record<string, unknown>)[k])) && (g as MapGeometry).gridMm > 0;

/** A point in millimetres -> a position in map cells (can be fractional) on the picture. Y is flipped: the picture is drawn bottom-up. */
export const toCells = (g: MapGeometry, p: Point): Point => ({ x: (p.x - g.leftMm) / g.gridMm, y: g.height - (p.y - g.topMm) / g.gridMm });

// ---------- detail: the map pieces the robot sends while it cleans ----------
/** One map piece from property 6.1: a patch of cells at a position (mm), and the bit of trail driven since the last one. */
export type MapPiece = { mapId: number; gridMm: number; leftMm: number; topMm: number; width: number; height: number; cells: Uint8Array; path: Point[] };

export function decodePiece(packed: string): MapPiece {
  const raw = unpackFrame(packed);
  const width = raw.readUInt16LE(19);
  const height = raw.readUInt16LE(21);
  if (width * height > MAX_CELLS || raw.length < HEADER + width * height) throw new VacuumMapError("the map piece size does not add up");
  let path: Point[] = [];
  try {
    const tail = JSON.parse(raw.subarray(HEADER + width * height).toString("utf8")) as { tr?: unknown };
    if (typeof tail.tr === "string") path = parsePath(tail.tr);
  } catch {
    /* a piece without a JSON tail has no trail */
  }
  return {
    mapId: raw.readUInt16LE(0),
    gridMm: raw.readUInt16LE(17),
    leftMm: raw.readInt16LE(23),
    topMm: raw.readInt16LE(25),
    width,
    height,
    cells: new Uint8Array(raw.subarray(HEADER, HEADER + width * height)),
    path,
  };
}

/** What the robot's cell values mean while it cleans (worked out by laying them over the saved map): 8 is an object, 4/248/252 are wall edges. */
const OBJECT_VALUE = 8;
const WALL_EDGE_VALUES = new Set([4, 248, 252]);

/** The saved map with wall edges and objects from the pieces drawn over it. Pieces go oldest first; a newer one wins. */
export function addDetail(base: VacuumMap, pieces: MapPiece[]): VacuumMap {
  const cells = Uint8Array.from(base.cells);
  const obstacles = new Uint8Array(base.cells.length);
  for (const p of pieces) {
    if (p.gridMm !== base.gridMm) continue;
    const dx = Math.round((p.leftMm - base.leftMm) / base.gridMm);
    const dy = Math.round((p.topMm - base.topMm) / base.gridMm);
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const v = p.cells[y * p.width + x]!;
        const mx = x + dx;
        const my = y + dy;
        if (mx < 0 || my < 0 || mx >= base.width || my >= base.height) continue;
        const at = my * base.width + mx;
        if (WALL_EDGE_VALUES.has(v)) {
          cells[at] = 0x81;
          obstacles[at] = 0;
        } else if (v === OBJECT_VALUE && cells[at] !== 0 && !(cells[at]! & 0x80)) {
          obstacles[at] = 1; // only on the floor: an object outside the apartment would float in the dark
        }
      }
    }
  }
  return { ...base, cells, obstacles };
}

/** The whole way the robot drove, in picture cells. A new line starts wherever it jumps more than a metre (a fresh start, a gap in the data). */
export function routeOf(geo: MapGeometry, pieces: MapPiece[]): Point[][] {
  const lines: Point[][] = [];
  for (const piece of pieces) {
    for (const pt of piece.path) {
      const p = toCells(geo, pt);
      const line = lines.at(-1);
      const last = line?.at(-1);
      if (!line || !last || Math.hypot(p.x - last.x, p.y - last.y) * geo.gridMm > 1000) lines.push([p]);
      else line.push(p);
    }
  }
  return lines;
}
