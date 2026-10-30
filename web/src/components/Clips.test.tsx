import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { Clip } from "../api";
import { Clips } from "./Clips";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), deleteClip: vi.fn() }));

function clip(id: string, h: number, m: number, day = 30, sec = 20, objects?: Clip["objects"]): Clip {
  const start = new Date(2026, 9, day, h, m, 0);
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
    objects,
  };
}

// newest first: c, b close together (one episode); a an hour earlier; z yesterday
const CLIPS = [clip("c", 15, 2), clip("b", 15, 0), clip("a", 14, 0), clip("z", 9, 0, 29)];

function setup(clips = CLIPS) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  const onChanged = vi.fn();
  render(<Clips clips={clips} motion={null} onChanged={onChanged} onError={() => {}} />);
  return { onChanged };
}

describe("Clips as episodes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 30, 16, 0, 0));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows one card per episode and says how many clips are in it", () => {
    setup();
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(3); // {b,c}, {a}, {z}
    expect(within(cards[0]!).getByText(/2 clips/i)).toBeTruthy();
    expect(within(cards[1]!).queryByText(/clips/i)).toBeNull();
  });

  it("filters by day, with Today and Yesterday and an All choice", () => {
    setup();
    const days = screen.getByRole("radiogroup", { name: /day/i });
    expect(within(days).getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(days).getByRole("radio", { name: "Yesterday" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(days).getByRole("radio", { name: "Today" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not offer a day filter when everything is from one day", () => {
    setup([clip("a", 14, 0), clip("b", 15, 0)]);
    expect(screen.queryByRole("radiogroup", { name: /day/i })).toBeNull();
  });

  it("opens the first clip of an episode and steps through the others", () => {
    setup();
    fireEvent.click(screen.getAllByRole("button", { name: /play/i })[0]!);
    const dlg = document.querySelector("dialog.viewer")!;
    expect(within(dlg as HTMLElement).getByText(/clip 1 of 2/i)).toBeTruthy();
    expect(dlg.querySelector("video")!.getAttribute("src")).toBe("/api/events/b/clip");
    fireEvent.click(within(dlg as HTMLElement).getByRole("button", { name: /next clip/i }));
    expect(within(dlg as HTMLElement).getByText(/clip 2 of 2/i)).toBeTruthy();
    expect(dlg.querySelector("video")!.getAttribute("src")).toBe("/api/events/c/clip");
    expect((within(dlg as HTMLElement).getByRole("button", { name: /next clip/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a single clip opens without episode controls", () => {
    setup([clip("a", 14, 0)]);
    fireEvent.click(screen.getByRole("button", { name: /play/i }));
    const dlg = document.querySelector("dialog.viewer") as HTMLElement;
    expect(within(dlg).queryByRole("button", { name: /next clip/i })).toBeNull();
  });

  it("deleting one clip of an episode moves on to the next and refreshes the list", async () => {
    vi.mocked(api.deleteClip).mockResolvedValue(undefined);
    const { onChanged } = setup();
    fireEvent.click(screen.getAllByRole("button", { name: /play/i })[0]!);
    const dlg = document.querySelector("dialog.viewer") as HTMLElement;
    fireEvent.click(within(dlg).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dlg).getByRole("button", { name: /delete for good/i }));
    await waitFor(() => expect(api.deleteClip).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(within(dlg).getByText(/clip 1 of 1/i)).toBeTruthy());
    expect(dlg.querySelector("video")!.getAttribute("src")).toBe("/api/events/c/clip");
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("Clips with recognised objects", () => {
  const labelled = [clip("c", 15, 2, 30, 20, [{ label: "person", score: 0.9 }]), clip("b", 14, 0, 30, 20, []), clip("a", 12, 0, 30, 20, [{ label: "animal", score: 0.7 }])];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 30, 16, 0, 0));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows what was seen on each card, in words", () => {
    setup(labelled);
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]!).getByText("Person")).toBeTruthy();
    expect(within(cards[2]!).getByText("Animal")).toBeTruthy();
    expect(within(cards[1]!).queryByText(/person|animal/i)).toBeNull();
  });

  it("filters by what the clips contain, including 'Nothing found'", () => {
    setup(labelled);
    const group = screen.getByRole("radiogroup", { name: /contains/i });
    fireEvent.click(within(group).getByRole("radio", { name: "People" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(group).getByRole("radio", { name: "Nothing found" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(group).getByRole("radio", { name: "All" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("offers no 'contains' filter when no clip was ever analysed", () => {
    setup();
    expect(screen.queryByRole("radiogroup", { name: /contains/i })).toBeNull();
  });
});
