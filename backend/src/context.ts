import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FailureLimiter } from "./authLimiter.js";
import type { Config } from "./config.js";
import { DeviceStore } from "./devices.js";
import { ObjectDetector } from "./detect.js";
import { Go2rtc } from "./go2rtc.js";
import { CozyLight } from "./light.js";
import { PtzPresetStore } from "./ptzPresets.js";
import { PushService } from "./push.js";
import { PiperTts } from "./tts.js";
import { SerialQueue } from "./queue.js";
import { MotionRecorder } from "./recorder.js";
import { UrlSigner } from "./signing.js";
import { XiaomiSetup } from "./xiaomi.js";
import { ZoneStore } from "./zones.js";

/** The parts of the system the HTTP layer works with. Routes take what they need from here and build nothing themselves. */
export interface AppContext {
  cfg: Config;
  go: Go2rtc;
  recorder: MotionRecorder;
  zones: ZoneStore;
  /** Null when detection is off or the model could not be loaded. */
  detector: ObjectDetector | null;
  push: PushService;
  signer: UrlSigner;
  limiter: FailureLimiter;
  /** Pan/tilt commands go through this one at a time (the camera has a single session). */
  ptzQueue: SerialQueue;
  xiaomi: XiaomiSetup;
  /** Named camera positions (data/ptz-presets.json). */
  ptzPresets: PtzPresetStore;
  /** Devices found on the network or typed in (data/devices.json). */
  devices: DeviceStore;
  light?: CozyLight;
  /** The neural voice, when Piper is set up. */
  tts?: PiperTts;
  snapshotsDir: string;
  /** Stops background work (recorder, stream keeper, held push summary). */
  close(): Promise<void>;
}

/** Builds and starts every service, in the order they depend on each other. */
export async function createContext(cfg: Config, log: { info: (m: string) => void; debug: (m: string) => void }): Promise<AppContext> {
  const snapshotsDir = join(cfg.dataDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });

  const go = new Go2rtc(cfg, (m) => log.debug(m));
  const recorder = new MotionRecorder(cfg, (m) => log.info(m));

  const zones = new ZoneStore(cfg.dataDir);
  await zones.init();
  recorder.setZones(zones.get());

  const detector = cfg.detect.enabled ? await ObjectDetector.load(cfg.detect.modelPath, cfg.detect.minScore, (m) => log.info(m)) : null;
  if (detector) recorder.setDetector(detector);

  const ptzPresets = new PtzPresetStore(cfg.dataDir);
  await ptzPresets.init();

  const devices = new DeviceStore(cfg.dataDir);
  await devices.init();

  const push = new PushService(cfg, { log: (m) => log.info(m) });
  await push.init();
  push.attach(recorder);
  await recorder.start();

  const tts = cfg.piper ? new PiperTts(cfg.piper, (m) => log.info(m)) : undefined;

  return {
    cfg,
    go,
    recorder,
    zones,
    detector,
    push,
    signer: new UrlSigner(cfg.apiToken, cfg.signedUrlTtlSec),
    limiter: new FailureLimiter(cfg.authMaxFailures, cfg.authWindowSec * 1000),
    ptzQueue: new SerialQueue(4),
    xiaomi: new XiaomiSetup(cfg),
    devices,
    ptzPresets,
    tts,
    light: cfg.lightIp ? new CozyLight(cfg.lightIp, cfg.lightPort) : undefined,
    snapshotsDir,
    async close() {
      go.close();
      push.close();
      tts?.close();
      await recorder.stop();
    },
  };
}
