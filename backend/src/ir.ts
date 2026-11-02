import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The carrier of the frame below, in Hz: the Pronto code the Universal TV app sends (and the TV wakes from) has frequency word 0x6C, which is 38.4 kHz. */
export const CARRIER_HZ = 38400;

/** Timings in microseconds, measured from that Pronto code (0x98, 0x13, 0x4C, 0x26 ticks of 26.05 µs). */
const RCA = { header: [3960, 3960], mark: 495, one: 1980, zero: 990 };

/**
 * The frame as alternating mark/space durations, starting with a mark: 24 bits of address, inverted command, inverted address, command.
 * The TV's firmware (ir_config.ini, section PM51) wakes from standby on protocol 0x07, header 0x000f, key 0xD5;
 * the bit order was read from the code the Universal TV app sends for "Power Toggle" (see the test).
 */
export function rcaTimings(address: number, command: number): number[] {
  if (!Number.isInteger(address) || address < 0 || address > 0xf) throw new Error(`RCA address must be 0..15, got ${address}`);
  if (!Number.isInteger(command) || command < 0 || command > 0xff) throw new Error(`RCA command must be 0..255, got ${command}`);
  const word = (address << 20) | ((~command & 0xff) << 12) | ((~address & 0xf) << 8) | command;
  const t = [...RCA.header];
  for (let bit = 23; bit >= 0; bit--) t.push(RCA.mark, (word >> bit) & 1 ? RCA.one : RCA.zero);
  t.push(RCA.mark); // the closing mark; the gap that follows is the end of the packet
  return t;
}

/** What the TV's firmware wakes on from standby (ir_config.ini, section PM51): the address and key of the power button. */
const WAKE = { address: 0xf, command: 0xd5 };

/** An adb serial: letters, digits and the few characters of a USB serial or a host:port; nothing a shell could read as more. */
export const PHONE_SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Wakes the TV by the infrared emitter of an Android phone that has ir-phone (ir-phone/ in this repo) installed and is plugged in by adb.
 * The phone sends the frame itself; this only hands it the carrier and the timings. Throws if the phone says it did not send.
 */
export async function sendIrWake(adbPath: string, serial: string): Promise<void> {
  if (!PHONE_SERIAL.test(serial)) throw new Error("TV_IR_PHONE must be an adb serial");
  const pattern = rcaTimings(WAKE.address, WAKE.command).join(",");
  // -f 32: the package counts as stopped until its window has been opened once, and adb may still reach it
  const { stdout } = await run(adbPath, ["-s", serial, "shell", "am", "broadcast", "-f", "32", "-n", "com.psytonik.irwake/.IrReceiver", "--ei", "carrier", String(CARRIER_HZ), "--es", "pattern", pattern], { timeout: 10_000 });
  const code = /result=(\d+)/.exec(stdout)?.[1];
  if (code !== "1") throw new Error(code === "2" ? "the phone has no infrared emitter" : `the phone did not send the infrared frame (${stdout.trim().split("\n").pop() ?? "no answer"})`);
}
