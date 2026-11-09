import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ASK_MODE, ASK_SUCTION, ASK_WATER } from "./quick.js";
import { spellNumbers } from "./ruNumbers.js";

export interface PiperConfig {
  /** Python of the Piper environment (venv-piper). Without it nothing is started and `url` must already be serving. */
  python?: string;
  /** The voice (.onnx next to its .onnx.json). */
  model?: string;
  port: number;
  /** An already running Piper server; defaults to 127.0.0.1:<port>. */
  url?: string;
}

const MAX_CHARS = 400;
const START_TIMEOUT_MS = 30_000;

/** Speaks text with Piper, a neural voice that runs on this computer. Its own HTTP server keeps the voice loaded, so a reply takes a fraction of a second. */
export class PiperTts {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private closed = false;
  private readonly url: string;

  constructor(
    private readonly cfg: PiperConfig,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.url = cfg.url ?? `http://127.0.0.1:${cfg.port}`;
  }

  /** The voices that are on disk next to the main one (each .onnx with its .onnx.json); the main one comes first. */
  voices(): { default: string; voices: string[] } {
    const main = this.cfg.model ? basename(this.cfg.model, ".onnx") : "";
    const dir = this.cfg.model ? dirname(this.cfg.model) : "";
    const found = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".onnx") && existsSync(`${dir}/${f}.json`)).map((f) => f.slice(0, -5)) : [];
    return { default: main, voices: [main, ...found.filter((v) => v !== main)].filter(Boolean) };
  }

  /** WAV bytes for the text. `speed` 1 is normal; above 1 is faster. `voice` must be one of voices(). */
  async synthesize(text: string, speed = 1, voice?: string): Promise<Buffer> {
    const clean = text.trim().slice(0, MAX_CHARS);
    if (!clean) throw new Error("nothing to say");
    const { default: main, voices } = this.voices();
    if (voice && this.cfg.model && !voices.includes(voice)) throw new Error(`no such voice: ${voice}`);
    await this.ready();
    const res = await fetch(`${this.url}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: clean, ...(voice && voice !== main ? { voice } : {}), length_scale: Math.min(2, Math.max(0.5, 1 / speed)) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Piper answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Starts the server the first time it is needed (and again if it died). */
  private ready(): Promise<void> {
    if (!this.cfg.python || !this.cfg.model) return Promise.resolve();
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.starting ?? Promise.resolve();
    this.starting = this.start().catch((e) => {
      this.starting = undefined;
      throw e;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error("the voice is shut down");
    // Bound to this computer only: Piper's server can also download voices on request.
    const child = spawn(this.cfg.python!, ["-m", "piper.http_server", "--host", "127.0.0.1", "--port", String(this.cfg.port), "-m", this.cfg.model!, "--data-dir", dirname(this.cfg.model!)], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => this.log(`piper: ${d.toString().trim().slice(-200)}`));
    child.on("exit", (code) => {
      this.log(`piper exited (${code})`);
      if (this.child === child) this.child = undefined;
    });
    const end = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error("Piper did not start (see the log)");
      try {
        if ((await fetch(`${this.url}/info`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error("Piper took too long to start");
  }

  close(): void {
    this.closed = true;
    this.child?.kill();
    this.child = undefined;
  }
}

export interface CloneConfig {
  /** Python of the clone environment (venv-mlx). */
  python: string;
  /** The server script (scripts/clone_tts_server.py). */
  script: string;
  /** A clean recording of the person whose voice it is (they agreed, see ADR 0023). */
  reference: string;
  port: number;
  /** Finished phrases are kept here, so a repeated answer is instant. */
  cacheDir: string;
  /** The id and the name shown in the Voice list. */
  voice: string;
}

/** Short replies the assistant gives all the time: made once after start (a few minutes in the background), then they play at once from the cache. */
export const COMMON_PHRASES = [
  "Готово.",
  "Свет включён.",
  "Свет выключен.",
  "Приглушил свет.",
  "Сделал ярче.",
  "Сделал громче.",
  "Сделал тише.",
  "Пауза.",
  "Звук переключён.",
  "Пылесос начал уборку.",
  "Пылесос едет на базу.",
  "Уборка остановлена.",
  "Поменял мощность пылесоса.",
  "Поменял количество воды.",
  "Опустошаю бак пылесоса.",
  "Камера вернулась на прежнее место.",
  "Закрыл все приложения на телевизоре.",
  "Пылесос подаёт голос.",
  "Очистил бак.",
  "Обновляю карту пылесоса.",
  "Включил сухую уборку.",
  "Включил мытьё.",
  "Включил двойную уборку.",
  ASK_MODE,
  ASK_SUCTION,
  ASK_WATER,
  "Камера повернулась налево.",
  "Камера повернулась направо.",
  "Камера повернулась вверх.",
  "Камера повернулась вниз.",
  "Переключаю на приставку.",
  "Запомнил, где вы живёте.",
  "Не поняла название. Назовите его ещё раз.",
  "Не получилось выполнить команду. Скажите ещё раз, чуть по-другому.",
  "Не поняла номер канала.",
  "Не получилось: пылесос не отвечает.",
  "Не получилось: свет не отвечает.",
  "Не получилось: телевизор не отвечает.",
  "Не получилось: камера не отвечает.",
  "Не получилось: устройство не отвечает.",
  "Не получилось выполнить команду.",
  "Что вы имели в виду? Скажите по-другому, и я запомню.",
];

const CLONE_START_TIMEOUT_MS = 180_000;
const CLONE_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The cloned voice ("Olya"). Slow (seconds per phrase), so every phrase is cached on disk.
 * Same interface as PiperTts: it is the main voice, Piper's voices follow it and answer when the clone cannot.
 */
export class CloneTts {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private closed = false;
  private readonly url: string;

  constructor(
    private readonly cfg: CloneConfig,
    private readonly piper: PiperTts | undefined,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.url = `http://127.0.0.1:${cfg.port}`;
    mkdirSync(cfg.cacheDir, { recursive: true });
    // Load the model now (about a minute), so the first answer does not wait for it.
    this.ready()
      .then(() => this.warmCache())
      .catch((e) => this.log(`clone voice did not start: ${(e as Error).message}`));
  }

  /** One phrase at a time, so an answer someone is waiting for is never behind more than one of them. */
  private async warmCache(): Promise<void> {
    for (const phrase of COMMON_PHRASES) {
      if (this.closed) return;
      await this.clone(phrase).catch(() => {});
    }
    this.log("clone voice: common phrases are ready");
  }

  voices(): { default: string; voices: string[] } {
    const rest = this.piper?.voices().voices ?? [];
    return { default: this.cfg.voice, voices: [this.cfg.voice, ...rest] };
  }

  async synthesize(text: string, speed = 1, voice?: string): Promise<Buffer> {
    if (voice && voice !== this.cfg.voice) {
      if (!this.piper) throw new Error(`no such voice: ${voice}`);
      return this.piper.synthesize(text, speed, voice);
    }
    try {
      return await this.clone(text);
    } catch (e) {
      this.log(`clone voice failed (${(e as Error).message}), Piper answers`);
      if (!this.piper) throw e;
      return this.piper.synthesize(text, speed);
    }
  }

  private async clone(text: string): Promise<Buffer> {
    const clean = spellNumbers(text.trim().slice(0, MAX_CHARS)); // the voice skips digits
    if (!clean) throw new Error("nothing to say");
    const file = join(this.cfg.cacheDir, `${createHash("sha1").update(clean).digest("hex")}.wav`);
    if (existsSync(file)) return readFileSync(file);
    await this.ready();
    const res = await fetch(`${this.url}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(CLONE_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`clone server answered ${res.status}`);
    const wav = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, wav);
    return wav;
  }

  private ready(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.starting ?? Promise.resolve();
    this.starting = this.start().catch((e) => {
      this.starting = undefined;
      throw e;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error("the voice is shut down");
    const child = spawn(this.cfg.python, [this.cfg.script, "--reference", this.cfg.reference, "--port", String(this.cfg.port)], { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => this.log(`clone: ${d.toString().trim().slice(-200)}`));
    child.on("exit", (code) => {
      this.log(`clone exited (${code})`);
      if (this.child === child) this.child = undefined;
    });
    const end = Date.now() + CLONE_START_TIMEOUT_MS;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error("the clone server did not start (see the log)");
      try {
        if ((await fetch(`${this.url}/info`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error("the clone server took too long to start");
  }

  close(): void {
    this.closed = true;
    this.child?.kill();
    this.child = undefined;
    this.piper?.close();
  }
}
