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

export const TASK_LABEL = { "whole home": "Whole home", rooms: "Chosen rooms", zone: "A zone", spot: "A spot", mapping: "Mapping the home" } as const;

/** "Every day", "Once", "3 days a week": which weekday each digit is has not been confirmed, so days are counted, not named. */
export function repeatsText(days: string, once: boolean): string {
  const n = [...days].filter((d) => d === "1").length;
  if (once || n === 0) return "Once";
  return n === 7 ? "Every day" : n === 1 ? "1 day a week" : `${n} days a week`;
}

export const CLEANING_MODE_LABEL = {
  sweeping: "Sweeping",
  mopping: "Mopping",
  both: "Sweep and mop",
} as const;

export const SUCTION_LABEL = { quiet: "Quiet", standard: "Standard", strong: "Strong", turbo: "Turbo" } as const;
export const WATER_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;
