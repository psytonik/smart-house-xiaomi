import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TvError } from "./tv.js";

const run = promisify(execFile);

/** One thing "Source Choice" on the TV offers. */
export interface TvSource {
  id: string;
  label: string;
}

/** Where `adb` usually is on a Mac; a launchd job doesn't get the shell's PATH, so it can't just be "adb". */
const ADB_PLACES = ["/opt/homebrew/bin/adb", "/usr/local/bin/adb", join(homedir(), "Library/Android/sdk/platform-tools/adb")];

export function findAdb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.TV_ADB_PATH) return existsSync(env.TV_ADB_PATH) ? env.TV_ADB_PATH : undefined;
  return ADB_PLACES.find((p) => existsSync(p));
}

const KEY_HOME = 3;
const KEY_TV = 170;
const KEY_TV_INPUT = 178;
const MEDIA_PLAYER = { package: "com.tcl.ui_mediaCenter", activity: "com.tcl.ui_mediaCenter/.main.MainActivity" };
const SOURCES_TTL_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** What the TV's `dumpsys tv_input` says about its inputs, as the sources a person would pick. */
export function parseSources(dumpsys: string, mediaPlayerInstalled: boolean): Array<TvSource & { how: "key" | "passthrough" | "media"; inputId?: string; key?: number }> {
  // hardware: id -> kind and HDMI port. TvInputHardwareInfo.type: 2 tuner, 3 composite (AV), 9 HDMI.
  const hardware = new Map<string, { type: number; port?: number }>();
  for (const m of dumpsys.matchAll(/TvInputHardwareInfo \{id=(\d+), type=(\d+)([^}]*)\}/g)) {
    const port = /hdmi_port=(\d+)/.exec(m[3]!)?.[1];
    hardware.set(m[1]!, { type: Number(m[2]), ...(port && { port: Number(port) }) });
  }
  // the inputs that are really there: "<hardware id>: <input id>"
  const present: Array<{ hw: string; inputId: string }> = [];
  for (const m of dumpsys.matchAll(/^\s+(\d+): ([A-Za-z0-9._]+\/[A-Za-z0-9._]+\/HW\d+)\s*$/gm)) present.push({ hw: m[1]!, inputId: m[2]! });

  const out: ReturnType<typeof parseSources> = [{ id: "home", label: "Home", how: "key", key: KEY_HOME }];
  const found = present.flatMap((p) => {
    const h = hardware.get(p.hw);
    return h ? [{ ...p, ...h }] : [];
  });
  if (found.some((f) => f.type === 2)) out.push({ id: "tv", label: "TV", how: "key", key: KEY_TV });
  for (const f of found.filter((x) => x.type === 9 && x.port !== undefined).sort((a, b) => a.port! - b.port!)) out.push({ id: `hdmi${f.port}`, label: `HDMI ${f.port}`, how: "passthrough", inputId: f.inputId });
  const av = found.find((f) => f.type === 3);
  if (av) out.push({ id: "av", label: "AV", how: "passthrough", inputId: av.inputId });
  if (mediaPlayerInstalled) out.push({ id: "media", label: "Media Player", how: "media" });
  return out;
}

/**
 * The TV's own "Source Choice" menu and its inputs, over ADB. The Android TV Remote protocol doesn't reach them on a TCL (it
 * ignores those keys), but the Android debug bridge does. Needs "network debugging" on the TV, authorised once for this Mac, and
 * `adb` installed. Only fixed commands are sent: nothing from a request ever reaches the TV's shell as text.
 */
export class TvAdb {
  private queue: Promise<unknown> = Promise.resolve();
  private connected = false;
  private cache?: { at: number; sources: ReturnType<typeof parseSources> };

  constructor(
    private readonly target: string,
    private readonly adb: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(target)) throw new Error("TV_ADB must be an address like 10.0.0.9:5555");
  }

  /** One adb command at a time, reconnecting once if the TV was not connected. */
  private shell(args: string[]): Promise<string> {
    const attempt = async (): Promise<string> => {
      if (!this.connected) await this.connect();
      try {
        return (await run(this.adb, ["-s", this.target, "shell", ...args], { timeout: COMMAND_TIMEOUT_MS })).stdout;
      } catch (e) {
        const text = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message}`;
        if (/not found|offline|no devices|closed|unauthorized/i.test(text)) {
          this.connected = false;
          await this.connect();
          return (await run(this.adb, ["-s", this.target, "shell", ...args], { timeout: COMMAND_TIMEOUT_MS })).stdout;
        }
        throw e;
      }
    };
    const next = this.queue.then(attempt, attempt);
    this.queue = next.catch(() => undefined);
    return next.catch((e: Error & { stderr?: string }) => {
      this.log(`tv adb: ${e.message.split("\n")[0]}`);
      throw new TvError(/unauthorized/i.test(`${e.stderr} ${e.message}`) ? "the TV has not authorised this computer for ADB: accept the prompt on the TV" : "could not reach the TV over ADB (is network debugging on?)", 503);
    });
  }

  private async connect(): Promise<void> {
    const out = (await run(this.adb, ["connect", this.target], { timeout: COMMAND_TIMEOUT_MS })).stdout;
    if (!/connected to|already connected/i.test(out)) throw new Error(out.trim() || "adb connect failed");
    this.connected = true;
  }

  async sources(): Promise<TvSource[]> {
    return (await this.discover()).map(({ id, label }) => ({ id, label }));
  }

  private async discover(): Promise<ReturnType<typeof parseSources>> {
    if (this.cache && Date.now() - this.cache.at < SOURCES_TTL_MS) return this.cache.sources;
    const dump = await this.shell(["dumpsys", "tv_input"]);
    const packages = await this.shell(["pm", "list", "packages", MEDIA_PLAYER.package]).catch(() => "");
    const sources = parseSources(dump, packages.includes(`package:${MEDIA_PLAYER.package}`));
    if (sources.length > 1) this.cache = { at: Date.now(), sources };
    return sources;
  }

  /** Opens the TV's own "Source Choice" list (what the INPUT key of the TV's remote does). */
  async openSourceMenu(): Promise<void> {
    await this.shell(["input", "keyevent", String(KEY_TV_INPUT)]);
  }

  async switchTo(id: string): Promise<void> {
    const source = (await this.discover()).find((s) => s.id === id);
    if (!source) throw new TvError("this TV has no such source", 400);
    if (source.how === "key") await this.shell(["input", "keyevent", String(source.key)]);
    else if (source.how === "media") await this.shell(["am", "start", "-n", MEDIA_PLAYER.activity]);
    else await this.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", `content://android.media.tv/passthrough/${encodeURIComponent(source.inputId!)}`]);
  }
}
