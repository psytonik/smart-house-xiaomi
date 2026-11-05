import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createSocket } from "node:dgram";

export class MiioError extends Error {}

const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
export const HELLO = Buffer.from("21310020" + "ff".repeat(28), "hex");

/**
 * Local Xiaomi "miio" client (UDP 54321). Every call opens its own short-lived socket, says hello to get the
 * device id and clock, then sends one encrypted request. Calls are queued so the device never gets two at once.
 * The token is only used to derive keys; it is never logged or returned.
 */
export class MiioDevice {
  private readonly token: Buffer;
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(
    readonly ip: string,
    tokenHex: string,
    private port = 54321,
    private timeoutMs = 3000,
  ) {
    if (!/^[0-9a-fA-F]{32}$/.test(tokenHex)) throw new MiioError("the device token must be 32 hex characters");
    this.token = Buffer.from(tokenHex, "hex");
    this.key = md5(this.token);
    this.iv = md5(this.key, this.token);
  }

  private encrypt(buf: Buffer): Buffer {
    const c = createCipheriv("aes-128-cbc", this.key, this.iv);
    return Buffer.concat([c.update(buf), c.final()]);
  }

  private decrypt(buf: Buffer): Buffer {
    const d = createDecipheriv("aes-128-cbc", this.key, this.iv);
    return Buffer.concat([d.update(buf), d.final()]);
  }

  private packet(deviceId: number, stamp: number, payload: Buffer): Buffer {
    const body = this.encrypt(payload);
    const head = Buffer.alloc(16);
    head.writeUInt16BE(0x2131, 0);
    head.writeUInt16BE(32 + body.length, 2);
    head.writeUInt32BE(deviceId, 8);
    head.writeUInt32BE(stamp, 12);
    return Buffer.concat([head, md5(head, this.token, body), body]);
  }

  private exchange(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sock = createSocket("udp4");
      const id = this.nextId++;
      let greeted = false;
      const finish = (err: Error | null, value?: unknown) => {
        clearTimeout(timer);
        sock.close();
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new MiioError("vacuum did not answer")), this.timeoutMs);
      sock.on("error", (e) => finish(new MiioError(`vacuum unreachable: ${e.message}`)));
      sock.on("message", (msg, from) => {
        if (from.address !== this.ip || msg.length < 32 || msg.readUInt16BE(0) !== 0x2131) return; // not from the vacuum
        if (!greeted) {
          greeted = true;
          const payload = Buffer.from(JSON.stringify({ id, method, params }));
          sock.send(this.packet(msg.readUInt32BE(8), msg.readUInt32BE(12) + 1, payload), this.port, this.ip);
          return;
        }
        if (msg.length === 32) return;
        // Replies carry md5(header + token + body): anything else on the network can't forge one.
        if (!md5(msg.subarray(0, 16), this.token, msg.subarray(32)).equals(msg.subarray(16, 32))) return;
        try {
          const reply = JSON.parse(this.decrypt(msg.subarray(32)).toString().replace(/\0+$/, "")) as {
            id?: number;
            result?: unknown;
            error?: { code?: number; message?: string };
          };
          if (reply.id !== id) return;
          if (reply.error) return finish(new MiioError(`vacuum refused ${method}: ${reply.error.message ?? reply.error.code}`));
          finish(null, reply.result);
        } catch {
          finish(new MiioError("could not read the vacuum's reply (is the token right?)"));
        }
      });
      sock.send(HELLO, this.port, this.ip, (err) => err && finish(new MiioError(`vacuum unreachable: ${err.message}`)));
    });
  }

  call(method: string, params: unknown): Promise<unknown> {
    const run = this.queue.then(() => this.exchange(method, params));
    this.queue = run.catch(() => {});
    return run;
  }
}
