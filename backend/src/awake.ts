import { createConnection } from "node:net";

/**
 * Is the machine at this address up? A TV in deep sleep has no network at all, so a connection to any port times out or finds no route;
 * a TV that is on answers at once, even if only with a refusal (nothing listens on that port yet, e.g. while it boots).
 */
export function isAwake(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
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
