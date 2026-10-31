import { join } from "node:path";
import { defaultMotion, type Config } from "../src/config.js";

/**
 * A complete Config for tests: nothing listens, nothing records, timings are short.
 * Pass only what a test cares about, so adding a setting to Config means touching one place, not six.
 */
export function testConfig(over: Partial<Config> & { dataDir: string }): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    apiToken: "t".repeat(24),
    go2rtcUrl: "http://127.0.0.1:1",
    stream: "cam",
    publicDir: join(over.dataDir, "public"),
    input: "unused",
    ffmpegPath: "ffmpeg",
    retentionDays: 7,
    signedUrlTtlSec: 3600,
    detect: { enabled: false, modelPath: "", minScore: 0.4, maxFrames: 5, discardEmpty: true },
    assistant: { enabled: false, provider: "anthropic", model: "claude-opus-5-5", ollamaUrl: "http://127.0.0.1:1" },
    maxStorageBytes: 1024 ** 3,
    pushMinIntervalSec: 120,
    pushUrl: "http://127.0.0.1:1/push",
    expoAccessToken: "",
    authMaxFailures: 10,
    authWindowSec: 60,
    keepAliveMs: 300,
    warmupPollMs: 20,
    warmupAttempts: 5,
    motion: defaultMotion({ enabled: false }),
    ...over,
  };
}
