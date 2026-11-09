import { api } from "./api";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAnswer {
  reply: string;
  /** The model handled this one: the phrase can be saved as a quick command. */
  learnable?: boolean;
  learned?: boolean;
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

/** Where the house is, if it was told (a city said aloud or the browser's GPS). */
export async function homePlace(): Promise<{ set: boolean; name?: string }> {
  try {
    const res = await api("/api/home");
    return res.ok ? ((await res.json()) as { set: boolean; name?: string }) : { set: false };
  } catch {
    return { set: false };
  }
}

/** Asks the browser where it is (it asks the person first) and tells the house. Resolves with the words to show. */
export async function homeFromGps(): Promise<string> {
  if (!("geolocation" in navigator)) throw new Error("This browser cannot tell where it is.");
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(e.code === 1 ? "Location is blocked for this page: allow it in the address bar." : "Could not find the location.")), { timeout: 15000 }),
  );
  const res = await api("/api/home", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not save the place (${res.status})`);
  return "Запомнил: вы здесь, где сейчас браузер.";
}

// The browser's speech recognition is not in TypeScript's DOM types yet (Chrome and Safari ship it, with a webkit prefix).
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives?: number;
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
const WAKE = /^[\s,.!?-]*(?:[кгх]а[пб]{1,2}\s?[аоеи]р[а-яё]{0,3}|(?:[ктя][ао]?\s*)?пара(?!\s+(?:минут|секунд|раз|дней|часов|слов|штук|лет|человек))|(?:[ктя]о?\s*)?пора(?!\s+(?:спать|домой|идти|ехать|вставать|уже|выходить|обедать|ужинать|завтракать|начинать|заканчивать|прощаться|бы|ли|в\s+путь|на\s))|[ck]app?[aeo]r[a-z]{0,3})(?![а-яёa-z])[\s,.!?:-]*/i;

/** Of the browser's guesses for one phrase, the first that starts with the wake word (the invented word is often only the 2nd or 3rd guess), else the best guess. */
export function pickHeard(guesses: ReadonlyArray<{ transcript: string }>): string {
  const texts = guesses.map((g) => g.transcript.trim()).filter(Boolean);
  return texts.find((t) => afterWakeWord(t) !== null) ?? texts[0] ?? "";
}

/**
 * What was said after the wake word: the command, "" when only the wake word was said, null when the phrase
 * does not start with it (then it is not for the house and is ignored).
 */
export function afterWakeWord(text: string): string | null {
  const m = WAKE.exec(text);
  if (m) return text.slice(m[0].length).trim();
  // The recognizer also turns the word into real ones («Camaro», «Каммаро»): accept a first word that sounds close enough.
  const first = /^[\s,.!?-]*([a-zа-яё]+)[\s,.!?:-]*/i.exec(text);
  if (first && soundsLikeWake(first[1]!)) return text.slice(first[0].length).trim();
  // One stray word may come before it («велосипедистов Катара включи…»): then the second word must be a clear «Капара» (not the bare «пара»).
  const second = /^[\s,.!?-]*[a-zа-яё]{2,}[\s,.!?:-]+([a-zа-яё]+)[\s,.!?:-]*/i.exec(text);
  if (second && (WAKE_CLEAR.test(second[1]!) || soundsLikeWake(second[1]!))) {
    const command = text.slice(second[0].length).trim();
    return command || null; // «скажи капара» only mentions the word
  }
  return null;
}

/** The unambiguous spellings of the word, without the short ones that are real words («пара»). */
const WAKE_CLEAR = /^(?:[кгх]а[пб]{1,2}[аоеи]р[а-яё]{0,3}|[ck]app?[aeo]r[a-z]{0,3})$/i;

const LATIN: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "c", ш: "s", щ: "s", ы: "i", э: "e", ю: "u", я: "a" };

/** Edit distance between two short words. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** A word that starts like «капара» and is at most two letters away from it once written in Latin («Camaro», «Каммаро»). «Камера»/«camera» is a real word and is left alone. */
function soundsLikeWake(word: string): boolean {
  const w = word.toLowerCase();
  // «как…» («какая», «какой») is a question word, never the wake word; the others are real words that start like it.
  if (/^(как|камер|camera|капл|купл|копл|кабел|кабин|копир|купол)/.test(w)) return false;
  const latin = [...w].map((c) => LATIN[c] ?? c).join("").replace(/c/g, "k");
  if (latin.length < 5 || latin.length > 8) return false;
  if (latin.startsWith("ka") && distance(latin, "kapara") <= 2) return true;
  // Same consonants, other vowels (and л heard as р): «капара», «корпора», «копала», «топора», «тобара» (k/t-p-r, k-r-p-r).
  // «Капара» has three syllables: «кобра», «топор» do not count.
  const syllables = (latin.match(/[aeiou]+/g) ?? []).length;
  return syllables >= 3 && /^[ktgh][aeiou]/.test(latin) && /^[ktgh]r?[pb]r$/.test(latin.replace(/[aeiou]/g, "").replace(/l/g, "r").replace(/(.)\1+/g, "$1"));
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
  if (id === "olya") return "Оля (neural)";
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

/** The answer cut into sentences, tiny pieces glued to the next one: the slow cloned voice then starts after the first sentence, not after the whole answer. */
export function sentences(text: string): string[] {
  const whole = (text.trim().match(/[^.!?…]+[.!?…]*\s*/g) ?? [text]).map((p) => p.trim()).filter(Boolean);
  // A sentence over 45 characters is cut after commas too: the slow cloned voice must not make one long piece (the wait for the first sound grows with its length).
  const parts = whole.flatMap((p) => (p.length > 45 ? (p.match(/[^,;:]+[,;:]?\s*/g) ?? [p]).map((x) => x.trim()).filter(Boolean) : [p]));
  const out: string[] = [];
  let carry = "";
  for (const p of parts) {
    carry = carry ? `${carry} ${p}` : p;
    if (carry.length >= 25) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry) out.length ? (out[out.length - 1] += ` ${carry}`) : out.push(carry);
  return out.length ? out : [text];
}

async function fetchSpeech(text: string, voice: string): Promise<Blob | null> {
  try {
    const res = await api("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, speed: voiceChoice.rate(), ...(voice ? { voice } : {}) }) });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Plays the server's answer sentence by sentence (the next one is made while the current one plays); false when the very first could not be made, so the caller can use the browser's voice instead. */
async function speakWithPiper(text: string, voice: string): Promise<boolean> {
  const mine = speechId;
  const parts = sentences(text);
  let next = fetchSpeech(parts[0]!, voice);
  for (let i = 0; i < parts.length; i++) {
    const blob = await next;
    if (mine !== speechId) return true; // stopped while the voice was being made: stay silent
    if (!blob) {
      if (i === 0) return false;
      finished();
      return true;
    }
    if (i + 1 < parts.length) next = fetchSpeech(parts[i + 1]!, voice);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    playing = audio;
    try {
      await new Promise<void>((done, fail) => {
        audio.onended = () => done();
        audio.onerror = () => done();
        audio.play().catch(fail);
      });
    } catch {
      URL.revokeObjectURL(url);
      return i > 0; // the browser refused to play: the first sentence falls back to the browser's voice
    }
    URL.revokeObjectURL(url);
    if (mine !== speechId) return true;
  }
  finished();
  return true;
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
