import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { ensureCertificate, type Certificate } from "./tv/cert.js";
import { APPS, KEYS, pairing, remote, type TvApp, type TvKey } from "./tv/messages.js";
import { FrameReader } from "./tv/wire.js";

/** Something the TV (or the state it is in) doesn't allow. `status` is the HTTP code for it. */
export class TvError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export type TvLink = "offline" | "connecting" | "ready";

export interface TvStatus {
  /** This app has been paired with the TV: it will accept commands. */
  paired: boolean;
  link: TvLink;
  /** The TV is showing a code: type it in. */
  waitingForCode: boolean;
  /** The screen is on. Unknown until the TV says. */
  powered?: boolean;
  volume?: { level: number; max: number; muted: boolean };
  /** Android package of the app in front, e.g. com.google.android.youtube.tv */
  app?: string;
}

export interface TvOptions {
  host: string;
  dataDir: string;
  remotePort?: number;
  pairingPort?: number;
  /** Name the TV shows for this remote. */
  name?: string;
  log?: (message: string) => void;
}

const CLIENT = "tv-client";
const PAIRED_FILE = "tv.json";
const RECONNECT_MS = [2_000, 5_000, 10_000, 30_000];
const PAIRING_STEP_MS = 15_000;
/** The TV keeps the code on the screen for a while; give the person time to walk to it and read it. */
const CODE_WAIT_MS = 5 * 60_000;

/** The public key of a certificate as the pairing handshake hashes it: modulus and exponent, big-endian. */
function publicKeyBytes(cert: X509Certificate): Buffer {
  const jwk = cert.publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) throw new TvError("the certificate has no RSA key");
  return Buffer.concat([Buffer.from(jwk.n, "base64url"), Buffer.from(jwk.e, "base64url")]);
}

interface PairingSession {
  socket: TLSSocket;
  state: "starting" | "waiting-for-code" | "confirming";
  /** Called when the TV acknowledges the secret. */
  onSecretAck?: () => void;
  onFail?: (e: TvError) => void;
}

/**
 * A remote control for a Google TV / Android TV (TCL and others) over the local network: the Android TV Remote protocol v2.
 * Pair once (the TV shows a six-character code, you type it here), then the app keeps a connection open, follows what the TV
 * says (screen on, volume, the app in front) and sends keys and app links. Nothing leaves the home network.
 */
export class TvRemote {
  private link: TvLink = "offline";
  private powered?: boolean;
  private volume?: TvStatus["volume"];
  private app?: string;

  private paired: boolean;
  private certificate?: Promise<Certificate>;
  private socket?: TLSSocket;
  private session?: PairingSession;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private stopped = true;

