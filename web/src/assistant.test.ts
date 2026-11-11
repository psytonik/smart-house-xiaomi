import { afterEach, describe, expect, it, vi } from "vitest";
import { afterWakeWord, pickHeard, piperVoices, russianVoices, sentences, speak, spokenReply, stopSpeaking } from "./assistant";

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

describe("wake word", () => {
  it("returns the command after «Капара»", () => {
    expect(afterWakeWord("Капара, включи свет")).toBe("включи свет");
    expect(afterWakeWord("капара запусти пылесос")).toBe("запусти пылесос");
    expect(afterWakeWord("Ка пара, выключи свет.")).toBe("выключи свет.");
    expect(afterWakeWord("капаров Включи свет")).toBe("Включи свет");
    expect(afterWakeWord("Кабара включи свет")).toBe("включи свет");
    expect(afterWakeWord("capara найди пылесос")).toBe("найди пылесос");
    expect(afterWakeWord("Camaro Найди пылесос")).toBe("Найди пылесос");
    expect(afterWakeWord("к пара Поверни камеру на 90° налево")).toBe("Поверни камеру на 90° налево");
    expect(afterWakeWord("копала Какая сейчас погода")).toBe("Какая сейчас погода");
    expect(afterWakeWord("корпора Поменяй режим пылесоса на мытьё")).toBe("Поменяй режим пылесоса на мытьё");
    expect(afterWakeWord("та пара Очисти бачок")).toBe("Очисти бачок");
    expect(afterWakeWord("я пара включить телевизор")).toBe("включить телевизор");
    expect(afterWakeWord("пара Включи плойку")).toBe("Включи плойку");
    expect(afterWakeWord("параллельно включи свет")).toBeNull();
    // the many ways the recognizer writes the one word «Капара» all lead to the command after it
    for (const w of ["капаров", "корпора", "пара", "я пара", "ко пара", "кап ара", "гапара", "хапара", "каперу", "капару", "Каппарра", "Capara", "Kapara"]) expect(afterWakeWord(`${w} включи свет`), w).toBe("включи свет");
    // one stray word before it: the recognizer glued the end of the previous sound to the front («велосипедистов Катара включи…»)
    expect(afterWakeWord("велосипедистов Катара Включи новостные")).toBe("Включи новостные");
    expect(afterWakeWord("ну капара включи свет")).toBe("включи свет");
    expect(afterWakeWord("сегодня парад включи свет")).toBeNull();
    expect(afterWakeWord("давай пара минут")).toBeNull();
    for (const w of ["пара минут", "капля", "кабель", "парад", "парк"]) expect(afterWakeWord(`${w} включи свет`), w).toBeNull();
    expect(afterWakeWord("Катара Поверни камеру влево")).toBe("Поверни камеру влево");
    expect(afterWakeWord("Камаро, включи свет")).toBe("включи свет");
    expect(afterWakeWord("Kappara, включи свет")).toBe("включи свет");
  });
  it("hears the spellings the browser really wrote for it (from the journal): «топора», «пора», «каппара»…", () => {
    for (const w of ["топора", "Топора,", "пора", "Пора,", "каппара", "капаров", "копара", "тапара", "топара", "тобара", "типора", "хабара", "ко пора", "то пора"]) {
      expect(afterWakeWord(`${w} Какая погода на улице`), w).toBe("Какая погода на улице");
    }
    expect(afterWakeWord("топора убери гостиную")).toBe("убери гостиную");
    expect(afterWakeWord("пора Найди мне фильм Матрица")).toBe("Найди мне фильм Матрица");
    expect(afterWakeWord("Camaro Какой сегодня день")).toBe("Какой сегодня день");
  });
  it("does not take real words for it", () => {
    for (const w of ["топор", "тарелка", "товар", "тапок", "капуста", "порт", "порода", "покупка", "корова", "кобра", "камера"]) expect(afterWakeWord(`${w} включи свет`), w).toBeNull();
    for (const phrase of ["пора спать", "пора домой", "пора идти", "пора вставать", "пора уже", "топор лежит там"]) expect(afterWakeWord(phrase), phrase).toBeNull();
  });
  it("returns an empty command when only the wake word was said", () => {
    expect(afterWakeWord("Капара")).toBe("");
    expect(afterWakeWord("Капара!")).toBe("");
  });
  it("ignores phrases that do not start with it", () => {
    expect(afterWakeWord("включи свет")).toBeNull();
    expect(afterWakeWord("скажи капара")).toBeNull();
    expect(afterWakeWord("Какаду включи свет")).toBeNull();
    expect(afterWakeWord("Камера включи свет")).toBeNull();
    expect(afterWakeWord("корпорация включи свет")).toBeNull();
    expect(afterWakeWord("карта найди пылесос")).toBeNull();
  });
});

describe("pickHeard", () => {
  it("takes the guess that has the wake word, even when it is not the best one", () => {
    expect(pickHeard([{ transcript: "включи свет" }, { transcript: "Капара включи свет" }])).toBe("Капара включи свет");
    expect(pickHeard([{ transcript: "включи свет" }, { transcript: "включить свет" }])).toBe("включи свет");
    expect(pickHeard([])).toBe("");
  });
});

describe("sentences for the slow cloned voice", () => {
  it("keeps a short answer in one piece", () => {
    expect(sentences("Свет включён.")).toEqual(["Свет включён."]);
  });
  it("cuts a long sentence after commas so the first sound does not wait for all of it", () => {
    const text = "Включила свет в гостиной, приглушила до тридцати процентов.";
    const parts = sentences(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ")).toBe(text);
  });
});

describe("spokenReply", () => {
  it("acknowledges a command that did something, then answers", () => {
    expect(spokenReply({ reply: "Свет включён.", actions: [{ tool: "lights_set", input: {}, ok: true }] })).toBe("Исполняю, мой господин. Свет включён.");
  });
  it("just answers a question or a failed action", () => {
    expect(spokenReply({ reply: "Сейчас 5 часов.", actions: [] })).toBe("Сейчас 5 часов.");
    expect(spokenReply({ reply: "Не вышло.", actions: [{ tool: "lights_set", input: {}, ok: false }] })).toBe("Не вышло.");
  });
});
