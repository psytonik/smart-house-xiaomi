import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { AuthError, type PtzPlace } from "./api";
import { gotoNote, usePtz } from "./usePtz";

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getPtzPosition: vi.fn(), gotoPtz: vi.fn(), listPlaces: vi.fn(), savePlace: vi.fn(), removePlace: vi.fn(), goPlace: vi.fn(), calibrateCamera: vi.fn() }));

const door: PtzPlace = { id: "pz-1", name: "Door", angle: 80, elevation: 40 };

beforeEach(() => {
  vi.mocked(api.getPtzPosition).mockResolvedValue({ known: true, angle: 101, elevation: 1 });
  vi.mocked(api.listPlaces).mockResolvedValue([door]);
  vi.mocked(api.gotoPtz).mockResolvedValue({ reached: true, steps: 3 });
  vi.mocked(api.goPlace).mockResolvedValue({ reached: true, steps: 3 });
  vi.mocked(api.calibrateCamera).mockResolvedValue();
  vi.mocked(api.savePlace).mockResolvedValue(door);
  vi.mocked(api.removePlace).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gotoNote", () => {
  it("is empty when the camera got there, and says why when it did not", () => {
    expect(gotoNote({ reached: true, steps: 2 })).toBe("");
    expect(gotoNote({ reached: false, steps: 9, reason: "limit" })).toMatch(/end of its range/);
    expect(gotoNote({ reached: false, steps: 80, reason: "max-steps" })).toMatch(/all the way/);
    expect(gotoNote({ reached: false, steps: 0, reason: "unknown" })).toMatch(/didn't say/);
  });
});

describe("usePtz", () => {
  const open = (onError = vi.fn(), say = vi.fn(), pollMs = 60_000) => ({ onError, say, ...renderHook(() => usePtz(onError, say, pollMs)) });

  it("loads where the camera points and the saved places", async () => {
    const { result } = open();
    await waitFor(() => expect(result.current.position?.angle).toBe(101));
    await waitFor(() => expect(result.current.places).toEqual([door]));
  });

  it("goes to a position: busy meanwhile, then asks the camera where it is", async () => {
    let finish!: () => void;
    vi.mocked(api.gotoPtz).mockReturnValue(new Promise((r) => (finish = () => r({ reached: true, steps: 3 }))));
    const { result } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    act(() => void result.current.goto(60, 30));
    await waitFor(() => expect(result.current.busy).toBe("goto"));
    vi.mocked(api.getPtzPosition).mockClear();
    await act(async () => finish());
    await waitFor(() => expect(result.current.busy).toBeNull());
    expect(api.getPtzPosition).toHaveBeenCalledWith(true);
  });

  it("does not start a second move while one runs", async () => {
    vi.mocked(api.gotoPtz).mockReturnValue(new Promise(() => {}));
    const { result } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    act(() => void result.current.goto(60, 30));
    await waitFor(() => expect(result.current.busy).toBe("goto"));
    act(() => void result.current.goto(10, 10));
    expect(api.gotoPtz).toHaveBeenCalledTimes(1);
  });

  it("tells when the camera stopped short, and when it arrived at a saved place", async () => {
    const { result, say } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    vi.mocked(api.gotoPtz).mockResolvedValue({ reached: false, steps: 9, reason: "limit" });
    await act(async () => void (await result.current.goto(101, 101)));
    expect(say).toHaveBeenCalledWith("The camera stopped at the end of its range");
    await act(async () => void (await result.current.goPlace(door)));
    expect(say).toHaveBeenCalledWith("At Door");
  });

  it("reports an error and frees the controls", async () => {
    vi.mocked(api.gotoPtz).mockRejectedValue(new Error("the camera is busy"));
    const { result, onError } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    await act(async () => void (await result.current.goto(60, 30)));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "the camera is busy" }));
    expect(result.current.busy).toBeNull();
  });

  it("passes a lost sign-in on", async () => {
    vi.mocked(api.getPtzPosition).mockRejectedValue(new AuthError());
    const { onError } = open();
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(AuthError)));
  });

  it("does not bother the person when a reading of the position fails", async () => {
    vi.mocked(api.getPtzPosition).mockRejectedValue(new Error("offline"));
    const { onError, result } = open();
    await new Promise((r) => setTimeout(r, 30));
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.position).toBeNull();
  });

  it("saves and removes places, then reads the list again", async () => {
    const { result, say } = open();
    await waitFor(() => expect(result.current.places).toEqual([door]));
    vi.mocked(api.listPlaces).mockClear();
    await act(async () => void (await result.current.save("Door")));
    expect(api.savePlace).toHaveBeenCalledWith("Door");
    expect(say).toHaveBeenCalledWith("Saved Door");
    await act(async () => void (await result.current.remove(door)));
    expect(api.removePlace).toHaveBeenCalledWith("pz-1");
    expect(api.listPlaces).toHaveBeenCalledTimes(2);
  });

  it("calibrates only when asked", async () => {
    const { result, say } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    expect(api.calibrateCamera).not.toHaveBeenCalled();
    await act(async () => void (await result.current.calibrate()));
    expect(api.calibrateCamera).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("Calibrated");
  });

  it("looks at the position again shortly after a move", async () => {
    const { result } = open();
    await waitFor(() => expect(result.current.position).not.toBeNull());
    vi.useFakeTimers();
    vi.mocked(api.getPtzPosition).mockClear();
    act(() => result.current.soon());
    expect(api.getPtzPosition).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(api.getPtzPosition).toHaveBeenCalledTimes(1);
  });
});
