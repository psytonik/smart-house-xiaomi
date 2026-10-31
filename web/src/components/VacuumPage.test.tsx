import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { FloorPlan, VacuumPage } from "./VacuumPage";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), getVacuum: vi.fn(), sendVacuum: vi.fn(), fetchVacuumMap: vi.fn(), refreshVacuumMap: vi.fn(), getVacuumLive: vi.fn(), sendCleaningMode: vi.fn(), getVacuumCare: vi.fn(), getVacuumHistory: vi.fn(), resetVacuumPart: vi.fn(), getVacuumSettings: vi.fn(), getVacuumRooms: vi.fn(), cleanVacuumRooms: vi.fn(), sendVacuumSwitch: vi.fn(), sendSuction: vi.fn(), sendWater: vi.fn() }));

describe("VacuumPage", () => {
  beforeEach(() => {
    vi.mocked(api.sendVacuum).mockResolvedValue();
    vi.mocked(api.fetchVacuumMap).mockResolvedValue(null);
    vi.mocked(api.sendCleaningMode).mockResolvedValue();
    vi.mocked(api.sendSuction).mockResolvedValue();
    vi.mocked(api.sendWater).mockResolvedValue();
    vi.mocked(api.getVacuumCare).mockRejectedValue(new Error("no care"));
    vi.mocked(api.getVacuumSettings).mockRejectedValue(new Error("no settings"));
    vi.mocked(api.getVacuumRooms).mockResolvedValue([]);
    vi.mocked(api.cleanVacuumRooms).mockResolvedValue();
    vi.mocked(api.sendVacuumSwitch).mockResolvedValue();
    vi.mocked(api.getVacuumHistory).mockRejectedValue(new Error("no history"));
    vi.mocked(api.refreshVacuumMap).mockResolvedValue();
    vi.mocked(api.getVacuumLive).mockResolvedValue({ map: { width: 10, height: 20 }, robot: { x: 3, y: 4 }, trail: [{ x: 1, y: 1 }, { x: 3, y: 4 }], ageSeconds: 1, live: true });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows battery, state and what the robot is", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({
      configured: true,
      reachable: true,
      battery: 78,
      mode: "charging",
      model: "dreame.vacuum.p2028a",
      firmware: "4.1.8_1156",
      areaM2: 5,
      minutes: 4,
      cleaningMode: "both",
    });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText("Charging")).toBeTruthy();
    expect(screen.getByText(/Battery/).textContent).toContain("Battery");
    expect(document.querySelector(".dial-value")?.textContent).toBe("Battery 78% percent");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(screen.getByText("dreame.vacuum.p2028a")).toBeTruthy();
    expect(screen.getByText("4.1.8_1156")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Sweep and mop" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("5 m² in 4 min")).toBeTruthy();
    expect(screen.getByText("Last cleaning")).toBeTruthy();
    // already on the dock: nothing to send home
    expect((screen.getByRole("button", { name: "Go home" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows brush and filter wear and the lifetime totals", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 78, mode: "charging" });
    vi.mocked(api.getVacuumCare).mockResolvedValue({
      mainBrush: { percent: 80, hoursLeft: 241 },
      sideBrush: { percent: 10, hoursLeft: 20 },
      filter: { percent: 61, hoursLeft: 91 },
      totals: { cleanings: 158, areaM2: 1420, minutes: 2789, firstCleanAt: "2024-01-22T17:16:52.000Z" },
    });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText("80% left, about 241 h")).toBeTruthy();
    expect(screen.getByText("10% left, about 20 h, replace soon")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Filter" }).getAttribute("value")).toBe("61");
    expect(screen.getByText("158")).toBeTruthy();
    expect(screen.getByText("1420 m²")).toBeTruthy();
    expect(screen.getByText("46 h 29 min")).toBeTruthy();
  });

  it("lists the recent cleanings, and shows nothing when the cloud has none", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 78, mode: "charging" });
    vi.mocked(api.getVacuumHistory).mockResolvedValue([
      { startedAt: "2026-10-30T20:01:37.000Z", minutes: 25, areaM2: 9 },
      { startedAt: "2026-10-30T19:38:48.000Z", minutes: 21, areaM2: 8 },
    ]);
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText("Recent cleanings")).toBeTruthy();
    expect(screen.getByText("9 m² in 25 min")).toBeTruthy();
    expect(screen.getByText("8 m² in 21 min")).toBeTruthy();

    cleanup();
    vi.mocked(api.getVacuumHistory).mockResolvedValue([]);
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByText("Charging");
    expect(screen.queryByText("Recent cleanings")).toBeNull();
  });

  it("starts cleaning, and the same button becomes Pause while it works", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start cleaning" }));
    await waitFor(() => expect(api.sendVacuum).toHaveBeenCalledWith("start"));

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "cleaning" });
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.sendVacuum).toHaveBeenCalledWith("pause"));
  });

  it("empties the bin from the dock, and only while the robot is on it", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 100, mode: "charged", dustStation: { autoEmpty: true, ready: true, emptying: false, limited: false } });
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Empty the bin" }));
    await waitFor(() => expect(api.sendVacuum).toHaveBeenCalledWith("empty"));

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "cleaning", dustStation: { autoEmpty: true, ready: false, emptying: false, limited: false } });
    render(<VacuumPage onLogout={() => {}} />);
    expect(((await screen.findByRole("button", { name: "Empty the bin" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/when the robot is on its dock/)).toBeTruthy();

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 100, mode: "charged", dustStation: { autoEmpty: true, ready: true, emptying: true, limited: false } });
    render(<VacuumPage onLogout={() => {}} />);
    expect(((await screen.findByRole("button", { name: "Emptying the bin…" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what is wrong and what to do, and what the dock won't do", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 40, mode: "error", fault: { code: 12, title: "Main brush is tangled", hint: "Take the main brush out." } });
    render(<VacuumPage onLogout={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Main brush is tangled");
    expect(screen.getByText("Take the main brush out.")).toBeTruthy();

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 100, mode: "charged", dustStation: { autoEmpty: true, ready: false, emptying: false, limited: true } });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText(/won't empty the bin again so soon/)).toBeTruthy();
  });

  it("asks before it tells the robot a part is new, then reads the wear again", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    const wear = (p: number) => ({ mainBrush: { percent: p, hoursLeft: 100 }, sideBrush: { percent: 100 }, filter: { percent: 61 }, totals: {} });
    vi.mocked(api.resetVacuumPart).mockResolvedValue();
    vi.mocked(api.getVacuumCare).mockResolvedValueOnce(wear(10)).mockResolvedValue(wear(100));
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Main brush replaced" }));
    expect(api.resetVacuumPart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.resetVacuumPart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Main brush replaced" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, it's new" }));
    await waitFor(() => expect(api.resetVacuumPart).toHaveBeenCalledWith("mainBrush"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Main brush replaced" })).toBeNull()); // at 100% there is nothing to reset
  });

  it("shows the robot's settings and switches one, then shows what the robot really has", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    const settings = (childLock: boolean) => ({ resumeCleaning: true, carpetBoost: true, obstacleAvoidance: true, customizedCleaning: true, childLock, carpetSensitivity: "high" as const, dnd: { enabled: true, from: "22:00", to: "08:00" }, volume: 100 });
    vi.mocked(api.getVacuumSettings).mockResolvedValueOnce(settings(false)).mockResolvedValue(settings(true));
    render(<VacuumPage onLogout={() => {}} />);
    const lock = (await screen.findByRole("switch", { name: "Child lock" })) as HTMLButtonElement;
    expect(lock.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Do not disturb" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/22:00 to 08:00/)).toBeTruthy();
    expect(screen.getByText("On, suction and water are kept per room")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(lock);
    await waitFor(() => expect(api.sendVacuumSwitch).toHaveBeenCalledWith("childLock", true));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Child lock" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("says why when the robot refuses a setting, and keeps showing its own value", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.getVacuumSettings).mockResolvedValue({ carpetBoost: true });
    vi.mocked(api.sendVacuumSwitch).mockRejectedValue(new Error("the vacuum kept its old setting"));
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Carpet boost" }));
    expect(await screen.findByText(/kept its old setting/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Carpet boost" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Child lock" })).toBeNull(); // not reported: not shown
  });

  it("offers to reset the sensors counter after wiping them", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.getVacuumCare).mockResolvedValue({ mainBrush: { percent: 100 }, sideBrush: { percent: 100 }, filter: { percent: 100 }, sensor: { percent: 58, hoursLeft: 17 }, totals: {} });
    vi.mocked(api.resetVacuumPart).mockResolvedValue();
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText("58% left, about 17 h")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sensors cleaned" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, wiped" }));
    await waitFor(() => expect(api.resetVacuumPart).toHaveBeenCalledWith("sensor"));
  });

  it("cleans the picked rooms in the order they were picked", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.getVacuumRooms).mockResolvedValue([{ id: 1, name: "Kitchen", areaM2: 9 }, { id: 3, name: "Bathroom", areaM2: 4 }, { id: 4, name: "Corridor", areaM2: 6 }]);
    render(<VacuumPage onLogout={() => {}} />);
    const start = (await screen.findByRole("button", { name: "Pick the rooms to clean" })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Corridor/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Kitchen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clean 2 rooms" }));
    await waitFor(() => expect(api.cleanVacuumRooms).toHaveBeenCalledWith([4, 1]));
    expect(await screen.findByText("Cleaning 2 rooms")).toBeTruthy();
  });

  it("shows no rooms when the robot has none to pick, and locks them while it works", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByRole("button", { name: "Start cleaning" });
    expect(screen.queryByText("Rooms")).toBeNull();

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "cleaning" });
    vi.mocked(api.getVacuumRooms).mockResolvedValue([{ id: 1, name: "Kitchen", areaM2: 9 }, { id: 3, name: "Bathroom", areaM2: 4 }]);
    render(<VacuumPage onLogout={() => {}} />);
    expect(((await screen.findByRole("checkbox", { name: /Kitchen/ })) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/The robot is busy/)).toBeTruthy();
  });

  it("has no empty button for a robot without a dust station", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 100, mode: "charged" });
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByText("Charged, at the dock");
    expect(screen.queryByRole("button", { name: /empty the bin/i })).toBeNull();
  });

  it("shows suction and water and changes them, and says why when the robot keeps its own", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle", suction: "turbo", water: "high" });
    render(<VacuumPage onLogout={() => {}} />);
    const suction = await screen.findByRole("radiogroup", { name: "Suction" });
    const water = screen.getByRole("radiogroup", { name: "Water" });
    expect(suction.querySelector('[aria-checked="true"]')?.textContent).toBe("Turbo");
    expect(water.querySelector('[aria-checked="true"]')?.textContent).toBe("High");

    fireEvent.click(screen.getByRole("radio", { name: "Quiet" }));
    await waitFor(() => expect(api.sendSuction).toHaveBeenCalledWith("quiet"));
    fireEvent.click(screen.getByRole("radio", { name: "Low" }));
    await waitFor(() => expect(api.sendWater).toHaveBeenCalledWith("low"));

    vi.mocked(api.sendWater).mockRejectedValue(new Error("the vacuum kept its old setting: Customized Cleaning is probably on"));
    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    expect(await screen.findByText(/Customized Cleaning is probably on/)).toBeTruthy();
  });

  it("leaves suction and water out when the robot doesn't report them, and lets them be changed while it cleans (it resets them to the maximum when a cleaning starts)", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByText("Waiting");
    expect(screen.queryByRole("radiogroup", { name: "Suction" })).toBeNull();

    cleanup();
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "cleaning", suction: "strong", water: "medium" });
    render(<VacuumPage onLogout={() => {}} />);
    expect(((await screen.findByRole("radio", { name: "Turbo" })) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Quiet" }));
    await waitFor(() => expect(api.sendSuction).toHaveBeenCalledWith("quiet"));
  });

  it("makes the robot call out so it can be found", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find the robot" }));
    await waitFor(() => expect(api.sendVacuum).toHaveBeenCalledWith("find"));
  });

  it("offers Resume after a pause", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "paused" });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("explains an unreachable vacuum and lets you try again", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: false });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText(/isn't answering/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.getVacuum).toHaveBeenCalledTimes(2));
  });

  it("tells you how to set it up when it isn't configured", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: false });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByText(/VACUUM_TOKEN/)).toBeTruthy();
  });

  it("shows the error when a command fails", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.sendVacuum).mockRejectedValue(new Error("the vacuum could not start (code -1)"));
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start cleaning" }));
    expect(await screen.findByText(/could not start/)).toBeTruthy();
  });

  it("shows the floor plan when there is one, and nothing when there isn't", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByText("Waiting");
    expect(screen.queryByRole("img", { name: /floor plan/i })).toBeNull();
    cleanup();

    vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const made = vi.fn(() => "blob:plan");
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: made, revokeObjectURL: revoked });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByRole("img", { name: /floor plan/i })).toBeTruthy();
    cleanup();
    expect(revoked).toHaveBeenCalledWith("blob:plan");
  });

  it("doesn't offer to start while the robot reports an error", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 50, mode: "error" });
    render(<VacuumPage onLogout={() => {}} />);
    const button = (await screen.findByRole("button", { name: "Start cleaning" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
  });

  it("switches the cleaning mode", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "charging", cleaningMode: "both" });
    render(<VacuumPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Mopping" }));
    await waitFor(() => expect(api.sendCleaningMode).toHaveBeenCalledWith("mopping"));
    // choosing the mode that is already set sends nothing
    vi.mocked(api.sendCleaningMode).mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Sweep and mop" }));
    expect(api.sendCleaningMode).not.toHaveBeenCalled();
  });

  it("keeps the mode fixed while the robot is cleaning", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "cleaning", cleaningMode: "both" });
    render(<VacuumPage onLogout={() => {}} />);
    const radio = (await screen.findByRole("radio", { name: "Mopping" })) as HTMLButtonElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText(/when the robot isn't cleaning/i)).toBeTruthy();
  });

  it("draws the floor plan by itself when the page opens", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    // nothing saved at first; after the automatic redraw the new picture is there, with no button pressed
    vi.mocked(api.fetchVacuumMap).mockResolvedValueOnce(null).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fresh"), revokeObjectURL: vi.fn() });
    render(<VacuumPage onLogout={() => {}} />);
    expect(await screen.findByRole("img", { name: /floor plan/i })).toBeTruthy();
    expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1);
    expect(api.fetchVacuumMap).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("Floor plan updated")).toBeNull(); // the automatic kind says nothing
    expect(screen.getByText(/redraws itself when you open this page/)).toBeTruthy();
  });

  it("still redraws the floor plan when the button is pressed, and says so", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fresh"), revokeObjectURL: vi.fn() });
    render(<VacuumPage onLogout={() => {}} />);
    await screen.findByRole("img", { name: /floor plan/i });
    await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Update the map" }));
    expect(await screen.findByText("Floor plan updated")).toBeTruthy();
    expect(api.refreshVacuumMap).toHaveBeenCalledTimes(2);
  });

  it("ignores presses while a redraw is already running, and keeps the button focusable", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    let finish: () => void = () => {};
    vi.mocked(api.refreshVacuumMap).mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<VacuumPage onLogout={() => {}} />);
    const button = await screen.findByRole("button", { name: "Load the map" });
    // the automatic redraw from opening the page is the one running
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("false"));
  });

  it("tells you why the floor plan could not be updated by itself, and why a button press failed", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 90, mode: "idle" });
    vi.mocked(api.refreshVacuumMap).mockRejectedValue(new Error("not signed in to Xiaomi yet: run tools/xiaomi-cloud.ts login"));
    const { container } = render(<VacuumPage onLogout={() => {}} />);
    const message = await screen.findByText(/Couldn't update the map by itself: not signed in to Xiaomi/);
    expect(message.getAttribute("role")).toBe("status"); // announced by a screen reader when it appears
    expect(container.querySelector(".plan-problem")).toBe(message);
    expect(screen.getByRole("button", { name: "Load the map" }).getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Load the map" }));
    // the caption keeps saying it, and now the toast says it too
    await waitFor(() => expect(screen.getAllByText(/not signed in to Xiaomi/)).toHaveLength(2));
  });

  it("draws the robot and its trail on the floor plan while it moves", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "cleaning" });
    vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:plan"), revokeObjectURL: vi.fn() });
    const { container } = render(<VacuumPage onLogout={() => {}} />);
    await screen.findByRole("img", { name: /floor plan/i });
    await waitFor(() => expect(container.querySelector("svg.plan-live circle.plan-robot")).not.toBeNull());
    expect(container.querySelector("svg.plan-live")?.getAttribute("viewBox")).toBe("0 0 10 20");
    expect(container.querySelector("svg.plan-live circle")?.getAttribute("cx")).toBe("3.5");
    expect(container.querySelector("svg.plan-live polyline")?.getAttribute("points")).toBe("1.5,1.5 3.5,4.5");
    expect(container.querySelector("svg.plan-live")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("asks nothing and draws nothing while the robot is parked", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "charging" });
    vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:plan"), revokeObjectURL: vi.fn() });
    const { container } = render(<VacuumPage onLogout={() => {}} />);
    await screen.findByRole("img", { name: /floor plan/i });
    expect(api.getVacuumLive).not.toHaveBeenCalled();
    expect(container.querySelector("svg.plan-live")).toBeNull();
  });

  it("draws nothing when the robot's last report is old", async () => {
    vi.mocked(api.getVacuum).mockResolvedValue({ configured: true, reachable: true, battery: 60, mode: "returning" });
    vi.mocked(api.getVacuumLive).mockResolvedValue({ map: { width: 10, height: 20 }, robot: { x: 3, y: 4 }, trail: [], ageSeconds: 900, live: false });
    vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:plan"), revokeObjectURL: vi.fn() });
    const { container } = render(<VacuumPage onLogout={() => {}} />);
    await screen.findByRole("img", { name: /floor plan/i });
    await waitFor(() => expect(api.getVacuumLive).toHaveBeenCalled());
    expect(container.querySelector("svg.plan-live")).toBeNull();
  });

  describe("redrawing while the robot works", () => {
    const quiet = () => {
      vi.mocked(api.fetchVacuumMap).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:plan"), revokeObjectURL: vi.fn() });
    };
    const plan = (moving: boolean) => <FloorPlan moving={moving} onAuthError={() => {}} onError={() => {}} onNotice={() => {}} />;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("redraws every half minute while the robot cleans", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      quiet();
      render(plan(true));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/every half minute while the robot cleans/)).toBeTruthy();
    });

    it("does not redraw on a timer while the robot is parked, or while the tab is hidden", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      quiet();
      const { unmount } = render(plan(false));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1);
      unmount();

      vi.mocked(api.refreshVacuumMap).mockClear();
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      render(plan(true));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1);
      hidden.mockRestore();
    });

    it("redraws once more when the robot stops", async () => {
      quiet();
      const { rerender } = render(plan(true));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("false")); // the first redraw is done
      rerender(plan(false));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(2));
    });

    it("does that last redraw right after the one that was still running when the robot stopped", async () => {
      quiet();
      let finish: () => void = () => {};
      vi.mocked(api.refreshVacuumMap).mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
      const { rerender } = render(plan(true));
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1));
      rerender(plan(false));
      expect(api.refreshVacuumMap).toHaveBeenCalledTimes(1);
      finish();
      await waitFor(() => expect(api.refreshVacuumMap).toHaveBeenCalledTimes(2));
    });
  });
});
