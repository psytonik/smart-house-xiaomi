import { afterEach, describe, expect, it, vi } from "vitest";
import { russianVoices } from "./assistant";

afterEach(() => vi.unstubAllGlobals());

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

describe("browser voices", () => {
  it("never offers Milena, in any variant, and keeps the other Russian voices", () => {
    vi.stubGlobal("speechSynthesis", { getVoices: () => [voice("Milena", "ru-RU"), voice("Milena (Enhanced)", "ru_RU"), voice("Yuri", "ru-RU"), voice("Samantha", "en-US")] });
    expect(russianVoices().map((v) => v.name)).toEqual(["Yuri"]);
  });
});
