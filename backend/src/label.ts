import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { ObjectDetector } from "./detect.js";
import type { EventStore } from "./events.js";
import type { ClipAnalyzer } from "./recorder.js";

export interface LabelResult {
  labelled: number;
  failed: number;
  /** The record exists but its video is gone. */
  missingFile: number;
  /** Already analysed earlier (labels present, even an empty list). */
  alreadyDone: number;
}

/**
 * Gives labels to clips recorded before detection existed. Only clips that were never analysed are touched, and only
 * their `objects` field changes. A clip that cannot be analysed is left as it is.
 */
export async function labelMissing(store: EventStore, analyzer: ClipAnalyzer, ffmpegPath: string, maxFrames: number, log: (msg: string) => void = () => {}): Promise<LabelResult> {
  const result: LabelResult = { labelled: 0, failed: 0, missingFile: 0, alreadyDone: 0 };
  for (const clip of await store.list(100_000)) {
    if (clip.objects !== undefined) {
      result.alreadyDone++;
      continue;
    }
    const file = store.file(clip.clip);
    if (!existsSync(file)) {
      result.missingFile++;
      continue;
    }
    try {
      const objects = (await analyzer.analyzeClip(ffmpegPath, file, clip.durationSec, maxFrames)).map((o) => ({ label: o.label, score: Math.round(o.score * 100) / 100 }));
      await store.add({ ...clip, objects });
      result.labelled++;
      log(`${clip.id}: ${objects.length ? objects.map((o) => o.label).join("+") : "nothing recognised"}`);
    } catch (e) {
      result.failed++;
      log(`${clip.id}: could not be analysed (${e instanceof Error ? e.message : e})`);
    }
  }
  return result;
}

// `npm run label` (or ./camera.sh label-clips): run once, then exit.
if (process.argv[1]?.endsWith("label.ts") || process.argv[1]?.endsWith("label.js")) {
  const { EventStore: Store } = await import("./events.js");
  const cfg = loadConfig();
  const detector = await ObjectDetector.load(cfg.detect.modelPath, cfg.detect.minScore, (m) => console.log(m));
  if (!detector) {
    console.error("No detector: get the model with ./camera.sh fetch-model");
    process.exit(1);
  }
  const store = new Store(`${cfg.dataDir}/events`);
  await store.init();
  const r = await labelMissing(store, detector, cfg.ffmpegPath, cfg.detect.maxFrames, (m) => console.log(m));
  console.log(`Done: ${r.labelled} labelled, ${r.alreadyDone} already had labels, ${r.failed} failed, ${r.missingFile} without a video file.`);
}
