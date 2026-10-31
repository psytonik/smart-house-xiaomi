import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Vacuum, VacuumMode, PartWear } from "./vacuum.js";

/** What the watcher needs from the push service. */
export interface Notifier {
  notify(title: string, body: string, type: string): Promise<unknown>;
}

const DOCKED = new Set<VacuumMode>(["charging", "charged", "emptying"]);
/** A part is "worn" below this many percent. */
const WORN_PERCENT = 20;
/** A robot that stops away from the dock with this much battery or less is stranded. */
const STRANDED_BATTERY = 15;
/** Once it is charging again above this, the next stranding is news again. */
const RECOVERED_BATTERY = 25;
const WEAR_NAG_MS = 24 * 3600_000;
const WEAR_CHECK_MS = 6 * 3600_000;
const WEAR_RETRY_MS = 3600_000;

export interface WatcherOptions {
  dataDir: string;
  intervalMs: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Called when a cleaning has just begun (a start, not a resume after a pause). */
  onCleaningStart?: () => Promise<void>;
}

/**
 * Asks the robot how it is every minute and sends a push when something is worth knowing: a cleaning ended, the robot needs help,
 * it ran out of battery away from the dock, or a brush or the filter is worn. It only reads, never commands the robot, and a robot
 * that doesn't answer (asleep, off Wi-Fi) is not an event.
 */
export class VacuumWatcher {
  private previous?: VacuumMode;
  private worked = false;
  private errored = false;
  private stranded = false;
  private unreachable = false;
  private nextWearCheck = 0;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly alertsFile: string;
  private alerts: Record<string, number> = {};

  constructor(
    private readonly vacuum: Pick<Vacuum, "state" | "care">,
    private readonly push: Notifier,
    private readonly opts: WatcherOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.alertsFile = join(opts.dataDir, "vacuum-alerts.json");
    try {
      const saved = JSON.parse(readFileSync(this.alertsFile, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(saved)) if (typeof v === "number") this.alerts[k] = v;
    } catch {
      /* first run */
    }
  }

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at the robot. Never rejects; two looks never overlap. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await this.watch()) await this.watchParts();
    } catch (e) {
      this.log(`vacuum watch: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
    }
  }

  /** False when the robot didn't answer. */
  private async watch(): Promise<boolean> {
    let state;
    try {
      state = await this.vacuum.state();
    } catch {
      if (!this.unreachable) this.log("vacuum watch: the robot is not answering");
      this.unreachable = true;
      return false;
    }
    this.unreachable = false;
    const { mode, battery } = state;
    const before = this.previous;
    this.previous = mode;

    if (mode === "cleaning" && before !== undefined && before !== "cleaning" && before !== "paused") await this.opts.onCleaningStart?.().catch(() => undefined);
    if (mode === "cleaning") this.worked = true;
    if (this.worked && DOCKED.has(mode) && before !== undefined && !DOCKED.has(before)) {
      this.worked = false;
      const done = (state.areaM2 ?? 0) > 0 || (state.minutes ?? 0) > 0;
      await this.push.notify("Vacuum is back on the dock", done ? `Cleaned ${state.areaM2 ?? 0} m² in ${state.minutes ?? 0} min` : "The cleaning is over", "vacuum-done");
    } else if (DOCKED.has(mode) && before !== undefined && DOCKED.has(before)) {
      this.worked = false;
    }

    if (mode === "error" && !this.errored) {
      this.errored = true;
      await this.push.notify("Vacuum needs help", state.fault ? `${state.fault.title}. ${state.fault.hint}` : "It stopped with an error. Check the robot: it may be stuck or its bin full.", "vacuum-error");
    } else if (mode !== "error") {
      this.errored = false;
    }

    const awayFromDock = !DOCKED.has(mode) && mode !== "cleaning" && mode !== "returning";
    if (awayFromDock && battery <= STRANDED_BATTERY && !this.stranded) {
      this.stranded = true;
      await this.push.notify("Vacuum is out of battery", `It stopped away from the dock at ${battery}%. Carry it back to charge.`, "vacuum-battery");
    } else if (DOCKED.has(mode) || battery > RECOVERED_BATTERY) {
      this.stranded = false;
    }
    return true;
  }

  private async watchParts(): Promise<void> {
    if (this.now() < this.nextWearCheck) return;
    let care;
    try {
      care = await this.vacuum.care();
    } catch {
      this.nextWearCheck = this.now() + WEAR_RETRY_MS;
      return;
    }
    this.nextWearCheck = this.now() + WEAR_CHECK_MS;
    const parts: Array<[string, PartWear]> = [
      ["Main brush", care.mainBrush],
      ["Side brush", care.sideBrush],
      ["Filter", care.filter],
    ];
    for (const [name, wear] of parts) {
      if (wear.percent === undefined || wear.percent >= WORN_PERCENT) continue;
      if (this.now() - (this.alerts[name] ?? 0) < WEAR_NAG_MS) continue;
      this.alerts[name] = this.now();
      this.saveAlerts();
      await this.push.notify(`${name} is worn`, `${wear.percent}% left${wear.hoursLeft !== undefined ? `, about ${wear.hoursLeft} h` : ""}. Time for a new one.`, "vacuum-part");
    }
  }

  private saveAlerts(): void {
    try {
      const tmp = `${this.alertsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.alerts), { mode: 0o600 });
      renameSync(tmp, this.alertsFile);
    } catch (e) {
      this.log(`vacuum watch: could not save ${this.alertsFile} (${e instanceof Error ? e.message : e})`);
    }
  }
}
