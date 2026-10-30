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

  /** The go2rtc stream the browser's microphone is published to while you talk. */
  get talkStream(): string {
    return `${this.cfg.stream}_talk`;
  }

  /**
   * Takes the browser's microphone (a WebRTC offer, Opus) into its own go2rtc stream and returns go2rtc's answer.
   * Only the destination stream is named, and by us: the request cannot choose a stream or a source.
   */
  async publishTalk(sdp: string): Promise<string> {
    let res: Response;
    try {
      await this.stopTalk(); // an old bridge would keep writing into the speaker next to the new one
      await this.ensureTalkStream();
      res = await fetch(`${this.cfg.go2rtcUrl}/api/webrtc?${new URLSearchParams({ dst: this.talkStream })}`, {
        method: "POST",
        body: sdp,
        headers: { "content-type": "application/sdp" },
      });
    } catch {
      throw new HttpError(502, "go2rtc is unreachable");
    }
    if (!res.ok) throw new HttpError(502, `go2rtc did not take the microphone (${res.status})`);
    return res.text();
  }

  /**
   * Ends talking: deleting the microphone stream closes the ffmpeg that was playing it into the camera, which removes the
   * bridge. Without this every conversation leaves one bridge behind, and they all write into the one speaker (crackling).
   * Safe to call when nothing is running.
   */
  async stopTalk(): Promise<void> {
    try {
      await fetch(`${this.cfg.go2rtcUrl}/api/streams?${new URLSearchParams({ src: this.talkStream })}`, { method: "DELETE" });
    } catch {
      /* go2rtc is not there: nothing is playing */
    }
  }

  /**
   * go2rtc only lets a browser publish into a stream that already exists. The first time, the stream is created
   * (go2rtc keeps it in its config file, so this happens once); "webrtc:" is a placeholder source that is never dialled
   * out, the browser's own connection becomes the producer.
   */
  private async ensureTalkStream(): Promise<void> {
    const has = await fetch(`${this.cfg.go2rtcUrl}/api/streams?${new URLSearchParams({ src: this.talkStream })}`);
    if (has.ok) return;
    const q = new URLSearchParams({ name: this.talkStream, src: "webrtc:" });
    const made = await fetch(`${this.cfg.go2rtcUrl}/api/streams?${q}`, { method: "PUT" });
    if (!made.ok) throw new HttpError(502, `go2rtc would not create the microphone stream (${made.status})`);
  }

  /**
   * Plays the microphone stream into the camera's speaker. The camera takes only A-law 16 kHz and the browser sends
   * Opus, so ffmpeg (started by go2rtc) converts it. Waits for the microphone stream to arrive first; false if it never does.
   * It ends by itself when the browser closes the microphone stream.
   */
  async bridgeTalk(): Promise<boolean> {
    this.keeper.ensure(); // the speaker is part of the camera session
    let ready = false;
    for (let attempt = 0; attempt < this.cfg.warmupAttempts && !ready; attempt++) {
      try {
        const res = await fetch(`${this.cfg.go2rtcUrl}/api/streams?${new URLSearchParams({ src: this.talkStream })}`);
        const info = res.ok ? ((await res.json()) as { producers?: Array<{ receivers?: unknown[] }> }) : {};
        ready = (info.producers ?? []).some((p) => (p.receivers?.length ?? 0) > 0);
      } catch {
        /* go2rtc busy: look again */
      }
      if (!ready) await sleep(this.cfg.warmupPollMs);
    }
    if (!ready) return false;
    const q = new URLSearchParams({ dst: this.cfg.stream, src: `ffmpeg:${this.talkStream}#audio=pcma/16000` });
    try {
      return (await fetch(`${this.cfg.go2rtcUrl}/api/streams?${q}`, { method: "POST" })).ok;
    } catch {
      return false;
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
