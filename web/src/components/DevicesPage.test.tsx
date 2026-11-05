import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { AuthError, type Device, type Found } from "../api";
import { DevicesPage, cloudNote, deviceLine } from "./DevicesPage";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), getDevices: vi.fn(), scanDevices: vi.fn(), addFoundDevice: vi.fn(), addManualDevice: vi.fn(), updateDevice: vi.fn(), removeDevice: vi.fn() }));

const env: Device = { id: "env-vacuum", kind: "vacuum", protocol: "miio", name: "Vacuum", host: "10.0.0.7", origin: "env", hasToken: true, editable: false };
const lamp: Device = { id: "dev-1", kind: "light", protocol: "cozylife", name: "Desk lamp", room: "Office", host: "10.0.0.20", origin: "discovered", hasToken: false, editable: true };
const plug: Found = { key: "miio:444", protocol: "miio", kind: "plug", host: "10.0.0.30", name: "Xiaomi 0444", seen: true, hasToken: false, known: false };
const oldOne: Found = { key: "miio:111", protocol: "miio", kind: "vacuum", host: "10.0.0.7", name: "Dreame", seen: true, hasToken: true, known: true };

const open = () => render(<DevicesPage onLogout={onLogout} />);
let onLogout: () => void;

beforeEach(() => {
  onLogout = vi.fn();
  vi.mocked(api.getDevices).mockResolvedValue([env, lamp]);
  vi.mocked(api.scanDevices).mockResolvedValue({ candidates: [oldOne, plug], cloud: "ok" });
  vi.mocked(api.addFoundDevice).mockResolvedValue({ ...lamp, id: "dev-2", name: "Hall plug" });
  vi.mocked(api.addManualDevice).mockResolvedValue(lamp);
  vi.mocked(api.updateDevice).mockResolvedValue(lamp);
  vi.mocked(api.removeDevice).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("deviceLine and cloudNote", () => {
  it("joins the known facts in one line", () => {
    expect(deviceLine({ kind: "light", room: "Office", host: "10.0.0.20" })).toBe("Light · Office · 10.0.0.20");
    expect(deviceLine({ kind: "tv" })).toBe("TV");
  });
  it("says nothing when the account answered, and explains when it did not", () => {
    expect(cloudNote({ candidates: [], cloud: "ok" })).toBeNull();
    expect(cloudNote({ candidates: [], cloud: "not-signed-in" })).toMatch(/Sign in/);
    expect(cloudNote({ candidates: [], cloud: "unavailable", cloudMessage: "refused" })).toMatch(/refused/);
  });
});

describe("DevicesPage", () => {
  it("lists the devices; the ones set in .env cannot be changed here", async () => {
    open();
    expect(await screen.findByText("Desk lamp")).toBeTruthy();
    expect(screen.getByText("Light · Office · 10.0.0.20")).toBeTruthy();
    expect(screen.getByText(/Set in backend\/\.env/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Vacuum" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Vacuum" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Desk lamp" })).toBeTruthy();
  });

  it("searches and offers only the devices that are not in the list yet", async () => {
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    expect(await screen.findByRole("form", { name: "Add Xiaomi 0444" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add Dreame" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search again" })).toBeTruthy();
  });

  it("says when nothing is new", async () => {
    vi.mocked(api.scanDevices).mockResolvedValue({ candidates: [oldOne], cloud: "ok" });
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    expect((await screen.findByText(/Nothing new/)).textContent).toMatch(/1 found is already in the list/);
  });

  it("explains a missing Xiaomi sign-in next to the results", async () => {
    vi.mocked(api.scanDevices).mockResolvedValue({ candidates: [plug], cloud: "not-signed-in" });
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    expect((await screen.findByText(/Not signed in to Xiaomi/)).getAttribute("role")).toBe("status");
  });

  it("adds a found device with the name and room typed in, and takes it off the offer", async () => {
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Find devices" }));
    const form = await screen.findByRole("form", { name: "Add Xiaomi 0444" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Hall plug" } });
    fireEvent.change(within(form).getByLabelText("Room"), { target: { value: "Hall" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.addFoundDevice).toHaveBeenCalledWith("miio:444", "Hall plug", "Hall"));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add Xiaomi 0444" })).toBeNull());
    expect(api.getDevices).toHaveBeenCalledTimes(2); // the list was read again
  });

  it("asks twice before removing", async () => {
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Remove Desk lamp" }));
    expect(api.removeDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Remove Desk lamp" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Desk lamp" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Desk lamp?" }));
    await waitFor(() => expect(api.removeDevice).toHaveBeenCalledWith("dev-1"));
  });

  it("renames a device and sets its room", async () => {
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Edit Desk lamp" }));
    const form = screen.getByRole("form", { name: "Edit Desk lamp" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Reading lamp" } });
    fireEvent.change(within(form).getByLabelText("Room"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateDevice).toHaveBeenCalledWith("dev-1", { name: "Reading lamp", room: "" }));
  });

  it("adds a device by hand", async () => {
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Strip" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "192.168.1.50" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "light" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.addManualDevice).toHaveBeenCalledWith({ kind: "light", protocol: "other", name: "Strip", host: "192.168.1.50" }));
  });

  it("shows the server's reason when something is refused", async () => {
    vi.mocked(api.addManualDevice).mockRejectedValue(new Error("host must be an address of the home network"));
    open();
    await screen.findByText("Desk lamp");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "8.8.8.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("host must be an address of the home network")).toBeTruthy();
  });

  it("signs out when the token is no longer accepted", async () => {
    vi.mocked(api.getDevices).mockRejectedValue(new AuthError());
    open();
    await waitFor(() => expect(onLogout).toHaveBeenCalled());
  });
});
