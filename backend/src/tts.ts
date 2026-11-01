import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";

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
