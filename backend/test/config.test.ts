import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const base = { API_TOKEN: "x".repeat(24) };

describe("loadConfig", () => {
  it("uses defaults, including port 3100", () => {
    const cfg = loadConfig(base);
    assert.equal(cfg.port, 3100);
    assert.equal(cfg.retentionDays, 7);
    assert.equal(cfg.motion.threshold, 0.012);
  });

  it("converts MOTION_THRESHOLD from percent", () => {
    assert.equal(loadConfig({ ...base, MOTION_THRESHOLD: "2" }).motion.threshold, 0.02);
  });

  it("rejects a short token", () => {
    assert.throws(() => loadConfig({ API_TOKEN: "short" }), /API_TOKEN/);
  });

  it("fails loudly on a mistyped number instead of disabling motion detection", () => {
    assert.throws(() => loadConfig({ ...base, MOTION_THRESHOLD: "1,2" }), /MOTION_THRESHOLD/);
    assert.throws(() => loadConfig({ ...base, PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ ...base, RETENTION_DAYS: "0" }), /RETENTION_DAYS/);
  });

  it("listens on localhost unless HOST says otherwise", () => {
    assert.equal(loadConfig(base).host, "127.0.0.1");
    assert.equal(loadConfig({ ...base, HOST: "0.0.0.0" }).host, "0.0.0.0");
  });

  it("reads the storage limit in GB and the lighting-change limit in percent", () => {
    const cfg = loadConfig(base);
    assert.equal(cfg.maxStorageBytes, 20 * 1024 ** 3);
    assert.equal(cfg.motion.lightChange, 0.6);
    const custom = loadConfig({ ...base, MAX_STORAGE_GB: "1.5", MOTION_LIGHT_CHANGE: "40" });
    assert.equal(custom.maxStorageBytes, 1.5 * 1024 ** 3);
    assert.equal(custom.motion.lightChange, 0.4);
  });

  it("rejects a lighting-change limit that would swallow real motion", () => {
    assert.throws(() => loadConfig({ ...base, MOTION_THRESHOLD: "5", MOTION_LIGHT_CHANGE: "4" }), /MOTION_LIGHT_CHANGE/);
    assert.throws(() => loadConfig({ ...base, MAX_STORAGE_GB: "0" }), /MAX_STORAGE_GB/);
  });

  it("has push defaults: no more than one notification per two minutes, Expo's public endpoint", () => {
    const cfg = loadConfig(base);
    assert.equal(cfg.pushMinIntervalSec, 120);
    assert.equal(cfg.pushUrl, "https://exp.host/--/api/v2/push/send");
    assert.equal(cfg.expoAccessToken, "");
    const custom = loadConfig({ ...base, PUSH_MIN_INTERVAL_SEC: "0", EXPO_ACCESS_TOKEN: "t" });
    assert.equal(custom.pushMinIntervalSec, 0);
    assert.equal(custom.expoAccessToken, "t");
    assert.throws(() => loadConfig({ ...base, PUSH_MIN_INTERVAL_SEC: "-1" }), /PUSH_MIN_INTERVAL_SEC/);
  });

  it("watches for a frozen stream: 15 s by default, at least 2", () => {
    assert.equal(loadConfig(base).motion.stallSec, 15);
    assert.equal(loadConfig({ ...base, MOTION_STALL_SEC: "30" }).motion.stallSec, 30);
    assert.throws(() => loadConfig({ ...base, MOTION_STALL_SEC: "1" }), /MOTION_STALL_SEC/);
  });

  it("object detection: on by default, the model next to the backend, labels from 40% confidence", () => {
    const cfg = loadConfig(base);
    assert.equal(cfg.detect.enabled, true);
    assert.match(cfg.detect.modelPath, /models\/yolox_tiny\.onnx$/);
    assert.equal(cfg.detect.minScore, 0.4);
    assert.equal(cfg.detect.maxFrames, 5);
    const custom = loadConfig({ ...base, DETECT_ENABLED: "false", DETECT_MODEL: "/opt/m.onnx", DETECT_MIN_SCORE: "60" });
    assert.equal(custom.detect.enabled, false);
    assert.equal(custom.detect.modelPath, "/opt/m.onnx");
    assert.equal(custom.detect.minScore, 0.6);
    assert.throws(() => loadConfig({ ...base, DETECT_MIN_SCORE: "2" }), /DETECT_MIN_SCORE/);
  });
});
