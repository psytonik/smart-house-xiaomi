import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { Cameras } from "./Cameras";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getCameras: vi.fn(),
  xiaomiLogin: vi.fn(),
  listXiaomiDevices: vi.fn(),
  addCamera: vi.fn(),
}));

// jsdom has no <dialog> behaviour
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const living: api.XiaomiDevice = { did: "1001", name: "Living room", model: "chuangmi.camera.046c04", ip: "192.168.1.20" };

function render_(over: Partial<React.ComponentProps<typeof Cameras>> = {}) {
  const props = { onClose: vi.fn(), onAuthError: vi.fn(), ...over };
  render(<Cameras {...props} />);
  return props;
}

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Cameras", () => {
  beforeEach(() => {
    vi.mocked(api.getCameras).mockResolvedValue({ streams: [{ name: "psytonik_base", active: true }], accounts: [] });
    vi.mocked(api.listXiaomiDevices).mockImplementation(async (_acc, region) => (region === "de" ? [living] : []));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the cameras in go2rtc and says which one the app shows", async () => {
    vi.mocked(api.getCameras).mockResolvedValue({
      streams: [{ name: "garage", active: false }, { name: "psytonik_base", active: true }],
      accounts: ["6674200535"],
    });
    render_();
    expect(await screen.findByText("psytonik_base")).toBeTruthy();
    expect(screen.getByText("Shown in this app")).toBeTruthy();
    expect(screen.getByText("Ready in go2rtc")).toBeTruthy();
    expect(screen.getByText(/signed in to mi home \(account 6674200535\)/i)).toBeTruthy();
  });

  it("asks to sign in first when there is no account, and goes on to the cameras after it", async () => {
    vi.mocked(api.xiaomiLogin).mockResolvedValue({ status: "ok" });
    vi.mocked(api.getCameras)
      .mockResolvedValueOnce({ streams: [], accounts: [] })
      .mockResolvedValue({ streams: [], accounts: ["6674200535"] });
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));

    type(/email, phone/i, " me@example.com ");
    type("Password", "p&ss");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(api.xiaomiLogin).toHaveBeenCalledWith({ username: "me@example.com", password: "p&ss" }));
    expect(await screen.findByText("Living room")).toBeTruthy();
    expect(screen.getByText(/chuangmi\.camera\.046c04 · 192\.168\.1\.20 · Europe/)).toBeTruthy();
    // every region was asked, because nobody remembers theirs
    expect(vi.mocked(api.listXiaomiDevices).mock.calls.map((c) => c[1]).sort()).toEqual(["cn", "de", "i2", "ru", "sg", "us"]);
  });

  it("walks through a captcha and then a code from Mi Home", async () => {
    vi.mocked(api.xiaomiLogin)
      .mockResolvedValueOnce({ status: "captcha", image: "QUJD" })
      .mockResolvedValueOnce({ status: "verify", target: "m***@example.com" })
      .mockResolvedValueOnce({ status: "ok" });
    vi.mocked(api.getCameras)
      .mockResolvedValueOnce({ streams: [], accounts: [] })
      .mockResolvedValue({ streams: [], accounts: ["6674200535"] });
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
    type(/email, phone/i, "me@example.com");
    type("Password", "secret");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const img = (await screen.findByAltText(/captcha/i)) as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,QUJD");
    type("Characters", "x9k2");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.xiaomiLogin).toHaveBeenLastCalledWith({ captcha: "x9k2" }));

    expect(await screen.findByText("m***@example.com")).toBeTruthy();
    type("Verification code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.xiaomiLogin).toHaveBeenLastCalledWith({ verify: "123456" }));
    expect(await screen.findByText("Living room")).toBeTruthy();
  });

  it("shows why a sign-in failed and stays on the form", async () => {
    vi.mocked(api.xiaomiLogin).mockRejectedValue(new Error("xiaomi: wrong password"));
    render_();
    fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
    type(/email, phone/i, "me@example.com");
    type("Password", "nope");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("xiaomi: wrong password");
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("goes back to the sign-in screen when the access token expires", async () => {
    vi.mocked(api.xiaomiLogin).mockRejectedValue(new api.AuthError());
    const { onAuthError } = render_();
    fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
    type(/email, phone/i, "a");
    type("Password", "b");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });

  describe("with a signed-in account", () => {
    beforeEach(() => {
      vi.mocked(api.getCameras).mockResolvedValue({ streams: [{ name: "psytonik_base", active: true }], accounts: ["6674200535"] });
    });

    it("suggests a name from the camera's name and adds the camera with its region and device", async () => {
      vi.mocked(api.addCamera).mockResolvedValue({ name: "living-room", active: false });
      render_();
      fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
      const input = (await screen.findByLabelText("Name in go2rtc")) as HTMLInputElement;
      expect(input.value).toBe("living-room");

      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(api.addCamera).toHaveBeenCalledWith({ account: "6674200535", region: "de", did: "1001", name: "living-room" }));
      expect(await screen.findByText(/added as/i)).toBeTruthy();
      expect(screen.getByText(/this app still shows and records/i).textContent).toContain("psytonik_base");
    });

    it("does not let a taken or invalid name be sent", async () => {
      render_();
      fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
      await screen.findByLabelText("Name in go2rtc");
      const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;

      type("Name in go2rtc", "psytonik_base");
      expect(screen.getByText("That name is already used.")).toBeTruthy();
      expect(add.disabled).toBe(true);

      type("Name in go2rtc", "Living Room");
      expect(screen.getByText(/use lowercase letters/i)).toBeTruthy();
      expect(add.disabled).toBe(true);
      expect(api.addCamera).not.toHaveBeenCalled();
    });

    it("shows the server's reason next to the camera when adding fails", async () => {
      vi.mocked(api.addCamera).mockRejectedValue(new Error('a camera named "living-room" already exists'));
      render_();
      fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
      await screen.findByLabelText("Name in go2rtc");
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect((await screen.findByRole("alert")).textContent).toContain("already exists");
      expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("says when the account has no camera, and offers to search again", async () => {
      vi.mocked(api.listXiaomiDevices).mockResolvedValue([]);
      render_();
      fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
      expect(await screen.findByText(/no cameras found/i)).toBeTruthy();
      vi.mocked(api.listXiaomiDevices).mockImplementation(async (_a, r) => (r === "us" ? [living] : []));
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
      expect(await screen.findByText(/United States/)).toBeTruthy();
    });

    it("reports a failure only when no region could be read at all", async () => {
      vi.mocked(api.listXiaomiDevices).mockRejectedValue(new Error("Mi Home answered 500"));
      render_();
      fireEvent.click(await screen.findByRole("button", { name: "Add a camera" }));
      expect((await screen.findByRole("alert")).textContent).toBe("Mi Home answered 500");

      vi.mocked(api.listXiaomiDevices).mockImplementation(async (_a, r) => {
        if (r === "de") return [living];
        throw new Error("no data in this region");
      });
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
      expect(await screen.findByText("Living room")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
