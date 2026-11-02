import { execFile } from "node:child_process";
import { createConnection } from "node:net";

/** A connection to the port: answered or refused at once means the machine is up; silence, or "host is down", means it is not. */
function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED"));
  });
}

/** One real echo request. Asking a sleeping TV like this (what `ping` does) is what seemed to make it wake reliably, so it is not left to the connection alone. */
function pings(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // no -t/-W: they differ between macOS and Linux; the kill after the timeout does the same
    execFile("ping", ["-c", "1", host], { timeout: timeoutMs }, (e) => resolve(!e));
  });
}

/**
 * Is the machine at this address up? A TV in deep sleep has no network at all, so nothing reaches it;
 * a TV that is on answers, even if only with a refusal (nothing listens on that port yet, e.g. while it boots).
 */
export async function isAwake(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const answers = await Promise.all([connects(host, port, timeoutMs), pings(host, timeoutMs)]);
  return answers.some(Boolean);
}
