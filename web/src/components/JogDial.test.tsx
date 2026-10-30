import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JogDial } from "./JogDial";

function setup() {
  const onMove = vi.fn();
  const view = render(<JogDial angle={0} onMove={onMove} onCapture={() => {}} capturing={false} />);
  return { onMove, ...view };
}

describe("JogDial hold-to-repeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("moves once on press, then repeats while held", () => {
    const { onMove } = setup();
    fireEvent.pointerDown(screen.getByLabelText("Pan left"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenLastCalledWith("left");
    act(() => vi.advanceTimersByTime(900));
    expect(onMove).toHaveBeenCalledTimes(3);
  });

  it("stops repeating on release", () => {
    const { onMove } = setup();
    fireEvent.pointerDown(screen.getByLabelText("Tilt up"));
    fireEvent.pointerUp(window);
    act(() => vi.advanceTimersByTime(2000));
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("stops repeating when the dial disappears while a side is held", () => {
    const { onMove, unmount } = setup();
    fireEvent.pointerDown(screen.getByLabelText("Pan right"));
    unmount();
    act(() => vi.advanceTimersByTime(3000));
    expect(onMove).toHaveBeenCalledTimes(1); // the camera must not keep turning after the screen is gone
  });

  it("pressing a second side replaces the first instead of repeating both", () => {
    const { onMove } = setup();
    fireEvent.pointerDown(screen.getByLabelText("Pan left"));
    fireEvent.pointerDown(screen.getByLabelText("Tilt down"));
    onMove.mockClear();
    act(() => vi.advanceTimersByTime(450));
    expect(onMove.mock.calls).toEqual([["down"]]);
  });
});
