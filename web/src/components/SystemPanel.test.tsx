import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { SystemHealth } from "../api";
import { SystemPanel } from "./SystemPanel";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), getSystem: vi.fn() }));

const healthy: SystemHealth = {
  level: "ok",
  uptimeSec: 3700,
  checks: [
    { id: "go2rtc", level: "ok", title: "go2rtc is running", detail: "The bridge to the camera answers." },
    { id: "picture", level: "ok", title: "Picture is flowing", detail: "Frames are arriving." },
    { id: "detection", level: "ok", title: "Object detection is on (yolox_tiny.onnx)", detail: "New clips are labelled." },
    { id: "push", level: "info", title: "No phone registered for notifications", detail: "Notifications start once the mobile app registers." },
  ],
};

describe("SystemPanel", () => {
  beforeEach(() => {
    vi.mocked(api.getSystem).mockResolvedValue(healthy);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says all is well and lists every check with a text label, not just a colour", async () => {
    render(<SystemPanel onAuthError={() => {}} />);
    expect(await screen.findByText(/everything is working/i)).toBeTruthy();
    expect(screen.getByText("go2rtc is running")).toBeTruthy();
    expect(screen.getAllByText("OK").length).toBe(3);
    expect(screen.getByText("Note")).toBeTruthy();
  });

  it("puts a problem first and says what to do", async () => {
    vi.mocked(api.getSystem).mockResolvedValue({
      level: "warn",
      uptimeSec: 10,
      checks: [
        { id: "go2rtc", level: "ok", title: "go2rtc is running", detail: "ok" },
        { id: "picture", level: "warn", title: "Damaged picture (240 decoder warnings in the last minute)", detail: "Packets are being lost between the camera and go2rtc." },
      ],
    });
    render(<SystemPanel onAuthError={() => {}} />);
    expect(await screen.findByText(/needs attention/i)).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toMatch(/Damaged picture/);
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText(/Packets are being lost/)).toBeTruthy();
  });

  it("an error is called a problem", async () => {
    vi.mocked(api.getSystem).mockResolvedValue({ level: "error", uptimeSec: 1, checks: [{ id: "go2rtc", level: "error", title: "go2rtc is not reachable", detail: "Start everything with ./camera.sh." }] });
    render(<SystemPanel onAuthError={() => {}} />);
    expect(await screen.findByText(/there is a problem/i)).toBeTruthy();
    expect(screen.getByText("Problem")).toBeTruthy();
  });

  it("shows how long the backend has been up", async () => {
    render(<SystemPanel onAuthError={() => {}} />);
    expect(await screen.findByText(/up 1 h 1 min/i)).toBeTruthy();
  });

  it("keeps the last answer and says so when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SystemPanel onAuthError={() => {}} />);
    await screen.findByText("go2rtc is running");
    vi.mocked(api.getSystem).mockImplementation(() => Promise.reject(new Error("offline")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await waitFor(() => expect(screen.getByText(/couldn't refresh/i)).toBeTruthy());
    expect(screen.getByText("go2rtc is running")).toBeTruthy();
  });

  it("hands an expired login to the app", async () => {
    const onAuthError = vi.fn();
    vi.mocked(api.getSystem).mockImplementation(() => Promise.reject(new api.AuthError()));
    render(<SystemPanel onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });
});
