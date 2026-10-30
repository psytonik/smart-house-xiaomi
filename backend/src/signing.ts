import { createHmac, timingSafeEqual } from "node:crypto";

/** The only paths that may be opened with a signed link instead of the Authorization header. */
const SIGNABLE = [
  /^\/api\/events\/\d{8}T\d{9}Z\/(?:clip|thumb)$/,
  /^\/api\/snapshots\/\d{8}T\d{9}Z\.jpg$/,
];

export const isSignable = (path: string): boolean => SIGNABLE.some((re) => re.test(path));

/**
 * Signed, expiring links for media files. <video> and <img> cannot send an Authorization header,
 * so the API hands out `path?exp=<unix s>&sig=<hmac>` instead of making the client download
 * whole files into memory. A link opens exactly one file and only with GET/HEAD.
 *
 * The key is derived from API_TOKEN: changing the token revokes every link.
 * Expiry is rounded to a fixed grid, so the same file gets the same link for half a TTL
 * (browser cache stays warm, lists polled every few seconds do not reload thumbnails).
 * A fresh link stays valid for between ttl/2 and ttl.
 */
export class UrlSigner {
  private readonly key: Buffer;
  private readonly step: number;

  constructor(
    secret: string,
    ttlSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac("sha256", "media-url-v1").update(secret).digest();
    this.step = Math.max(1, Math.floor(ttlSec / 2));
  }

  private mac(path: string, exp: number): Buffer {
    return createHmac("sha256", this.key).update(`${path}\n${exp}`).digest();
  }

  /** Returns `path` with the `exp` and `sig` query parameters appended. */
  sign(path: string): string {
    const exp = (Math.floor(this.now() / 1000 / this.step) + 2) * this.step;
    return `${path}?exp=${exp}&sig=${this.mac(path, exp).toString("hex")}`;
  }

  verify(path: string, exp: unknown, sig: unknown): boolean {
    if (typeof exp !== "string" || typeof sig !== "string") return false;
    if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const expiresAt = Number(exp);
    if (expiresAt * 1000 <= this.now()) return false;
    return isSignable(path) && timingSafeEqual(this.mac(path, expiresAt), Buffer.from(sig, "hex"));
  }
}
