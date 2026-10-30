export class QueueFullError extends Error {
  constructor() {
    super("queue is full");
  }
}

/**
 * Runs async tasks strictly one after another, in arrival order. The camera accepts one pan/tilt
 * command at a time over its single session, so concurrent PTZ requests (two browsers, a held button
 * plus a keyboard repeat) must not overlap.
 *
 * `maxPending` counts the running task plus the waiting ones. Beyond it `run` rejects with
 * QueueFullError instead of letting a backlog build up: a stale "move left" executed ten seconds
 * later is worse than a refusal.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly maxPending: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxPending) return Promise.reject(new QueueFullError());
    this.pending++;
    const result = this.tail.then(task);
    // The next task waits for this one to settle, whether it succeeded or failed.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
    });
  }
}
