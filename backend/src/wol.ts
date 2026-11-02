import { createSocket } from "node:dgram";

const MAC = /^([0-9a-f]{2})([:-]?)(?:[0-9a-f]{2}\2){4}[0-9a-f]{2}$/i;
/** The two ports a sleeping network card listens on for a wake-up packet. */
const PORTS = [9, 7];

/** `TV_MAC` is one address or several, separated by commas (a TV has one for Wi-Fi and one for the cable). Throws on a malformed one. */
export function parseMacs(list: string | undefined): string[] {
  return (list ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => {
      if (!MAC.test(m)) throw new Error(`TV_MAC has a malformed address: ${m}`);
      return m.toLowerCase().replace(/[^0-9a-f]/g, "");
    });
}

/** The magic packet: six bytes of 0xFF, then the address sixteen times. */
export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** Where to shout: the broadcast address of the TV's /24 network, and the global one. */
export function broadcastsFor(host: string): string[] {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(host);
  return [...(m ? [`${m[1]}.255`] : []), "255.255.255.255"];
}

/** Sends the wake-up packet for each address to each broadcast address, twice in a row (a single UDP packet can be lost). Fails only if nothing could be sent. */
export async function wake(macs: string[], broadcasts: string[], ports: number[] = PORTS): Promise<void> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    // One address refusing (macOS says "host is down" for an address it cannot resolve) must not stop the others.
    let sent = 0;
    let lastError: Error | undefined;
    for (let round = 0; round < 2; round++) {
      for (const mac of macs) {
        for (const to of broadcasts) {
          for (const port of ports) {
            await new Promise<void>((resolve) =>
              socket.send(magicPacket(mac), port, to, (e) => {
                if (e) lastError = e;
                else sent++;
                resolve();
              }),
            );
          }
        }
      }
    }
    if (sent === 0 && lastError) throw lastError;
  } finally {
    socket.close();
  }
}
