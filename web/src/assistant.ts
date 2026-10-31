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

/** Russian voices installed on this computer (the list fills in a moment after the page opens). */
export function russianVoices(): SpeechSynthesisVoice[] {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru"));
}

export const voiceChoice = {
  get: (): string => stored(VOICE_KEY) ?? "",
  set: (name: string): void => store(VOICE_KEY, name),
  rate: (): number => {
    const r = Number(stored(RATE_KEY));
    return r >= 0.6 && r <= 1.6 ? r : 1;
  },
  setRate: (rate: number): void => store(RATE_KEY, String(rate)),
};

/** Says the text out loud in Russian with the chosen voice, replacing whatever is being said. */
export function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ru-RU";
  u.rate = voiceChoice.rate();
  const voices = russianVoices();
  const voice = voices.find((v) => v.name === voiceChoice.get()) ?? voices[0];
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
