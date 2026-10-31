import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Certificate {
  /** PEM, PKCS#8 */
  key: string;
  /** PEM */
  cert: string;
}

/**
 * The TV tells its remotes apart by a certificate they present, so this app needs one of its own, made once and kept in the
 * data directory (mode 600, never leaves this machine). Node can read certificates but not issue them, so `openssl` makes it:
 * a self-signed RSA-2048 certificate valid for a hundred years, the way the Android TV Remote protocol expects.
 */
export async function ensureCertificate(dir: string, name: string, commonName: string): Promise<Certificate> {
  if (!/^[A-Za-z0-9 _-]{1,40}$/.test(commonName)) throw new Error("the certificate name may only have letters, digits, space, _ and -");
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    mkdirSync(dir, { recursive: true });
    try {
      await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "36500", "-subj", `/CN=${commonName}`, "-keyout", keyFile, "-out", certFile], { timeout: 30_000 });
    } catch (e) {
      throw new Error(`could not make the TV certificate: ${(e as Error).message.split("\n")[0]} (openssl is needed)`);
    }
    chmodSync(keyFile, 0o600);
    chmodSync(certFile, 0o600);
  }
  return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
}