  private readonly remotePort: number;
  private readonly pairingPort: number;
  private readonly name: string;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: TvOptions) {
    this.remotePort = opts.remotePort ?? 6466;
    this.pairingPort = opts.pairingPort ?? 6467;
    this.name = opts.name ?? "psytonik base";
    this.log = opts.log ?? (() => undefined);
    this.paired = this.readPaired();
  }

  status(): TvStatus {
    return {
      paired: this.paired,
      link: this.link,
      waitingForCode: this.session?.state === "waiting-for-code",
      ...(this.powered !== undefined && { powered: this.powered }),
      ...(this.volume && { volume: this.volume }),
      ...(this.app && { app: this.app }),
    };
  }

  /** Starts keeping the connection open (if this app is paired). */
  start(): void {
    this.stopped = false;
    if (this.paired) void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.session?.socket.destroy();
    this.session = undefined;
  }

  // ---------- keys ----------
  press(key: TvKey): void {
    this.send(remote.key(KEYS[key]));
  }

  launch(app: TvApp): void {
    const link = APPS[app]?.link;
    if (!link) throw new TvError("this app opens another way", 400);
    this.send(remote.appLink(link));
  }

  private send(message: Buffer): void {
    if (!this.socket || this.link !== "ready") throw new TvError("the TV is not answering: it may be off, or not on this network", 503);
    this.socket.write(message);
  }

  // ---------- the connection ----------
  private readPaired(): boolean {
    try {
      const file = join(this.opts.dataDir, PAIRED_FILE);
      return existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { host?: string }).host === this.opts.host;
    } catch {
      return false;
    }
  }

  private cert(): Promise<Certificate> {
    this.certificate ??= ensureCertificate(this.opts.dataDir, CLIENT, "psytonik-base").catch((e) => {
      this.certificate = undefined; // try again next time
      throw e;
    });
    return this.certificate;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket || this.session) return;
    let cert: Certificate;
    try {
      cert = await this.cert();
    } catch (e) {
      this.log(`tv: ${(e as Error).message}`);
      return this.retryLater();
    }
    if (this.stopped || this.socket) return;
    this.link = "connecting";
    const socket = tls.connect({ host: this.opts.host, port: this.remotePort, key: cert.key, cert: cert.cert, rejectUnauthorized: false });
    this.socket = socket;
    const reader = new FrameReader();
    // the TV pings every few seconds; a connection that has gone silent is dead
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      try {
        for (const frame of reader.push(chunk)) this.onRemoteMessage(socket, remote.parse(frame));
      } catch (e) {
        this.log(`tv: ${(e as Error).message}`);
        socket.destroy();
      }
    });
    socket.on("error", (e) => this.log(`tv: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.link = "offline";
      this.powered = undefined; // the TV can't be asked: don't pretend to know
      this.retryLater();
    });
  }

  private onRemoteMessage(socket: TLSSocket, m: ReturnType<typeof remote.parse>): void {
    switch (m.kind) {
      case "configure":
        socket.write(remote.configure("psytonik base", "psytonik", "base.psytonik.remote", "1.0.0"));
        break;
      case "set-active":
        socket.write(remote.setActive());
        this.link = "ready";
        this.attempt = 0;
        break;
      case "ping":
        socket.write(remote.pong(m.value));
        break;
      case "power":
        this.powered = m.on;
        break;
      case "volume":
        this.volume = { level: m.level, max: m.max, muted: m.muted };
        break;
      case "app":
        this.app = m.app;
        break;
      case "error":
        this.log("tv: the TV reported an error for a command");
        break;
    }
  }

  private retryLater(): void {
    if (this.stopped || !this.paired) return;
    clearTimeout(this.timer);
    const wait = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)]!;
    this.timer = setTimeout(() => void this.connect(), wait);
    this.timer.unref();
  }

  // ---------- pairing ----------
  /** Asks the TV to show a pairing code. Resolves when it does. */
  async beginPairing(): Promise<void> {
    this.session?.socket.destroy();
    this.session = undefined;
    clearTimeout(this.timer);
    this.socket?.destroy(); // the TV talks to one remote connection at a time while pairing
    this.socket = undefined;
    this.link = "offline";
    const cert = await this.cert().catch((e: Error) => {
      throw new TvError(e.message);
    });
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({ host: this.opts.host, port: this.pairingPort, key: cert.key, cert: cert.cert, rejectUnauthorized: false });
      const session: PairingSession = { socket, state: "starting" };
      this.session = session;
      const reader = new FrameReader();
      let settled = false;
      const fail = (e: TvError) => {
        session.onFail?.(e);
        if (this.session === session) this.session = undefined;
        socket.destroy();
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      const step = setTimeout(() => fail(new TvError("the TV did not answer the pairing request")), PAIRING_STEP_MS);
      socket.on("secureConnect", () => socket.write(pairing.request("base.psytonik.remote", this.name)));
      socket.on("data", (chunk) => {
        try {
          for (const frame of reader.push(chunk)) {
            const m = pairing.parse(frame);
            if (m.status !== 200) return fail(new TvError(`the TV refused pairing (status ${m.status})`));
            if (m.kind === "request-ack") socket.write(pairing.option());
            else if (m.kind === "option") socket.write(pairing.configuration());
            else if (m.kind === "configuration-ack") {
              clearTimeout(step);
              session.state = "waiting-for-code";
              settled = true;
              resolve();
              const wait = setTimeout(() => fail(new TvError("the code was not entered in time: start pairing again", 408)), CODE_WAIT_MS);
              wait.unref();
              socket.once("close", () => clearTimeout(wait));
            } else if (m.kind === "secret-ack") session.onSecretAck?.();
          }
        } catch (e) {
          fail(new TvError((e as Error).message));
        }
      });
      socket.on("error", (e) => fail(new TvError(`could not reach the TV (${(e as NodeJS.ErrnoException).code ?? e.message})`, 503)));
      socket.on("close", () => {
        clearTimeout(step);
        if (this.session === session && session.state !== "confirming") this.session = undefined;
        if (!settled) fail(new TvError("the TV closed the pairing connection"));
      });
    });
  }

  /** Checks the code the TV shows and tells the TV it matched. Throws for a mistyped code, and the TV keeps waiting for another. */
  async finishPairing(code: string): Promise<void> {
    const session = this.session;
    if (!session || session.state !== "waiting-for-code") throw new TvError("start pairing first", 409);
    if (!/^[0-9a-fA-F]{6}$/.test(code)) throw new TvError("the code is six characters, digits and letters A to F", 400);
    const cert = await this.cert();
    const ours = publicKeyBytes(new X509Certificate(cert.cert));
    const peer = session.socket.getPeerCertificate(true);
    if (!peer?.raw) throw new TvError("the TV showed no certificate");
    const theirs = publicKeyBytes(new X509Certificate(peer.raw));
    const bytes = Buffer.from(code, "hex");
    // the first byte of the code is a check: the hash of both keys and the rest of the code must start with it
    const hash = createHash("sha256").update(ours).update(theirs).update(bytes.subarray(1)).digest();
    if (hash[0] !== bytes[0]) throw new TvError("that is not the code the TV shows: check it and try again", 400);

    session.state = "confirming";
    await new Promise<void>((resolve, reject) => {
      const wait = setTimeout(() => reject(new TvError("the TV did not confirm the code")), PAIRING_STEP_MS);
      session.onSecretAck = () => {
        clearTimeout(wait);
        resolve();
      };
      session.onFail = (e) => {
        clearTimeout(wait);
        reject(e);
      };
      session.socket.write(pairing.secret(hash));
    }).catch((e) => {
      session.state = "waiting-for-code";
      throw e;
    });

    writeFileSync(join(this.opts.dataDir, PAIRED_FILE), JSON.stringify({ host: this.opts.host, pairedAt: new Date().toISOString() }), { mode: 0o600 });
    this.paired = true;
    this.session = undefined;
    session.socket.destroy();
    this.attempt = 0;
    this.stopped = false;
    void this.connect();
  }

  /** Drops an unfinished pairing (the code window was closed). */
  cancelPairing(): void {
    this.session?.socket.destroy();
    this.session = undefined;
  }
}
