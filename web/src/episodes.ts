import type { Clip } from "./api";

/**
 * Clips that start within this many seconds after the previous one ended belong to one episode:
 * someone walking about the yard produces several clips, but it is one story.
 */
export const EPISODE_GAP_SEC = 180;

export interface Episode {
  /** Id of the first (oldest) clip. */
  id: string;
  /** Oldest first, the order to watch them in. */
  clips: Clip[];
  count: number;
  startedAt: string;
  endedAt: string;
  /** Sum of the clips' lengths. */
  totalSec: number;
  /** Strongest motion in any clip of the episode, percent. */
  peak: number;
}

const ms = (iso: string) => new Date(iso).getTime();

/** Groups clips (any order) into episodes. The result is newest episode first. */
export function groupEpisodes(clips: Clip[]): Episode[] {
  const oldestFirst = [...clips].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  const groups: Clip[][] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const c of oldestFirst) {
    if (groups.length > 0 && ms(c.startedAt) - lastEnd <= EPISODE_GAP_SEC * 1000) groups[groups.length - 1]!.push(c);
    else groups.push([c]);
    lastEnd = Math.max(lastEnd, ms(c.endedAt));
  }
  return groups
    .map((g) => ({
      id: g[0]!.id,
      clips: g,
      count: g.length,
      startedAt: g[0]!.startedAt,
      endedAt: g.reduce((latest, c) => (ms(c.endedAt) > ms(latest) ? c.endedAt : latest), g[0]!.endedAt),
      totalSec: g.reduce((sum, c) => sum + c.durationSec, 0),
      peak: Math.max(...g.map((c) => c.peak)),
    }))
    .reverse();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a moment, "2026-10-30". */
export function dayKey(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export function dayLabel(key: string, now: Date = new Date()): string {
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return dateFmt.format(new Date(y!, m! - 1, d!));
}

/** Clips of one day; null keeps all. */
export function filterByDay(clips: Clip[], key: string | null): Clip[] {
  return key === null ? clips : clips.filter((c) => dayKey(c.startedAt) === key);
}

export type ObjectLabel = NonNullable<Clip["objects"]>[number]["label"];
/** A kind of object, or "none": analysed and nothing recognised. */
export type ObjectFilter = ObjectLabel | "none";

const ORDER: ObjectLabel[] = ["person", "vehicle", "animal"];

/** Everything recognised in any clip of the episode, in a fixed order. */
export function episodeLabels(episode: Episode): ObjectLabel[] {
  const found = new Set(episode.clips.flatMap((c) => c.objects?.map((o) => o.label) ?? []));
  return ORDER.filter((l) => found.has(l));
}

/** True when at least one clip was analysed, so a "contains" filter means something. */
export function hasAnalysis(clips: Clip[]): boolean {
  return clips.some((c) => c.objects !== undefined);
}

/**
 * Clips that contain the kind of object; "none" keeps clips that were analysed and had nothing in them.
 * A clip that was never analysed matches no kind (it only shows under "All"). Null keeps everything.
 */
export function filterByObject(clips: Clip[], filter: ObjectFilter | null): Clip[] {
  if (filter === null) return clips;
  if (filter === "none") return clips.filter((c) => c.objects !== undefined && c.objects.length === 0);
  return clips.filter((c) => c.objects?.some((o) => o.label === filter));
}
