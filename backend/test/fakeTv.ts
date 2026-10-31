import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { ensureCertificate } from "../src/tv/cert.js";
import { enc, FrameReader, fields, frame, intOf, strOf, bufOf } from "../src/tv/wire.js";

const keyBytes = (c: X509Certificate) => {
  const jwk = c.publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return Buffer.concat([Buffer.from(jwk.n, "base64url"), Buffer.from(jwk.e, "base64url")]);
};
const pairingReply = (status: number, ...payload: Buffer[]) => frame(Buffer.concat([enc.int(1, 2), enc.int(2, status), ...payload]));

/**
 * A pretend Google TV: a TLS server on a pairing port and a remote port that speaks the Android TV Remote protocol the way the
 * real one does (it computes the pairing code itself from both keys), and records what it was told to do.
 */
export async function startFakeTv(options: { refusePairing?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-tv-"));
  const cert = await ensureCertificate(dir, "tv", "fake-tv");
  const tvKey = keyBytes(new X509Certificate(cert.cert));

  const state = {
    /** The code the TV "shows", known after the pairing handshake got far enough. */
    code: undefined as string | undefined,
    pairedFingerprint: undefined as string | undefined,
    keys: [] as Array<{ code: number; direction: number }>,
    links: [] as string[],
    pongs: [] as number[],
    remoteConnections: 0,
    refusePairing: options.refusePairing ?? false,
    sockets: new Set<TLSSocket>(),
  };

  const pairingServer = tls.createServer({ key: cert.key, cert: cert.cert, requestCert: true, rejectUnauthorized: false }, (socket) => {
    const reader = new FrameReader();
    let expected: Buffer | undefined;
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      for (const f of reader.push(chunk)) {
        const m = fields(f);
        if (state.refusePairing) return void socket.write(pairingReply(400));
        if (bufOf(m, 10)) socket.write(pairingReply(200, enc.msg(11, enc.str(1, "Fake TV"))));
        else if (bufOf(m, 20)) socket.write(pairingReply(200, enc.msg(20, enc.msg(1, enc.int(1, 3), enc.int(2, 6)), enc.int(3, 1))));
        else if (bufOf(m, 30)) {
          const nonce = Buffer.from([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
          const clientKey = keyBytes(new X509Certificate(socket.getPeerCertificate(true).raw));
          expected = createHash("sha256").update(clientKey).update(tvKey).update(nonce).digest();
          state.code = (Buffer.from([expected[0]!]).toString("hex") + nonce.toString("hex")).toUpperCase();
          state.pairedFingerprint = socket.getPeerCertificate().fingerprint256;
          socket.write(pairingReply(200, enc.msg(31)));
        } else if (bufOf(m, 40)) {
          const secret = bufOf(fields(bufOf(m, 40)!), 1);
          if (expected && secret?.equals(expected)) socket.write(pairingReply(200, enc.msg(41, enc.bytes(1, expected))));
          else socket.write(pairingReply(402));
        }
      }
    });
  });

  const remoteServer = tls.createServer({ key: cert.key, cert: cert.cert, requestCert: true, rejectUnauthorized: false }, (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("error", () => undefined);
    // only a remote that was paired is let in
    if (!state.pairedFingerprint || socket.getPeerCertificate().fingerprint256 !== state.pairedFingerprint) return void socket.destroy();
    state.remoteConnections++;
    const reader = new FrameReader();
    socket.write(frame(enc.msg(1, enc.int(1, 622), enc.msg(2, enc.str(1, "Fake TV"), enc.str(2, "Fake")))));
    socket.on("data", (chunk) => {
      for (const f of reader.push(chunk)) {
        const m = fields(f);
        if (bufOf(m, 1)) socket.write(frame(enc.msg(2, enc.int(1, 622))));
        else if (bufOf(m, 2)) {
          socket.write(frame(enc.msg(40, enc.bool(1, true))));
          socket.write(frame(enc.msg(50, enc.int(6, 100), enc.int(7, 35), enc.bool(8, false))));
          socket.write(frame(enc.msg(20, enc.msg(1, enc.str(12, "com.example.player")))));
        } else if (bufOf(m, 10)) {
          const k = fields(bufOf(m, 10)!);
          state.keys.push({ code: intOf(k, 1) ?? 0, direction: intOf(k, 2) ?? 0 });
        } else if (bufOf(m, 90)) state.links.push(strOf(fields(bufOf(m, 90)!), 1) ?? "");
        else if (bufOf(m, 9)) state.pongs.push(intOf(fields(bufOf(m, 9)!), 1) ?? 0);
      }
    });
  });

  const listen = (server: tls.Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const [pairingPort, remotePort] = await Promise.all([listen(pairingServer), listen(remoteServer)]);

  return {
    pairingPort,
    remotePort,
    state,
    /** Sends the remote a ping and returns when it was answered. */
    ping(value: number) {
      for (const s of state.sockets) s.write(frame(enc.msg(8, enc.int(1, value))));
    },
    /** Hangs up on every connected remote (the TV went to sleep). */
    hangUp() {
      for (const s of state.sockets) s.destroy();
    },
    sendToRemotes(message: Buffer) {
      for (const s of state.sockets) s.write(message);
    },
    async close() {
      for (const s of state.sockets) s.destroy();
      await Promise.all([new Promise((r) => pairingServer.close(r)), new Promise((r) => remoteServer.close(r))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
