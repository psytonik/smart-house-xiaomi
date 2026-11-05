import type { PtzDirection } from "./go2rtc.js";

/** The camera's own scale for where it points, on both axes (not degrees). */
export const MOTOR_MIN = 1;
export const MOTOR_MAX = 101;

export interface Pos {
  angle: number;
  elevation: number;
}

/** What gotoPosition needs from the camera. */
export interface GotoIo {
  /** Where the camera points now, asked fresh. Undefined when it does not say. */
  position(): Promise<Pos | undefined>;
  /** One step. Left raises the angle, right lowers it; up raises the elevation, down lowers it (measured on the real camera). */
  step(direction: PtzDirection): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface GotoOptions {
  /** How near counts as there. A step moves about 3 on the angle and about 7 on the elevation, so the elevation needs more room. */
  tolAngle?: number;
  tolElevation?: number;
  maxSteps?: number;
  /** Wait after a step before asking where the camera is. */
  settleMs?: number;
}

export interface GotoResult {
  reached: boolean;
  angle?: number;
  elevation?: number;
  steps: number;
  /** limit: the camera stopped moving (the end of its range); max-steps: gave up; unknown: the camera did not say where it points. */
  reason?: "limit" | "max-steps" | "unknown";
}

const STEP_ANGLE = 3;
const STEP_ELEVATION = 7;

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MOTOR_MIN && n <= MOTOR_MAX;

/**
 * Moves the camera to a position by steps. This camera ignores the one-command "go to" of the Mi Home plugin (tried on
 * chuangmi.camera.029a02), but it says where it points after every step, so the walk is steered by that answer: step toward the
 * target along the axis with more to go, ask again, stop when near enough, when it stops moving, or after maxSteps.
 */
export async function gotoPosition(target: Pos, io: GotoIo, opts: GotoOptions = {}): Promise<GotoResult> {
  if (!whole(target.angle) || !whole(target.elevation)) throw new RangeError(`angle and elevation must be whole numbers ${MOTOR_MIN}..${MOTOR_MAX}`);
  const { tolAngle = 2, tolElevation = 4, maxSteps = 80, settleMs = 350 } = opts;

  let pos = await io.position();
  if (!pos) return { reached: false, steps: 0, reason: "unknown" };
  let steps = 0;
  let stuck = 0;

  for (;;) {
    const dA = target.angle - pos.angle;
    const dE = target.elevation - pos.elevation;
    const needA = Math.abs(dA) > tolAngle;
    const needE = Math.abs(dE) > tolElevation;
    if (!needA && !needE) return { reached: true, angle: pos.angle, elevation: pos.elevation, steps };
    if (steps >= maxSteps) return { reached: false, angle: pos.angle, elevation: pos.elevation, steps, reason: "max-steps" };

    // The axis with more steps still to go goes first.
    const moreA = needA && (!needE || Math.abs(dA) / STEP_ANGLE >= Math.abs(dE) / STEP_ELEVATION);
    const direction: PtzDirection = moreA ? (dA > 0 ? "left" : "right") : dE > 0 ? "up" : "down";

    const before = pos;
    await io.step(direction);
    steps++;
    await io.sleep(settleMs);
    const next = await io.position();
    if (!next) return { reached: false, angle: before.angle, elevation: before.elevation, steps, reason: "unknown" };
    pos = next;

    stuck = pos.angle === before.angle && pos.elevation === before.elevation ? stuck + 1 : 0;
    if (stuck >= 2) return { reached: false, angle: pos.angle, elevation: pos.elevation, steps, reason: "limit" };
  }
}
