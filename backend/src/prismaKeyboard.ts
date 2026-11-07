/**
 * Typing into Prisma's on-screen search keyboard with the arrow keys (Prisma has no text input from outside, and `input text`
 * cannot type Cyrillic). The layout was read from a screenshot of the TV (1280x720): the focus starts on «й».
 *
 *   й ц у к е н г ш щ з х ъ
 *   ё ф ы в а п р о л д ж э
 *   я ч с м и т ь б ю .
 *   [mic] [language] [#+] [      space      ] [backspace] [Поиск]
 */
const ROWS = ["йцукенгшщзхъ", "ёфывапролджэ", "ячсмитьбю."];
const STEP = 72; // distance between the centres of two letter keys, in screen pixels
const FIRST_X = 242; // the centre of the first letter key
/** The bottom row: x-range of each key. */
const BOTTOM: Array<{ id: string; from: number; to: number }> = [
  { id: "mic", from: 210, to: 316 },
  { id: "language", from: 324, to: 429 },
  { id: "symbols", from: 437, to: 541 },
  { id: "space", from: 549, to: 750 },
  { id: "backspace", from: 757, to: 862 },
  { id: "search", from: 870, to: 1069 },
];

export type Cell = { row: number; col: number };
export interface Move {
  key: "up" | "down" | "left" | "right" | "ok";
  times: number;
}

const centre = (c: Cell): number => (c.row < ROWS.length ? FIRST_X + STEP * c.col : (BOTTOM[c.col]!.from + BOTTOM[c.col]!.to) / 2);

/** Where the focus goes from a cell by one arrow key, as the Android focus search would: the key above or below that covers its centre, else the nearest. */
export function step(from: Cell, dir: "up" | "down" | "left" | "right"): Cell {
  const rowLen = (row: number) => (row < ROWS.length ? ROWS[row]!.length : BOTTOM.length);
  if (dir === "left") return { row: from.row, col: Math.max(0, from.col - 1) };
  if (dir === "right") return { row: from.row, col: Math.min(rowLen(from.row) - 1, from.col + 1) };
  const row = from.row + (dir === "down" ? 1 : -1);
  if (row < 0 || row > ROWS.length) return from;
  const x = centre(from);
  let best = 0;
  let bestDistance = Infinity;
  for (let col = 0; col < rowLen(row); col++) {
    const d = Math.abs(centre({ row, col }) - x);
    if (d < bestDistance) [best, bestDistance] = [col, d];
  }
  return { row, col: best };
}

function cellOf(ch: string): Cell | undefined {
  if (ch === " ") return { row: ROWS.length, col: BOTTOM.findIndex((b) => b.id === "space") };
  for (let row = 0; row < ROWS.length; row++) {
    const col = ROWS[row]!.indexOf(ch);
    if (col >= 0) return { row, col };
  }
  return undefined;
}

/** The shortest way between two cells with the focus rule above (a plain search over the few dozen cells). */
function path(from: Cell, to: Cell): Array<"up" | "down" | "left" | "right"> {
  const id = (c: Cell) => `${c.row}:${c.col}`;
  const seen = new Map<string, Array<"up" | "down" | "left" | "right">>([[id(from), []]]);
  const queue: Cell[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (id(cur) === id(to)) return seen.get(id(cur))!;
    for (const dir of ["up", "down", "left", "right"] as const) {
      const next = step(cur, dir);
      if (seen.has(id(next))) continue;
      seen.set(id(next), [...seen.get(id(cur))!, dir]);
      queue.push(next);
    }
  }
  return [];
}

/** Whether every character can be typed with this keyboard (Russian letters, spaces, a dot). */
export const canType = (text: string): boolean => text.length > 0 && [...text.toLowerCase()].every((ch) => ch === " " || cellOf(ch) !== undefined);

/** The key presses that type `text` (letters of the Russian keyboard and spaces; other characters are dropped), then move to «Поиск». */
export function typeAndSearch(text: string): Move[] {
  const moves: Move[] = [];
  const push = (key: Move["key"]) => {
    const last = moves.at(-1);
    if (last && last.key === key && key !== "ok") last.times++;
    else moves.push({ key, times: 1 });
  };
  let at: Cell = { row: 0, col: 0 };
  for (const ch of text.toLowerCase().replace(/\s+/g, " ").trim()) {
    const to = cellOf(ch === "ё" ? "ё" : ch);
    if (!to) continue;
    for (const dir of path(at, to)) push(dir);
    push("ok");
    at = to;
  }
  for (const dir of path(at, { row: ROWS.length, col: BOTTOM.length - 1 })) push(dir);
  push("ok");
  return moves;
}
