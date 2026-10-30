import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Zone } from "../api";
import * as api from "../api";
import { ZoneEditor } from "./ZoneEditor";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getZones: vi.fn(),
  saveZones: vi.fn(),
  fetchFrame: vi.fn(),
  getMotion: vi.fn(),
}));

const clock: Zone = { id: "clock", mode: "ignore", x: 0.65, y: 0, w: 0.35, h: 0.12 };

function open(onClose = vi.fn()) {
  // jsdom has no <dialog> behaviour
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  render(<ZoneEditor onClose={onClose} onAuthError={() => {}} onError={() => {}} onSaved={() => {}} />);
  return onClose;
}

describe("ZoneEditor", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(api.fetchFrame).mockResolvedValue(new Blob(["x"]));
    vi.mocked(api.getMotion).mockResolvedValue({ enabled: true, state: "running", recording: false, level: 0.4, threshold: 1.2 });
    vi.mocked(api.getZones).mockResolvedValue([clock]);
    vi.mocked(api.saveZones).mockImplementation(async (z) => z);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the saved zones with their kind", async () => {
    open();
    expect(await screen.findByText(/clock/i)).toBeTruthy();
    expect(screen.getAllByText(/ignore/i).length).toBeGreaterThan(0);
  });

  it("a corner preset adds a zone, and saving sends the whole list", async () => {
    open();
    await screen.findByText(/clock/i);
    fireEvent.click(screen.getByRole("button", { name: /top left/i }));
    fireEvent.click(screen.getByRole("button", { name: /save zones/i }));
    await waitFor(() => expect(api.saveZones).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.saveZones).mock.calls[0]![0];
    expect(sent).toHaveLength(2);
    expect(sent.map((z) => z.id)).toContain("clock");
  });

  it("a privacy zone can be added with the third kind, and is listed as hidden", async () => {
    open();
    await screen.findByText(/clock/i);
    fireEvent.click(screen.getByRole("radio", { name: /hide/i }));
    fireEvent.click(screen.getByRole("button", { name: /bottom right/i }));
    expect(screen.getByText(/zone-1 · hidden/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /save zones/i }));
    await waitFor(() => expect(api.saveZones).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveZones).mock.calls[0]![0].find((z) => z.id === "zone-1")!.mode).toBe("privacy");
  });

  it("tells the saved zones back to the app, so the live view can hide the private ones at once", async () => {
    const onSaved = vi.fn();
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    render(<ZoneEditor onClose={() => {}} onAuthError={() => {}} onError={() => {}} onSaved={onSaved} />);
    await screen.findByText(/clock/i);
    fireEvent.click(screen.getByRole("button", { name: /save zones/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([clock]));
  });

  it("removing a zone and saving sends the shorter list", async () => {
    open();
    await screen.findByText(/clock/i);
    fireEvent.click(screen.getByRole("button", { name: /remove clock/i }));
    fireEvent.click(screen.getByRole("button", { name: /save zones/i }));
    await waitFor(() => expect(api.saveZones).toHaveBeenCalledWith([]));
  });

  it("shows the live motion level against the threshold", async () => {
    open();
    const meter = await screen.findByRole("meter");
    await waitFor(() => expect(meter.getAttribute("aria-valuenow")).toBe("0.4"));
    expect(meter.getAttribute("aria-valuetext")).toMatch(/0\.4.*1\.2/);
  });
});
