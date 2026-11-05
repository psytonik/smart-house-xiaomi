import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtzPlace } from "../api";
import { PtzPad, padToPosition, positionToPad } from "./PtzPad";

afterEach(cleanup);

const door: PtzPlace = { id: "pz-1", name: "Door", angle: 80, elevation: 40 };

function setup(over: Partial<React.ComponentProps<typeof PtzPad>> = {}) {
  const props = {
    position: { known: true, angle: 101, elevation: 1 },
    places: [door],
    busy: null,
    onGoto: vi.fn(),
    onGoPlace: vi.fn(),
    onSavePlace: vi.fn(),
    onRemovePlace: vi.fn(),
    onCalibrate: vi.fn(),
    ...over,
  };
  render(<PtzPad {...props} />);
  return props;
}

describe("padToPosition / positionToPad", () => {
  it("left on the map is a high angle, the top is a high elevation (the camera's own directions)", () => {
    expect(padToPosition(0, 0)).toEqual({ angle: 101, elevation: 101 });
    expect(padToPosition(1, 1)).toEqual({ angle: 1, elevation: 1 });
    expect(padToPosition(0.5, 0.5)).toEqual({ angle: 51, elevation: 51 });
  });
  it("stays inside 1..101 even if the click lands a little outside the map", () => {
    expect(padToPosition(-0.2, 1.3)).toEqual({ angle: 101, elevation: 1 });
    expect(padToPosition(1.4, -0.4)).toEqual({ angle: 1, elevation: 101 });
  });
  it("maps back to percentages, and the two agree", () => {
    expect(positionToPad(101, 1)).toEqual({ x: 0, y: 100 });
    expect(positionToPad(1, 101)).toEqual({ x: 100, y: 0 });
    const p = padToPosition(0.3, 0.7);
    const back = positionToPad(p.angle, p.elevation);
    expect(Math.abs(back.x - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.y - 70)).toBeLessThanOrEqual(1);
  });
});

describe("PtzPad", () => {
  it("shows where the camera points, in words", () => {
    setup();
    expect(screen.getByText("Pan 101 · Tilt 1")).toBeTruthy();
  });

  it("says so when the position is not known", () => {
    setup({ position: { known: false } });
    expect(screen.getByText("Position unknown")).toBeTruthy();
  });

  it("moves to the point that was clicked on the map", () => {
    const p = setup();
    const pad = screen.getByRole("button", { name: /map of the camera/i });
    pad.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => ({}) });
    fireEvent.click(pad, { clientX: 200, clientY: 100, detail: 1 }); // the middle
    expect(p.onGoto).toHaveBeenCalledWith(51, 51);
  });

  it("ignores a click that came from the keyboard (it has no position)", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /map of the camera/i }), { clientX: 0, clientY: 0, detail: 0 });
    expect(p.onGoto).not.toHaveBeenCalled();
  });

  it("goes to a saved place by its name", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Door" }));
    expect(p.onGoPlace).toHaveBeenCalledWith(door);
  });

  it("asks before removing a saved place", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove Door" }));
    expect(p.onRemovePlace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Remove Door" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Door" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Door?" }));
    expect(p.onRemovePlace).toHaveBeenCalledWith(door);
  });

  it("saves the current place under the typed name, then clears the field", async () => {
    const p = setup();
    const form = screen.getByRole("form", { name: "Save this place" });
    const input = within(form).getByLabelText("Name this place") as HTMLInputElement;
    expect(within(form).getByRole("button", { name: "Save place" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  Window " } });
    fireEvent.click(within(form).getByRole("button", { name: "Save place" }));
    expect(p.onSavePlace).toHaveBeenCalledWith("Window");
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it("cannot save a place while the position is unknown", () => {
    setup({ position: { known: false } });
    const form = screen.getByRole("form", { name: "Save this place" });
    fireEvent.change(within(form).getByLabelText("Name this place"), { target: { value: "x" } });
    expect(within(form).getByRole("button", { name: "Save place" }).hasAttribute("disabled")).toBe(true);
  });

  it("asks before calibrating, and says what happens", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Calibrate…" }));
    expect(screen.getByText(/sweeps its whole range/i)).toBeTruthy();
    expect(p.onCalibrate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/sweeps its whole range/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Calibrate…" }));
    fireEvent.click(screen.getByRole("button", { name: "Calibrate" }));
    expect(p.onCalibrate).toHaveBeenCalledTimes(1);
  });

  it("is locked while the camera is moving, and says so", () => {
    setup({ busy: "goto" });
    expect(screen.getByRole("button", { name: /map of the camera/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Door" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Moving/);
  });

  it("says when it is calibrating", () => {
    setup({ busy: "calibrate" });
    expect(screen.getByRole("status").textContent).toMatch(/Calibrating/);
  });

  it("explains when there are no saved places yet", () => {
    setup({ places: [] });
    expect(screen.getByText(/No saved places yet/)).toBeTruthy();
  });
});
