import { describe, expect, it } from "vitest";
import type { Clip } from "./api";
import { EPISODE_GAP_SEC, dayKey, dayLabel, episodeLabels, filterByDay, filterByObject, groupEpisodes, hasAnalysis } from "./episodes";

/** A clip that starts at the given local time on 30 Oct 2026 and lasts `sec` seconds. */
function clip(id: string, h: number, m: number, s: number, sec = 20, day = 30): Clip {
  const start = new Date(2026, 9, day, h, m, s);
  return {
    id,
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + sec * 1000).toISOString(),
    durationSec: sec,
    peak: 3,
    bytes: 1_000_000,
    clip: `${id}.mp4`,
    thumb: `${id}.jpg`,
    clipUrl: `/api/events/${id}/clip`,
    thumbUrl: `/api/events/${id}/thumb`,
  };
}

describe("groupEpisodes", () => {
  it("puts clips that follow each other closely into one episode, oldest clip first inside", () => {
    // newest first, as the API returns them
    const clips = [clip("c", 14, 33, 0), clip("b", 14, 31, 30), clip("a", 14, 30, 0)];
    const [ep, ...rest] = groupEpisodes(clips);
    expect(rest).toEqual([]);
    expect(ep!.clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(ep!.count).toBe(3);
  });

  it("starts a new episode after a long quiet gap, newest episode first", () => {
    const eps = groupEpisodes([clip("late", 16, 0, 0), clip("b", 14, 31, 30), clip("a", 14, 30, 0)]);
    expect(eps.map((e) => e.clips.map((c) => c.id))).toEqual([["late"], ["a", "b"]]);
  });

  it("the gap is measured from the END of the previous clip, and a gap of exactly the limit still joins", () => {
    const first = clip("a", 14, 0, 0, 60); // ends 14:01:00
    const joined = clip("b", 14, 1 + EPISODE_GAP_SEC / 60, 0); // starts exactly EPISODE_GAP_SEC later
    const apart = clip("c", 14, 1 + EPISODE_GAP_SEC / 60 + 1, 1);
    expect(groupEpisodes([joined, first])).toHaveLength(1);
    expect(groupEpisodes([apart, first])).toHaveLength(2);
  });

  it("sums up an episode: span, total video length, strongest motion", () => {
    const a = { ...clip("a", 14, 30, 0, 20), peak: 2 };
    const b = { ...clip("b", 14, 31, 0, 40), peak: 9 };
    const [ep] = groupEpisodes([b, a]);
    expect(ep!.startedAt).toBe(a.startedAt);
    expect(ep!.endedAt).toBe(b.endedAt);
    expect(ep!.totalSec).toBe(60);
    expect(ep!.peak).toBe(9);
    expect(ep!.id).toBe("a");
  });

  it("copes with no clips, one clip, and clips handed over in the wrong order", () => {
    expect(groupEpisodes([])).toEqual([]);
    expect(groupEpisodes([clip("a", 14, 0, 0)])[0]!.count).toBe(1);
    const shuffled = groupEpisodes([clip("a", 14, 30, 0), clip("c", 14, 33, 0), clip("b", 14, 31, 30)]);
    expect(shuffled[0]!.clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("days", () => {
  const now = new Date(2026, 9, 30, 15, 0, 0);

  it("keys a clip by its local calendar day", () => {
    expect(dayKey(clip("a", 23, 59, 0).startedAt)).toBe("2026-10-30");
    expect(dayKey(clip("a", 0, 1, 0).startedAt)).toBe("2026-10-30");
    expect(dayKey(clip("a", 12, 0, 0, 20, 29).startedAt)).toBe("2026-10-29");
  });

  it("calls the days Today and Yesterday, and dates the rest", () => {
    expect(dayLabel("2026-10-30", now)).toBe("Today");
    expect(dayLabel("2026-10-29", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-25", now)).toMatch(/25/);
  });

  it("filters clips to one day, or keeps all", () => {
    const clips = [clip("a", 10, 0, 0, 20, 30), clip("b", 10, 0, 0, 20, 29)];
    expect(filterByDay(clips, "2026-10-30").map((c) => c.id)).toEqual(["a"]);
    expect(filterByDay(clips, null)).toHaveLength(2);
  });
});

describe("objects in clips", () => {
  const seen = (id: string, objects?: Clip["objects"]): Clip => ({ ...clip(id, 14, 0, 0), objects });

  it("lists what an episode contains, merged over its clips, in a fixed order", () => {
    const [ep] = groupEpisodes([
      { ...clip("b", 14, 1, 0), objects: [{ label: "vehicle", score: 0.7 }] },
      { ...clip("a", 14, 0, 0), objects: [{ label: "person", score: 0.9 }, { label: "vehicle", score: 0.5 }] },
    ]);
    expect(episodeLabels(ep!)).toEqual(["person", "vehicle"]);
  });

  it("an episode with nothing analysed has no labels", () => {
    expect(episodeLabels(groupEpisodes([clip("a", 14, 0, 0)])[0]!)).toEqual([]);
  });

  it("filters clips by what they contain; 'none' means analysed and empty, not 'unknown'", () => {
    const clips = [seen("p", [{ label: "person", score: 0.9 }]), seen("c", [{ label: "vehicle", score: 0.8 }]), seen("e", []), seen("u", undefined)];
    expect(filterByObject(clips, null).map((c) => c.id)).toEqual(["p", "c", "e", "u"]);
    expect(filterByObject(clips, "person").map((c) => c.id)).toEqual(["p"]);
    expect(filterByObject(clips, "vehicle").map((c) => c.id)).toEqual(["c"]);
    expect(filterByObject(clips, "animal")).toEqual([]);
    expect(filterByObject(clips, "none").map((c) => c.id)).toEqual(["e"]);
  });

  it("knows whether any clip was analysed at all", () => {
    expect(hasAnalysis([seen("u")])).toBe(false);
    expect(hasAnalysis([seen("u"), seen("e", [])])).toBe(true);
  });
});
