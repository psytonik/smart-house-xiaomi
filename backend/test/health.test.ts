import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assess, type HealthInput } from "../src/health.js";

const GB = 1024 ** 3;
const base: HealthInput = {
  go2rtc: { reachable: true },
  recorder: { enabled: true, state: "running", frameAgeSec: 0.3, damagedLastMinute: 0, restarts: 0, stalls: 0 },
  storage: { clips: 12, usedBytes: 2 * GB, limitBytes: 20 * GB, freeBytes: 100 * GB },
  push: { devices: 1 },
  detection: { state: "ready", model: "yolox_tiny.onnx" },
};
const with_ = (over: { [K in keyof HealthInput]?: Partial<HealthInput[K]> }): HealthInput => ({
  go2rtc: { ...base.go2rtc, ...over.go2rtc },
  recorder: { ...base.recorder, ...over.recorder },
  storage: { ...base.storage, ...over.storage },
  push: { ...base.push, ...over.push },
  detection: { ...base.detection, ...over.detection },
});
const check = (h: ReturnType<typeof assess>, id: string) => h.checks.find((c) => c.id === id)!;

describe("assess", () => {
  it("everything fine: overall ok, one line per area", () => {
    const h = assess(base);
    assert.equal(h.level, "ok");
    assert.deepEqual(h.checks.map((c) => c.id), ["go2rtc", "picture", "detection", "disk", "storage", "push"]);
    assert.ok(h.checks.every((c) => c.title && c.detail));
  });

  it("go2rtc down is an error that says how to fix it", () => {
    const h = assess(with_({ go2rtc: { reachable: false } }));
    assert.equal(h.level, "error");
    assert.equal(check(h, "go2rtc").level, "error");
    assert.match(check(h, "go2rtc").detail, /camera\.sh/);
  });

  it("a damaged picture is a warning that names packet loss", () => {
    const h = assess(with_({ recorder: { damagedLastMinute: 240 } }));
    assert.equal(h.level, "warn");
    assert.equal(check(h, "picture").level, "warn");
    assert.match(check(h, "picture").detail, /packet/i);
    assert.match(check(h, "picture").title, /240/);
  });

  it("a silent stream is a warning once frames are older than 10 s", () => {
    assert.equal(check(assess(with_({ recorder: { frameAgeSec: 9 } })), "picture").level, "ok");
    const h = assess(with_({ recorder: { frameAgeSec: 25 } }));
    assert.equal(check(h, "picture").level, "warn");
    assert.match(check(h, "picture").title, /25/);
  });

  it("ffmpeg missing is an error, reconnecting a warning, connecting and 'off' are just information", () => {
    assert.equal(check(assess(with_({ recorder: { state: "ffmpeg-missing" } })), "picture").level, "error");
    assert.match(check(assess(with_({ recorder: { state: "ffmpeg-missing" } })), "picture").detail, /brew install ffmpeg/);
    assert.equal(check(assess(with_({ recorder: { state: "restarting" } })), "picture").level, "warn");
    const starting = assess(with_({ recorder: { state: "starting", frameAgeSec: null } }));
    assert.equal(check(starting, "picture").level, "info");
    assert.equal(starting.level, "ok");
    const off = assess(with_({ recorder: { enabled: false, state: "off", frameAgeSec: null } }));
    assert.equal(check(off, "picture").level, "info");
    assert.match(check(off, "picture").detail, /MOTION_ENABLED/);
  });

  it("low disk space: warning under 5 GB, error under 1 GB", () => {
    assert.equal(check(assess(with_({ storage: { freeBytes: 6 * GB } })), "disk").level, "ok");
    assert.equal(check(assess(with_({ storage: { freeBytes: 4 * GB } })), "disk").level, "warn");
    const low = assess(with_({ storage: { freeBytes: 0.5 * GB } }));
    assert.equal(check(low, "disk").level, "error");
    assert.equal(low.level, "error");
  });

  it("clip storage close to its limit is information: the oldest are removed by themselves", () => {
    const h = assess(with_({ storage: { usedBytes: 19 * GB } }));
    assert.equal(check(h, "storage").level, "info");
    assert.match(check(h, "storage").detail, /oldest/i);
    assert.equal(h.level, "ok");
  });

  it("reports restarts of ffmpeg as information", () => {
    const h = assess(with_({ recorder: { restarts: 3, stalls: 2 } }));
    assert.match(check(h, "picture").detail, /restarted 3 times/);
    assert.equal(h.level, "ok");
  });

  it("the worst problem wins", () => {
    const h = assess(with_({ go2rtc: { reachable: false }, recorder: { damagedLastMinute: 5 }, storage: { freeBytes: 4 * GB } }));
    assert.equal(h.level, "error");
    assert.equal(h.checks.filter((c) => c.level === "warn").length, 2);
  });

  it("object detection: ready is fine, off or missing is only information with the fix", () => {
    assert.equal(check(assess(base), "detection").level, "ok");
    assert.match(check(assess(base), "detection").title, /yolox_tiny/);
    const off = assess(with_({ detection: { state: "off" } }));
    assert.equal(check(off, "detection").level, "info");
    assert.match(check(off, "detection").detail, /DETECT_ENABLED/);
    const missing = assess(with_({ detection: { state: "unavailable" } }));
    assert.equal(check(missing, "detection").level, "info");
    assert.match(check(missing, "detection").detail, /fetch-model/);
    assert.equal(missing.level, "ok", "the app works without it");
  });

  it("push: says how many phones, or that none is registered", () => {
    assert.match(check(assess(base), "push").title, /1 phone/);
    assert.match(check(assess(with_({ push: { devices: 0 } })), "push").title, /no phone/i);
    assert.match(check(assess(with_({ push: { devices: 2 } })), "push").title, /2 phones/);
  });
});
