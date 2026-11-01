import { afterEach, describe, expect, it, vi } from "vitest";
import { piperVoices, russianVoices, speak, stopSpeaking } from "./assistant";

afterEach(() => vi.unstubAllGlobals());

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

describe("browser voices", () => {
  it("never offers Milena, in any variant, and keeps the other Russian voices", () => {
    vi.stubGlobal("speechSynthesis", { getVoices: () => [voice("Milena", "ru-RU"), voice("Milena (Enhanced)", "ru_RU"), voice("Yuri", "ru-RU"), voice("Samantha", "en-US")] });
    expect(russianVoices().map((v) => v.name)).toEqual(["Yuri"]);
  });
});

describe("speaking", () => {
  it("stays silent when the microphone opened while the answer was still being made", async () => {
    let finish!: (r: Response) => void;
    const played = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? new Promise<Response>((r) => (finish = r)) : new Response(JSON.stringify({ piper: true, default: "v", voices: ["v"] })))));
    vi.stubGlobal("Audio", class { play = played; pause() {} });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    await piperVoices();
    speak("Готово");
    stopSpeaking(); // the person pressed the microphone
    finish(new Response("RIFFfake"));
    await new Promise((r) => setTimeout(r, 0));
    expect(played).not.toHaveBeenCalled();
  });
});
