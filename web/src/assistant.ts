import { api } from "./api";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAnswer {
  reply: string;
  /** The model handled this one: the phrase can be saved as a quick command. */
  learnable?: boolean;
  actions: Array<{ tool: string; input: unknown; ok: boolean }>;
}

/** Whether the server has an Anthropic key, i.e. whether the voice button should show at all. */
export async function assistantConfigured(): Promise<boolean> {
  try {
    const res = await api("/api/assistant");
    return res.ok && ((await res.json()) as { configured: boolean }).configured;
  } catch {
    return false;
  }
}

export async function askAssistant(text: string, history: Turn[]): Promise<AssistantAnswer> {
  const res = await api("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, history: history.slice(-6) }),
  });
  if (!res.ok) {
    let message = `the assistant failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep the generic text */
    }
    throw new Error(message);
  }
  return (await res.json()) as AssistantAnswer;
}

/** Saves the phrase the assistant has just handled, so it runs instantly next time. */
export async function rememberPhrase(text: string): Promise<void> {
  const res = await api("/api/assistant/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not remember (${res.status})`);
}

export interface Suggestion {
  phrase: string;
  becameText: string;
  times: number;
}

/** Phrases that failed and were followed by a command that worked: "say X means Y". */
export async function suggestions(): Promise<Suggestion[]> {
  try {
    const res = await api("/api/assistant/suggestions");
    return res.ok ? (((await res.json()) as { suggestions?: Suggestion[] }).suggestions ?? []) : [];
  } catch {
    return [];
  }
}

export async function teachPhrase(text: string): Promise<void> {
  const res = await api("/api/assistant/teach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not teach (${res.status})`);
}

// The browser's speech recognition is not in TypeScript's DOM types yet (Chrome and Safari ship it, with a webkit prefix).
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

export function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type { Recognition };

/**
 * The word that starts every command in "always listening" mode. Speech recognition spells an invented word
 * differently each time («капаров», «каппара», «кабара»…), so the first word is matched loosely: «ка», «п/б», a vowel, «р», a short ending.
 */
const WAKE = /^[\s,.!?-]*(?:ка[пб]{1,2}[аоеи]р[а-яё]{0,3}|ка\s+пара|kapara)(?![а-яёa-z])[\s,.!?:-]*/i;

/**
 * What was said after the wake word: the command, "" when only the wake word was said, null when the phrase
 * does not start with it (then it is not for the house and is ignored).
 */
export function afterWakeWord(text: string): string | null {
  const m = WAKE.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

const WAKE_KEY = "cam.alwaysListen";
const VOICE_KEY = "cam.voice";
const RATE_KEY = "cam.voiceRate";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice lasts until the page is closed */
  }
}

/** Voices the household does not want to hear, in any variant ("Milena", "Milena (Enhanced)"). */
const UNWANTED = /(milena|милена)/i;

/** Russian voices installed on this computer (the list fills in a moment after the page opens), without the unwanted ones. */
export function russianVoices(): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru") && !UNWANTED.test(v.name));
}

/** Whether the microphone stays open, waiting for the wake word. Remembered per browser. */
export const wakeMode = {
  get: (): boolean => stored(WAKE_KEY) === "1",
  set: (on: boolean): void => store(WAKE_KEY, on ? "1" : "0"),
};

export const voiceChoice = {
  get: (): string => stored(VOICE_KEY) ?? "",
  set: (name: string): void => store(VOICE_KEY, name),
  rate: (): number => {
    const r = Number(stored(RATE_KEY));
    return r >= 0.6 && r <= 1.6 ? r : 1;
  },
  setRate: (rate: number): void => store(RATE_KEY, String(rate)),
};

/** The neural voice on the server (Piper). Learned once from /api/tts; false until then and when it is not set up. */
let piperKnown = false;
let piperDefault = "";
/** Choice values for Piper's voices look like "piper:ru_RU-denis-medium". */
export const PIPER = "piper:";

export interface PiperVoice {
  /** The choice value to store. */
  value: string;
  label: string;
}

/** "ru_RU-denis-medium" is shown as "Denis (neural, Piper)". */
export const piperLabel = (id: string): string => {
  const name = id.split("-")[1] ?? id;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (neural, Piper)`;
};

/** Piper's voices on the server (none when it is not set up). Also remembers whether Piper can be used at all. */
export async function piperVoices(): Promise<PiperVoice[]> {
  try {
    const res = await api("/api/tts");
    const body = res.ok ? ((await res.json()) as { piper?: boolean; default?: string; voices?: string[] }) : {};
    piperKnown = body.piper === true;
    piperDefault = body.default ?? "";
    return piperKnown ? (body.voices ?? []).map((id) => ({ value: PIPER + id, label: piperLabel(id) })) : [];
  } catch {
    piperKnown = false;
    return [];
  }
}

let playing: HTMLAudioElement | null = null;
/** Resolvers of the speak() calls whose answer has not finished yet. */
const unfinished = new Set<() => void>();
function finished(): void {
  for (const done of unfinished) done();
  unfinished.clear();
}
/** Bumped by every stopSpeaking(): an answer that was still being fetched must not start playing after the microphone opened. */
let speechId = 0;

/** Plays Piper's answer; false when the server could not make it, so the caller can use the browser's voice instead. */
async function speakWithPiper(text: string, voice: string): Promise<boolean> {
  const mine = speechId;
  try {
    const res = await api("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, speed: voiceChoice.rate(), ...(voice ? { voice } : {}) }) });
    if (!res.ok) return false;
    const blob = await res.blob();
    if (mine !== speechId) return true; // stopped while the voice was being made: stay silent
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (mine === speechId) finished();
    };
    audio.onerror = () => {
      if (mine === speechId) finished();
    };
    playing = audio;
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function speakWithBrowser(text: string): void {
  const mine = speechId;
  if (!("speechSynthesis" in window)) return finished();
  window.speechSynthesis.cancel();
  const voices = russianVoices();
  // With no wanted voice left the answer stays on the screen: the browser would otherwise pick its default (Milena).
  if (voices.length === 0) return finished();
  const u = new SpeechSynthesisUtterance(text);
  u.onend = u.onerror = () => {
    if (mine === speechId) finished();
  };
  u.lang = "ru-RU";
  u.rate = voiceChoice.rate();
  u.voice = voices.find((v) => v.name === voiceChoice.get()) ?? voices[0]!;
  window.speechSynthesis.speak(u);
}

/**
 * Says the text out loud in Russian with the chosen voice (Piper by default when the server has it), replacing whatever is being said.
 * Resolves when the answer has been said, was cut off, or could not be said at all.
 */
export function speak(text: string): Promise<void> {
  stopSpeaking();
  return new Promise<void>((resolve) => {
    unfinished.add(resolve);
    const choice = voiceChoice.get();
    if (piperKnown && (choice === "" || choice.startsWith(PIPER))) {
      void speakWithPiper(text, choice.startsWith(PIPER) ? choice.slice(PIPER.length) : piperDefault).then((ok) => {
        if (!ok) speakWithBrowser(text);
      });
      return;
    }
    speakWithBrowser(text);
  });
}

export function stopSpeaking(): void {
  speechId++;
  playing?.pause();
  playing = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  finished();
}
