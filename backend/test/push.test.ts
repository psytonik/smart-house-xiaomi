import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { MotionClip } from "../src/events.js";
import { PushService } from "../src/push.js";

const A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const dirs: string[] = [];

/** 14:32:05 local time, so the formatted time does not depend on the machine's timezone. */
const at = (h: number, m: number) => new Date(2026, 9, 30, h, m, 5).toISOString();
function clip(id: string, over: Partial<MotionClip> = {}): MotionClip {
  return { id, startedAt: at(14, 32), endedAt: at(14, 32), durationSec: 12.4, peak: 3, bytes: 1, clip: `${id}.mp4`, thumb: null, ...over };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  messages: Array<{ to: string; title: string; body: string; data: { clipId: string }; sound?: string; channelId?: string }>;
}

function harness(opts: { intervalSec?: number; accessToken?: string; reply?: (messages: Sent["messages"]) => unknown; fail?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cam-push-"));
  dirs.push(dir);
  let t = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const sent: Sent[] = [];
  const logs: string[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (opts.fail) throw new Error("network down");
    const messages = JSON.parse(init.body);
    sent.push({ url, headers: init.headers, messages });
    const data = opts.reply ? opts.reply(messages) : messages.map(() => ({ status: "ok", id: "t" }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  const make = () =>
    new PushService(
      { dataDir: dir, pushUrl: "https://expo.test/send", pushMinIntervalSec: opts.intervalSec ?? 120, expoAccessToken: opts.accessToken ?? "" },
      {
        fetch: fakeFetch,
        now: () => t,
        schedule: (fn, ms) => {
          const timer = { fn, at: t + ms, live: true };
          timers.push(timer);
          return { cancel: () => (timer.live = false) };
        },
        log: (m) => logs.push(m),
      },
    );
  const advance = async (ms: number) => {
    t += ms;
    for (const timer of timers.filter((x) => x.live && x.at <= t)) {
      timer.live = false;
      timer.fn();
    }
    await new Promise((r) => setImmediate(r)); // let the async send finish
  };
  return { dir, make, sent, logs, advance, timers };
}

describe("PushService devices", () => {
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("registers valid Expo tokens once, keeps them across restarts and can remove them", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    assert.equal(await push.register(A), true);
    assert.equal(await push.register(A), false, "already known");
    await push.register(B);
    assert.equal(push.devices(), 2);

    const again = h.make();
    await again.init();
    assert.equal(again.devices(), 2, "survives a restart");

    assert.equal(await again.unregister(A), true);
    assert.equal(await again.unregister(A), false);
    assert.equal(again.devices(), 1);
  });

  it("refuses things that are not Expo push tokens", async () => {
    const push = harness().make();
    await push.init();
    for (const bad of ["", "abc", "ExponentPushToken[]", "ExponentPushToken[a b]", "Bearer x", `ExponentPushToken[${"a".repeat(200)}]`]) {
      await assert.rejects(push.register(bad), /token/i, bad);
    }
  });

  it("keeps at most 20 devices", async () => {
    const push = harness().make();
    await push.init();
    for (let i = 0; i < 20; i++) await push.register(`ExponentPushToken[device${String(i).padStart(10, "0")}]`);
    await assert.rejects(push.register(A), /too many/i);
  });

  it("stores the tokens in a file inside the data dir", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    await push.register(A);
    assert.match(readFileSync(join(h.dir, "push-devices.json"), "utf8"), /aaaaaaaaaaaaaaaaaaaaaa/);
  });
});

describe("PushService notifications", () => {
  beforeEach(() => undefined);

  it("sends nothing when no device is registered", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    await push.notifyClip(clip("c1"));
    assert.equal(h.sent.length, 0);
  });

  it("sends one message per device with the time, the length and the clip to open", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.register(B);
    await push.notifyClip(clip("20261030T123205000Z"));

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.url, "https://expo.test/send");
    assert.deepEqual(h.sent[0]!.messages.map((m) => m.to), [A, B]);
    const m = h.sent[0]!.messages[0]!;
    assert.equal(m.title, "Motion detected");
    assert.equal(m.body, "14:32 · 12 s");
    assert.deepEqual(m.data, { clipId: "20261030T123205000Z", type: "motion" });
    assert.equal(m.channelId, "motion");
    assert.ok(!("authorization" in h.sent[0]!.headers), "no access token configured");
  });

  it("says what was seen when the clip was analysed", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.notifyClip(clip("c1", { objects: [{ label: "person", score: 0.9 }, { label: "vehicle", score: 0.6 }] }));
    assert.equal(h.sent[0]!.messages[0]!.body, "14:32 · 12 s · person, vehicle");
    await h.advance(200_000);
    await push.notifyClip(clip("c2", { objects: [] }));
    assert.equal(h.sent[1]!.messages[0]!.body, "14:32 · 12 s", "analysed but nothing found: no label");
  });

  it("formats longer clips in minutes", async () => {
    const h = harness();
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.notifyClip(clip("c1", { durationSec: 125 }));
    await push.notifyClip(clip("c2", { durationSec: 120 }));
    await h.advance(120_000);
    assert.equal(h.sent[0]!.messages[0]!.body, "14:32 · 2 min 5 s");
  });

  it("sends the Expo access token when one is configured", async () => {
    const h = harness({ accessToken: "secret-expo-token" });
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.notifyClip(clip("c1"));
    assert.equal(h.sent[0]!.headers.authorization, "Bearer secret-expo-token");
  });

  it("limits the rate: the first clip goes out at once, the rest become one summary", async () => {
    const h = harness({ intervalSec: 120 });
    const push = h.make();
    await push.init();
    await push.register(A);

    await push.notifyClip(clip("c1"));
    assert.equal(h.sent.length, 1);

    await h.advance(10_000);
    await push.notifyClip(clip("c2", { startedAt: at(14, 33) }));
    await h.advance(10_000);
    await push.notifyClip(clip("c3", { startedAt: at(14, 34) }));
    assert.equal(h.sent.length, 1, "held back inside the interval");

    await h.advance(100_000); // 120 s after the first push
    assert.equal(h.sent.length, 2);
    const summary = h.sent[1]!.messages[0]!;
    assert.equal(summary.title, "Motion detected");
    assert.equal(summary.body, "2 more events, last at 14:34");
    assert.equal(summary.data.clipId, "c3", "opens the newest clip");

    await h.advance(200_000); // quiet for a long time, nothing more pending
    assert.equal(h.sent.length, 2);
    await push.notifyClip(clip("c4"));
    assert.equal(h.sent.length, 3, "a new clip after the interval goes out at once");
    assert.equal(h.sent[2]!.messages[0]!.body, "14:32 · 12 s");
  });

  it("does not hold anything back when the interval is 0", async () => {
    const h = harness({ intervalSec: 0 });
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.notifyClip(clip("c1"));
    await push.notifyClip(clip("c2"));
    assert.equal(h.sent.length, 2);
  });

  it("forgets a device that Expo says is no longer registered", async () => {
    const h = harness({
      reply: (messages) => messages.map((m) => (m.to === B ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" })),
    });
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.register(B);
    await push.notifyClip(clip("c1"));
    assert.equal(push.devices(), 1);

    const again = h.make();
    await again.init();
    assert.equal(again.devices(), 1, "removed from the file too");
  });

  it("a network failure is logged, never thrown, and keeps the devices", async () => {
    const h = harness({ fail: true });
    const push = h.make();
    await push.init();
    await push.register(A);
    await push.notifyClip(clip("c1")); // must not reject: it runs inside the recorder's event handler
    assert.equal(push.devices(), 1);
    assert.ok(h.logs.some((l) => /push/i.test(l)));
  });

  it("test notifications ignore the rate limit and report how many devices got one", async () => {
    const h = harness({ intervalSec: 3600 });
    const push = h.make();
    await push.init();
    assert.equal(await push.sendTest(), 0);
    await push.register(A);
    await push.notifyClip(clip("c1"));
    assert.equal(await push.sendTest(), 1);
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1]!.messages[0]!.title, /test/i);
  });

  it("listens to the recorder's clip events, and close() drops a pending summary", async () => {
    const h = harness({ intervalSec: 120 });
    const push = h.make();
    await push.init();
    await push.register(A);
    const recorder = new EventEmitter();
    push.attach(recorder);

    recorder.emit("clip", clip("c1"));
    recorder.emit("clip", clip("c2"));
    await h.advance(1);
    assert.equal(h.sent.length, 1);

    push.close();
    await h.advance(500_000);
    assert.equal(h.sent.length, 1, "the summary was cancelled");
  });
});
