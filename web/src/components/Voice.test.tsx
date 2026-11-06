import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Voice } from "./Voice";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Opens the panel and sends a typed command. */
async function typeCommand(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Talk to the house" }));
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("Voice", () => {
  it("shows nothing when the server has no Anthropic key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ configured: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Voice onAuthLost={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("sends a typed command and shows the answer", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? reply({ reply: "Свет включён.", actions: [] }) : reply({ configured: true })));
    vi.stubGlobal("fetch", fetchMock);
    render(<Voice onAuthLost={() => {}} />);
    await typeCommand("включи свет");
    expect(await screen.findByText("Свет включён.")).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ text: "включи свет" });
  });

  it("shows the server's error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? reply({ error: "the Anthropic key is wrong or missing" }, 502) : reply({ configured: true }))),
    );
    render(<Voice onAuthLost={() => {}} />);
    await typeCommand("привет");
    expect((await screen.findByRole("alert")).textContent).toContain("Anthropic key");
  });
});

describe("Voice remembering", () => {
  it("offers to remember a phrase the model handled, and saves it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/assistant/learn") return reply({ ok: true });
      if (init?.method === "POST") return reply({ reply: "Включил ночник", actions: [], learnable: true });
      return reply({ configured: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Voice onAuthLost={() => {}} />);
    await typeCommand("включи ночник");
    fireEvent.click(await screen.findByRole("button", { name: "Remember this phrase" }));
    expect(await screen.findByText(/Remembered/)).toBeTruthy();
    const learn = fetchMock.mock.calls.find(([u]) => u === "/api/assistant/learn")!;
    expect(JSON.parse(String(learn[1]!.body))).toEqual({ text: "включи ночник" });
  });
});

describe("Voice with Piper", () => {
  it("offers the neural voice and speaks the answer with it", async () => {
    const played = vi.fn(async () => {});
    vi.stubGlobal("Audio", class { onended: (() => void) | null = null; play = played; pause() {} });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tts" && init?.method === "POST") return new Response("RIFFfake", { status: 200 });
      if (url === "/api/tts") return reply({ piper: true, default: "ru_RU-denis-medium", voices: ["ru_RU-denis-medium", "ru_RU-dmitri-medium"] });
      if (init?.method === "POST") return reply({ reply: "Свет выключен.", actions: [] });
      return reply({ configured: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Voice onAuthLost={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Talk to the house" }));
    expect(await screen.findByRole("option", { name: "Denis (neural, Piper)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Dmitri (neural, Piper)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "выключи свет" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(played).toHaveBeenCalled());
    const tts = fetchMock.mock.calls.find(([u, i]) => u === "/api/tts" && i?.method === "POST")!;
    expect(JSON.parse(String(tts[1]!.body))).toMatchObject({ text: "Свет выключен.", voice: "ru_RU-denis-medium" });
  });

  it("offers a suggestion from the journal and teaches it on a tap", async () => {
    let offered = [{ phrase: "хочу темноту", becameText: "выключи свет", times: 1 }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/assistant/suggestions") return reply({ suggestions: offered });
      if (url === "/api/assistant/teach") return ((offered = []), reply({ ok: true }));
      if (url === "/api/tts") return reply({ piper: false, default: "", voices: [] });
      return reply({ configured: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Voice onAuthLost={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Talk to the house" }));
    fireEvent.click(await screen.findByRole("button", { name: /хочу темноту/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /хочу темноту/ })).toBeNull());
    const call = fetchMock.mock.calls.find(([u]) => u === "/api/assistant/teach")!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ text: "хочу темноту" });
  });
});

describe("Voice always listening", () => {
  it("acts only on phrases that start with the wake word", async () => {
    let rec!: { onresult: (e: unknown) => void; started: boolean };
    vi.stubGlobal(
      "webkitSpeechRecognition",
      class {
        onresult: (e: unknown) => void = () => {};
        started = false;
        constructor() {
          rec = this;
        }
        start() {
          this.started = true;
        }
        stop() {}
      },
    );
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? reply({ reply: "Свет включён.", actions: [] }) : reply({ configured: true })));
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("cam.alwaysListen", "1");
    render(<Voice onAuthLost={() => {}} />);
    await waitFor(() => expect(rec?.started).toBe(true));
    // Like the browser, every event carries all the results of the session so far.
    const heardSoFar: unknown[] = [];
    const said = (text: string) => {
      heardSoFar.push(Object.assign([{ transcript: text }], { isFinal: true }));
      return { results: [...heardSoFar] };
    };

    rec.onresult(said("включи свет"));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    rec.onresult(said("Капара, включи свет"));
    expect(await screen.findByText("Свет включён.")).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ text: "включи свет" });
    localStorage.clear();
  });
});
