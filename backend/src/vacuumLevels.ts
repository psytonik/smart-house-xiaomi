import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUCTION_NAMES, WATER_NAMES, type SuctionLevel, type Vacuum, type WaterLevel } from "./vacuum.js";

export interface Levels {
  suction?: SuctionLevel;
  water?: WaterLevel;
}

/**
 * Remembers the suction and water the user picked in the web app and puts them back after a cleaning starts: the robot
 * resets both to the maximum at every start (found with tools/miio-snap.ts). It only writes when the robot's value differs
 * from the wanted one, and never touches a setting the user hasn't chosen here.
 */
export class LevelKeeper {
  private wanted: Levels = {};
  private readonly file: string;

  constructor(
    private readonly vacuum: Pick<Vacuum, "state" | "setSuction" | "setWater">,
    dataDir: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.file = join(dataDir, "vacuum-levels.json");
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (SUCTION_NAMES.includes(saved.suction as SuctionLevel)) this.wanted.suction = saved.suction as SuctionLevel;
      if (WATER_NAMES.includes(saved.water as WaterLevel)) this.wanted.water = saved.water as WaterLevel;
    } catch {
      /* nothing chosen yet */
    }
  }

  get(): Levels {
    return { ...this.wanted };
  }

  /** The user chose a level in the web app: from now on it is the one to restore. */
  remember(levels: Levels): void {
    this.wanted = { ...this.wanted, ...levels };
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.wanted), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`vacuum levels: could not save ${this.file} (${e instanceof Error ? e.message : e})`);
    }
  }

  /** Puts the wanted levels back where the robot has something else. Never rejects. */
  async apply(): Promise<void> {
    const { suction, water } = this.wanted;
    if (!suction && !water) return;
    try {
      const now = await this.vacuum.state();
      if (suction && now.suction !== suction) await this.vacuum.setSuction(suction);
      if (water && now.water !== water) await this.vacuum.setWater(water);
    } catch (e) {
      this.log(`vacuum levels: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The robot resets its levels a moment after it starts, so look twice: soon, and a little later. */
  afterStart(delayMs: number): void {
    if (!this.wanted.suction && !this.wanted.water) return;
    for (const wait of [delayMs, delayMs * 5]) setTimeout(() => void this.apply(), wait).unref();
  }
}
