/**
 * What the robot's fault code (MIoT 2/2) means and what to do about it. The numbers come from the Tasshack/dreame-vacuum
 * integration (MIT, dreame/types.py DreameVacuumErrorCode); the wording is ours. Codes for parts the L10 Plus doesn't have
 * (mop washing, water tanks of a wash base) are left out: they show as "Error N".
 */
export interface VacuumFault {
  code: number;
  title: string;
  /** What to do. */
  hint: string;
}

const RESTART = "Restart the robot. If it comes back, contact support.";
const WHEELS_UP = "Put the robot on the floor and start again.";
const BUMPER = "Clean the bumper and tap it gently so it moves freely.";
const STUCK = "Check for something stuck in the wheels or under the robot, then restart the cleaning.";
const ROUTE = "Open the doors, clear the way and start again.";

const FAULTS: Record<number, [title: string, hint: string]> = {
  1: ["Wheels are off the floor", WHEELS_UP],
  2: ["Cliff sensor error", "Wipe the cliff sensors and start away from stairs or edges."],
  3: ["Bumper is stuck", BUMPER],
  4: ["Robot is tilted", "Put it on a level floor and start again."],
  5: ["Bumper is stuck", BUMPER],
  6: ["Wheels are off the floor", WHEELS_UP],
  7: ["Optical flow sensor error", RESTART],
  8: ["Dust bin is not installed", "Put the dust bin and filter back in."],
  11: ["Filter is wet or clogged", "Let the filter dry or clean it."],
  12: ["Main brush is tangled", "Take the main brush out and clear its bristles and bearings."],
  13: ["Side brush is tangled", "Take the side brush off and clear it."],
  14: ["Filter is wet or clogged", "Let the filter dry or clean it."],
  15: ["Left wheel is blocked", STUCK],
  16: ["Right wheel is blocked", STUCK],
  17: ["Robot cannot turn", "It may be stuck. Move it to an open spot."],
  18: ["Robot cannot go forward", "It may be stuck. Move it to an open spot."],
  19: ["Robot cannot find its dock", "Check that the dock is plugged in and nothing blocks it."],
  20: ["Battery is too low", "Put the robot on the dock to charge."],
  21: ["Charging error", "Wipe the charging contacts on the robot and on the dock."],
  22: ["Battery level error", RESTART],
  23: ["Internal error", RESTART],
  24: ["Camera is covered", "Wipe the positioning sensor."],
  25: ["Movement sensor error", RESTART],
  26: ["Optical sensor is dirty", "Wipe the optical sensor and restart."],
  27: ["Infrared sensor is covered", RESTART],
  28: ["Dock has no power", "Check that the dock's cable is plugged in."],
  29: ["Battery error", "Wait for the battery temperature to return to normal."],
  30: ["Fan speed sensor error", RESTART],
  31: ["Left wheel is blocked", STUCK],
  32: ["Right wheel is blocked", STUCK],
  33: ["Accelerometer error", RESTART],
  34: ["Gyroscope error", RESTART],
  35: ["Gyroscope error", RESTART],
  36: ["Left magnet sensor error", RESTART],
  37: ["Right magnet sensor error", RESTART],
  38: ["Flow sensor error", RESTART],
  39: ["Infrared error", RESTART],
  40: ["Camera error", RESTART],
  41: ["Strong magnetic field", "Start the robot away from the magnetic strip or virtual wall."],
  42: ["Water pump error", RESTART],
  43: ["Clock error", RESTART],
  44: ["Internal error", RESTART],
  45: ["Internal error", RESTART],
  46: ["Internal error", RESTART],
  47: ["Route is blocked", "Clear the way. The robot is going back to the dock."],
  48: ["Laser sensor error", "Check that nothing jams the laser turret on top."],
  49: ["Laser bumper error", "Check that nothing jams the laser bumper."],
  51: ["Filter is wet or clogged", "Let the filter dry or clean it."],
  54: ["Edge sensor error", "Clean the edge sensor."],
  55: ["Carpet detected", "Start the robot away from carpets (it is mopping)."],
  56: ["3D obstacle sensor error", "Clean the obstacle sensor."],
  57: ["Edge sensor error", "Clean the edge sensor."],
  58: ["Ultrasonic sensor error", "Restart the robot and try again."],
  59: ["No-go zone or virtual wall", "Move the robot away from the area and start again."],
  61: ["Route is blocked", ROUTE],
  62: ["Route is blocked", ROUTE],
  63: ["Route is blocked", "Clear the way. The robot is going back to the dock."],
  64: ["Route is blocked", "Clear the way. The robot is going back to the dock."],
  65: ["Robot is in a restricted area", "Move it out of the area."],
  66: ["Robot is in a restricted area", "Move it out of the area."],
  67: ["Robot is in a restricted area", "Move it out of the area."],
  75: ["Battery is low, robot will switch off", "Put the robot on the dock to charge."],
  78: ["Robot is in a hidden area", "Move it to a visible area and try again."],
  // the dock (auto-empty station)
  101: ["Dust bag is full or the air duct is blocked", "Replace the bag in the dock and clean the air duct."],
  102: ["Dock lid is open or no dust bag", "Close the lid and check that the dust bag is installed."],
  103: ["Dock lid is open or no dust bag", "Close the lid and check that the dust bag is installed."],
  104: ["Dust bag is full or the air duct is blocked", "Replace the bag in the dock and clean the air duct."],
  117: ["Dock has no power", "Check that the dock is plugged in and its switch is on."],
  121: ["Dust bag is full or the air duct is blocked", "Replace the bag in the dock and clean the air duct."],
};

/** The meaning of a fault code. Unknown codes are still reported, by number. Code 0 is "no fault": nothing to report. */
export function describeFault(code: number): VacuumFault | undefined {
  if (!Number.isInteger(code) || code <= 0) return undefined;
  const known = FAULTS[code];
  return { code, title: known?.[0] ?? `Error ${code}`, hint: known?.[1] ?? "Check the robot, then restart it. The Dreamehome app may say more." };
}
