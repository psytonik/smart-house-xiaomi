import type { Config } from "./config.js";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const PTZ_OPERATIONS = { left: 1, right: 2, up: 3, down: 4 } as const;
export type PtzDirection = keyof typeof PTZ_OPERATIONS;

/**
 * go2rtc only talks to the camera while somebody consumes the stream, and the
 * Xiaomi camera allows a single session. PTZ commands go through that session,
 * so before moving the camera we hold a (discarded) consumer open for a while.
 */
class StreamKeeper {
  private ctrl?: AbortController;
  private timer?: NodeJS.Timeout;

  constructor(
    private cfg: Config,
    private log: (msg: string) => void,
  ) {}

  ensure(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.cfg.keepAliveMs);
    this.timer.unref();
    if (this.ctrl) return;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    void this.run(ctrl);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.ctrl?.abort();
    this.ctrl = undefined;
  }

  private async run(ctrl: AbortController): Promise<void> {
    try {
      const url = `${this.cfg.go2rtcUrl}/api/stream.mp4?src=${encodeURIComponent(this.cfg.stream)}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      while (!(await reader.read()).done) {
        /* discard */
      }
    } catch {
      /* aborted or camera unavailable */
    } finally {
      if (this.ctrl === ctrl) this.ctrl = undefined;
      this.log("stream keeper: consumer closed");
    }
  }
}

export class Go2rtc {
  private keeper: StreamKeeper;

  constructor(
    private cfg: Config,
    log: (msg: string) => void = () => {},
  ) {
    this.keeper = new StreamKeeper(cfg, log);
  }

  close(): void {
    this.keeper.stop();
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const q = new URLSearchParams({ src: this.cfg.stream, ...params });
    return `${this.cfg.go2rtcUrl}${path}?${q}`;
  }

  /** Raw GET to go2rtc; the stream name is always forced to the configured one. */
  async get(path: string, params: Record<string, string> = {}): Promise<Response> {
    try {
      return await fetch(this.url(path, params));
    } catch {
      throw new HttpError(502, "go2rtc is unreachable");
    }
  }

  async postText(path: string, body: string, contentType: string): Promise<Response> {
    try {
      return await fetch(this.url(path), {
        method: "POST",
        body,
        headers: { "content-type": contentType },
      });
    } catch {
      throw new HttpError(502, "go2rtc is unreachable");
    }
  }

  async move(direction: PtzDirection): Promise<void> {
    const op = String(PTZ_OPERATIONS[direction]);
    this.keeper.ensure();

    let lastError = "";
    for (let attempt = 0; attempt < this.cfg.warmupAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url("/api/xiaomi/motor", { operation: op }), { method: "POST" });
      } catch {
        throw new HttpError(502, "go2rtc is unreachable");
      }
      if (res.ok) return;
      lastError = (await res.text()).trim();
      // 404 = the camera session is not up yet (or this go2rtc build has no motor support)
      if (res.status !== 404) break;
      await sleep(this.cfg.warmupPollMs);
    }
    throw new HttpError(
      502,
      `camera did not accept the move (${lastError || "no response"}). Is go2rtc the motor build and the stream online?`,
    );
  }
}
