/**
 * Remembers that a device on the network just did not answer, so the next calls say so at once instead of each waiting for its own
 * timeout (a voice answer that waits 3-6 seconds per device is slow). After `holdMs` the next call tries the device for real again,
 * and any answer clears the memory at once. Nothing runs in the background.
 */
export class DownMemo {
  private downAt = 0;

  constructor(
    private readonly holdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get isDown(): boolean {
    return this.downAt > 0 && this.now() - this.downAt < this.holdMs;
  }

  /** The device did not answer. */
  fail(): void {
    this.downAt = this.now();
  }

  /** The device answered (even with a refusal): it is reachable. */
  ok(): void {
    this.downAt = 0;
  }
}
