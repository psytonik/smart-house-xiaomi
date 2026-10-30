/**
 * Brute-force guard for the bearer token. It counts only wrong tokens per client address:
 * normal traffic (polling, holding a PTZ button, thumbnails) never touches it, and requests
 * without credentials (a signed link that has expired) are not guesses and are not counted.
 *
 * After `max` wrong tokens within `windowMs` the address is locked until the oldest of them
 * leaves the window. State lives in memory: a restart clears it.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked addresses, so a flood from many addresses cannot grow memory. */
    private readonly maxTracked = 10_000,
  ) {}

  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }

  /** Seconds until the address may try again, or 0 if it is not locked. */
  retryAfterSec(ip: string): number {
    const list = this.recent(ip);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  /** Records a wrong token. */
  fail(ip: string): void {
    const list = this.recent(ip);
    list.push(this.now());
    this.failures.set(ip, list);
    if (this.failures.size > this.maxTracked) {
      // Map keeps insertion order: drop the least recently added address.
      this.failures.delete(this.failures.keys().next().value as string);
    }
  }

  /** A correct token clears the record for the address. */
  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}
