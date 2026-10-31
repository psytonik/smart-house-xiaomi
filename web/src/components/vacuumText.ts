import type { VacuumMode } from "../api";

export const MODE_LABEL: Record<VacuumMode, string> = {
  cleaning: "Cleaning",
  paused: "Paused",
  idle: "Waiting",
  returning: "Going home",
  charging: "Charging",
  charged: "Charged, at the dock",
  emptying: "Emptying the bin",
  updating: "Updating its software",
  error: "Needs attention, check the robot",
  unknown: "Status unknown",
};

/** What the main button does for each state: the label, and the command it sends. */
export function mainAction(mode: VacuumMode): { label: string; action: "start" | "pause" } {
  if (mode === "cleaning" || mode === "returning") return { label: "Pause", action: "pause" };
  return { label: mode === "paused" ? "Resume" : "Start cleaning", action: "start" };
}

export const CLEANING_MODE_LABEL = {
  sweeping: "Sweeping",
  mopping: "Mopping",
  both: "Sweep and mop",
} as const;

export const SUCTION_LABEL = { quiet: "Quiet", standard: "Standard", strong: "Strong", turbo: "Turbo" } as const;
export const WATER_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;
