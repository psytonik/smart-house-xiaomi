import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { TvPage } from "./TvPage";
import { appName } from "./tvText";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), getTv: vi.fn(), sendTvKey: vi.fn(), launchTvApp: vi.fn(), startTvPairing: vi.fn(), getTvSources: vi.fn(), getTvRunning: vi.fn(), closeTvApps: vi.fn(), switchTvSource: vi.fn(), sendTvCode: vi.fn(), cancelTvPairing: vi.fn() }));

const APPS = [{ id: "youtube", label: "YouTube" }, { id: "netflix", label: "Netflix" }];
const ready = (extra: Partial<api.TvState> = {}): api.TvState => ({ configured: true, paired: true, link: "ready", powered: true, volume: { level: 35, max: 100, muted: false }, app: "com.google.android.youtube.tv", apps: APPS, ...extra });

describe("TvPage", () => {
  beforeEach(() => {
    vi.mocked(api.sendTvKey).mockResolvedValue();
    vi.mocked(api.launchTvApp).mockResolvedValue();
    vi.mocked(api.startTvPairing).mockResolvedValue();
    vi.mocked(api.sendTvCode).mockResolvedValue();
    vi.mocked(api.cancelTvPairing).mockResolvedValue();
    vi.mocked(api.getTvSources).mockResolvedValue([]);
    vi.mocked(api.getTvRunning).mockResolvedValue([]);
    vi.mocked(api.closeTvApps).mockResolvedValue([]);
    vi.mocked(api.switchTvSource).mockResolvedValue();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says how to set up a TV that isn't configured", async () => {
    vi.mocked(api.getTv).mockResolvedValue({ configured: false });
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText(/Add TV_IP/)).toBeTruthy();
  });

  it("shows what the TV is doing, and presses keys", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Now: YouTube")).toBeTruthy();
    expect(screen.getByText("Volume 35")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(screen.getByRole("button", { name: "Volume down" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn the TV off" }));
    await waitFor(() => expect(vi.mocked(api.sendTvKey).mock.calls.map((c) => c[0])).toEqual(["up", "ok", "volumeDown", "power"]));
  });

  it("opens an app", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Netflix" }));
    await waitFor(() => expect(api.launchTvApp).toHaveBeenCalledWith("netflix"));
  });

  it("lets Power wake a sleeping TV when the server can send a wake-up packet", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ link: "offline", powered: undefined, app: undefined, volume: undefined, wake: true }));
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn the TV on" }));
    await waitFor(() => expect(api.sendTvKey).toHaveBeenCalledWith("power"));
    // the TV is waking up: the button locks, so a second press cannot switch it off again
    expect(await screen.findByText(/The TV is waking up/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "The TV is waking up" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.sendTvKey).toHaveBeenCalledTimes(1);
  });

  it("says how to wake a sleeping TV before the button is pressed", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ link: "offline", powered: undefined, app: undefined, volume: undefined, wake: true }));
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText(/Press On to wake it/)).toBeTruthy();
  });

  it("locks the keys while the TV doesn't answer, and says why", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ link: "offline", powered: undefined, app: undefined, volume: undefined }));
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText("Not answering")).toBeTruthy();
    expect(screen.getByText(/may be off or asleep/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "YouTube" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Turn the TV on" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers On when the screen is off", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ powered: false }));
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText("Connected, screen off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn the TV on" }));
    await waitFor(() => expect(api.sendTvKey).toHaveBeenCalledWith("power"));
  });

  it("shows an error from the TV", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    vi.mocked(api.sendTvKey).mockRejectedValue(new Error("the TV is not answering"));
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Home" }));
    expect(await screen.findByText("the TV is not answering")).toBeTruthy();
  });

  it("works from the keyboard, but not while typing or while the TV is away", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    render(<TvPage onLogout={() => {}} />);
    await screen.findByText("Connected");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "m" });
    fireEvent.keyDown(window, { key: "ArrowUp", metaKey: true }); // a browser shortcut: left alone
    fireEvent.keyDown(screen.getByRole("button", { name: "Home" }), { key: "Enter" }); // on a button, Enter presses that button
    await waitFor(() => expect(vi.mocked(api.sendTvKey).mock.calls.map((c) => c[0])).toEqual(["left", "ok", "back", "volumeUp", "mute"]));

    cleanup();
    vi.mocked(api.sendTvKey).mockClear();
    vi.mocked(api.getTv).mockResolvedValue(ready({ link: "offline" }));
    render(<TvPage onLogout={() => {}} />);
    await screen.findByText("Not answering");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(api.sendTvKey).not.toHaveBeenCalled();
  });

  it("keeps pressing an arrow while it is held, and stops when let go", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    render(<TvPage onLogout={() => {}} />);
    const down = await screen.findByRole("button", { name: "Down" });
    fireEvent.pointerDown(down);
    expect(api.sendTvKey).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(vi.mocked(api.sendTvKey).mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 1500 });
    fireEvent.pointerUp(down);
    const held = vi.mocked(api.sendTvKey).mock.calls.length;
    await new Promise((r) => setTimeout(r, 350));
    expect(vi.mocked(api.sendTvKey).mock.calls.length).toBe(held);
    // a click that follows a pointer press is not a second press
    fireEvent.pointerDown(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }), { detail: 1 });
    expect(vi.mocked(api.sendTvKey).mock.calls.filter((c) => c[0] === "back")).toHaveLength(1);
  });

  it("lists the TV's own sources and switches to one, with the Input key still working when the remote link is down", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ link: "offline", powered: undefined, app: undefined, volume: undefined, adb: true }));
    vi.mocked(api.getTvSources).mockResolvedValue([{ id: "home", label: "Home" }, { id: "tv", label: "TV" }, { id: "hdmi1", label: "HDMI 1" }, { id: "hdmi2", label: "HDMI 2" }, { id: "av", label: "AV" }, { id: "media", label: "Media Player" }]);
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "HDMI 2" }));
    await waitFor(() => expect(api.switchTvSource).toHaveBeenCalledWith("hdmi2"));
    expect(screen.getByRole("button", { name: "Media Player" })).toBeTruthy();
    // the keys that need the remote link are locked, Input is not: it goes another way
    expect((screen.getByRole("button", { name: "Up" }) as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByRole("button", { name: "Input: open Source Choice" }) as HTMLButtonElement;
    expect(input.disabled).toBe(false);
    fireEvent.click(input);
    await waitFor(() => expect(api.sendTvKey).toHaveBeenCalledWith("input"));
  });

  it("lists the running apps and closes one, or all of them", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ adb: true }));
    vi.mocked(api.getTvRunning).mockResolvedValue([{ package: "top.rootu.prisma", label: "Prisma", memoryMb: 62, helper: false }, { package: "com.google.android.apps.mediashell", label: "Chromecast receiver", memoryMb: 37, helper: true }]);
    vi.mocked(api.closeTvApps).mockResolvedValueOnce(["top.rootu.prisma"]).mockResolvedValueOnce(["top.rootu.prisma", "com.google.android.apps.mediashell"]);
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText("62 MB")).toBeTruthy();
    expect(screen.getByText("37 MB, background service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Prisma" }));
    await waitFor(() => expect(api.closeTvApps).toHaveBeenCalledWith(["top.rootu.prisma"]));
    expect(await screen.findByText("Closed 1 app")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close all" }));
    await waitFor(() => expect(api.closeTvApps).toHaveBeenLastCalledWith("all"));
    expect(await screen.findByText("Closed 2 apps")).toBeTruthy();
  });

  it("says so when nothing extra runs, and shows why closing failed", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ adb: true }));
    render(<TvPage onLogout={() => {}} />);
    expect(await screen.findByText("Nothing extra is running.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Close all" }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    vi.mocked(api.getTvRunning).mockResolvedValue([{ package: "top.rootu.prisma", label: "Prisma", memoryMb: 62, helper: false }]);
    vi.mocked(api.closeTvApps).mockRejectedValue(new Error("could not reach the TV over ADB (is network debugging on?)"));
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Prisma" }));
    expect(await screen.findByText(/over ADB/)).toBeTruthy();
  });

  it("says why a source could not be read or switched", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready({ adb: true }));
    vi.mocked(api.getTvSources).mockResolvedValue([{ id: "hdmi1", label: "HDMI 1" }]);
    vi.mocked(api.switchTvSource).mockRejectedValue(new Error("could not reach the TV over ADB (is network debugging on?)"));
    render(<TvPage onLogout={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "HDMI 1" }));
    expect(await screen.findByText(/over ADB/)).toBeTruthy();

    cleanup();
    vi.mocked(api.getTvSources).mockRejectedValue(new Error("the TV has not authorised this computer for ADB: accept the prompt on the TV"));
    render(<TvPage onLogout={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("not authorised");
  });

  it("without ADB there is no Sources card, and the old source keys are offered with a warning", async () => {
    vi.mocked(api.getTv).mockResolvedValue(ready());
    render(<TvPage onLogout={() => {}} />);
    await screen.findByText("Connected");
    expect(screen.queryByText("Sources")).toBeNull();
    expect(api.getTvSources).not.toHaveBeenCalled();
    expect(screen.getByText(/Source keys \(not every TV takes them\)/)).toBeTruthy();

    cleanup();
    vi.mocked(api.getTv).mockResolvedValue(ready({ adb: true }));
    render(<TvPage onLogout={() => {}} />);
    await screen.findByText("Connected");
    expect(screen.queryByText(/Source keys/)).toBeNull();
  });

  describe("pairing", () => {
    it("asks the TV for a code, then takes the code the person types", async () => {
      vi.mocked(api.getTv).mockResolvedValue({ configured: true, paired: false, link: "offline", waitingForCode: false });
      render(<TvPage onLogout={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Show the code on the TV" }));
      await waitFor(() => expect(api.startTvPairing).toHaveBeenCalled());

      vi.mocked(api.getTv).mockResolvedValue({ configured: true, paired: false, link: "offline", waitingForCode: true });
      const input = (await screen.findByLabelText("Code on the TV screen", {}, { timeout: 4000 })) as HTMLInputElement;
      const pair = screen.getByRole("button", { name: "Pair" }) as HTMLButtonElement;
      expect(pair.disabled).toBe(true);
      fireEvent.change(input, { target: { value: "a1b2" } });
      expect(input.value).toBe("A1B2");
      expect(pair.disabled).toBe(true);
      fireEvent.change(input, { target: { value: "a1b2c3zz" } });
      expect(input.value).toBe("A1B2C3");
      expect(pair.disabled).toBe(false);
      fireEvent.click(pair);
      await waitFor(() => expect(api.sendTvCode).toHaveBeenCalledWith("A1B2C3"));
    }, 10000);

    it("says what is wrong with the code, next to it", async () => {
      vi.mocked(api.getTv).mockResolvedValue({ configured: true, paired: false, link: "offline", waitingForCode: true });
      vi.mocked(api.sendTvCode).mockRejectedValue(new Error("that is not the code the TV shows: check it and try again"));
      render(<TvPage onLogout={() => {}} />);
      const input = await screen.findByLabelText("Code on the TV screen");
      fireEvent.change(input, { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
      expect((await screen.findByRole("alert")).textContent).toContain("not the code the TV shows");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    });

    it("can be given up", async () => {
      vi.mocked(api.getTv).mockResolvedValue({ configured: true, paired: false, link: "offline", waitingForCode: true });
      render(<TvPage onLogout={() => {}} />);
      await screen.findByLabelText("Code on the TV screen");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(api.cancelTvPairing).toHaveBeenCalled());
    });
  });
});

describe("appName", () => {
  it("gives people the name, and something readable for an app it doesn't know", () => {
    expect(appName("com.netflix.ninja")).toBe("Netflix");
    expect(appName("com.google.android.tvlauncher")).toBe("Home");
    expect(appName("com.example.coolplayer")).toBe("Coolplayer");
    expect(appName("org.videolan.vlc")).toBe("Vlc");
    expect(appName("top.rootu.prisma")).toBe("Prisma");
    expect(appName("com.tcl.ott_play")).toBe("Ott play");
    expect(appName("com.tcl.tvhome")).toBe("Home");
    expect(appName("com.vendor.launcher")).toBe("Home");
    expect(appName("com.example.homestream")).toBe("Homestream");
  });
});
