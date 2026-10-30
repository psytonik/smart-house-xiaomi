import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Object detection for motion clips with YOLOX-Tiny (Apache-2.0) through onnxruntime.
 * A few frames of each finished clip are checked; the result is "person", "vehicle" and "animal" labels.
 * It only labels clips: nothing is ever dropped because of it.
 */

export const INPUT_SIZE = 416;
const STRIDES = [8, 16, 32];
const CLASSES = 80;
const WIDTH = 5 + CLASSES; // x, y, w, h, objectness, 80 class scores
const NMS_IOU = 0.45;

export type ObjectLabel = "person" | "vehicle" | "animal";

export interface ObjectSummary {
  label: ObjectLabel;
  /** Best confidence for this label over the checked frames, 0..1. */
  score: number;
}

export interface Candidate {
  /** x1, y1, x2, y2 in pixels of the (letterboxed) input. */
  box: [number, number, number, number];
  score: number;
  /** COCO class id. */
  classId: number;
}

/** COCO classes grouped the way a home needs them. Everything else (chairs, bottles, ...) is ignored. */
export function groupOf(classId: number): ObjectLabel | null {
  if (classId === 0) return "person";
  if ([1, 2, 3, 5, 7].includes(classId)) return "vehicle"; // bicycle, car, motorcycle, bus, truck
  if (classId >= 14 && classId <= 19) return "animal"; // bird, cat, dog, horse, sheep, cow
  return null;
}

/**
 * The raw YOLOX output (1 x 3549 x 85) to boxes. YOLOX gives, per grid cell, offsets in cells and log sizes;
 * objectness and class scores are already probabilities. Score = objectness x best class score.
 */
export function decodeYolox(output: Float32Array, minScore: number, size = INPUT_SIZE): Candidate[] {
  const cells = STRIDES.map((s) => (size / s) ** 2);
  const total = cells.reduce((a, b) => a + b, 0);
  if (output.length !== total * WIDTH) throw new Error(`unexpected model output size ${output.length}, expected ${total * WIDTH}`);

  const found: Candidate[] = [];
  let anchor = 0;
  STRIDES.forEach((stride, k) => {
    const grid = size / stride;
    for (let i = 0; i < cells[k]!; i++, anchor++) {
      const o = anchor * WIDTH;
      const obj = output[o + 4]!;
      if (obj < minScore) continue; // score can never exceed objectness
      let best = 0;
      let classId = 0;
      for (let c = 0; c < CLASSES; c++) {
        const v = output[o + 5 + c]!;
        if (v > best) {
          best = v;
          classId = c;
        }
      }
      const score = obj * best;
      if (score < minScore) continue;
      const cx = (output[o]! + (i % grid)) * stride;
      const cy = (output[o + 1]! + Math.floor(i / grid)) * stride;
      const w = Math.exp(output[o + 2]!) * stride;
      const h = Math.exp(output[o + 3]!) * stride;
      found.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], score, classId });
    }
  });
  return found;
}

function iou(a: Candidate["box"], b: Candidate["box"]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/** Non-maximum suppression: of boxes that cover the same thing, only the best-scored one stays. */
export function nms(candidates: Candidate[], threshold = NMS_IOU): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => iou(k.box, c.box) <= threshold)) kept.push(c);
  }
  return kept;
}

/** The best score per label, in a fixed order (person, vehicle, animal). */
export function summarize(candidates: Candidate[]): ObjectSummary[] {
  const best = new Map<ObjectLabel, number>();
  for (const c of candidates) {
    const label = groupOf(c.classId);
    if (label && c.score > (best.get(label) ?? 0)) best.set(label, c.score);
  }
  return (["person", "vehicle", "animal"] as const).filter((l) => best.has(l)).map((label) => ({ label, score: best.get(label)! }));
}

/** A BGR picture (what ffmpeg's bgr24 gives) to the model's channels-first float input. YOLOX takes raw 0..255 values. */
export function toTensor(bgr: Uint8Array, width = INPUT_SIZE, height = INPUT_SIZE): Float32Array {
  const pixels = width * height;
  if (bgr.length !== pixels * 3) throw new Error(`frame has ${bgr.length} bytes, expected ${pixels * 3}`);
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i] = bgr[i * 3]!;
    out[pixels + i] = bgr[i * 3 + 1]!;
    out[2 * pixels + i] = bgr[i * 3 + 2]!;
  }
  return out;
}

export interface ClipScan {
  durationSec: number;
  maxFrames: number;
  /** A frame of the clip at the given second, ready for `detect`; null if it cannot be taken. */
  extract: (atSec: number) => Promise<Uint8Array | null>;
  detect: (frame: Uint8Array) => Promise<Candidate[]>;
}

/** Checks a few frames spread over a clip. Throws only when no frame could be taken at all. */
export async function summarizeClip(scan: ClipScan): Promise<ObjectSummary[]> {
  const n = Math.max(1, Math.min(scan.maxFrames, Math.ceil(scan.durationSec / 3)));
  const all: Candidate[] = [];
  let looked = 0;
  for (let i = 0; i < n; i++) {
    const frame = await scan.extract((scan.durationSec * (i + 1)) / (n + 1));
    if (!frame) continue;
    looked++;
    all.push(...(await scan.detect(frame)));
  }
  if (looked === 0) throw new Error("no frame could be taken from the clip");
  return summarize(all);
}

// ---------------------------------------------------------------- the real thing

/** One frame of a video file as 416x416 BGR, shrunk to fit and padded at the right and bottom with gray (as YOLOX was trained). */
export function extractFrame(ffmpegPath: string, file: string, atSec: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const p = spawn(
      ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1",
        "-vf", `scale=${INPUT_SIZE}:${INPUT_SIZE}:force_original_aspect_ratio=decrease,pad=${INPUT_SIZE}:${INPUT_SIZE}:0:0:color=0x727272`,
        "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on("close", () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      resolve(data.length === INPUT_SIZE * INPUT_SIZE * 3 ? new Uint8Array(data) : null);
    });
  });
}

interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

interface Ort {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}

export class ObjectDetector {
  private constructor(
    private readonly session: Session,
    private readonly ort: Ort,
    private readonly minScore: number,
    readonly model: string,
  ) {}

  /** Null when the model file or the runtime is missing: the app then just works without detection. */
  static async load(modelPath: string, minScore: number, log: (msg: string) => void = () => {}): Promise<ObjectDetector | null> {
    if (!existsSync(modelPath)) {
      log(`detect: model not found at ${modelPath}; run ./camera.sh fetch-model to turn detection on`);
      return null;
    }
    try {
      const ort = await import("onnxruntime-node");
      const session = (await ort.InferenceSession.create(modelPath)) as unknown as Session;
      log(`detect: loaded ${modelPath}`);
      return new ObjectDetector(session, ort as unknown as Ort, minScore, modelPath.split("/").pop() ?? modelPath);
    } catch (e) {
      log(`detect: could not start the model (${e instanceof Error ? e.message : e})`);
      return null;
    }
  }

  async detect(frame: Uint8Array): Promise<Candidate[]> {
    const input = new this.ort.Tensor("float32", toTensor(frame), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const out = await this.session.run({ [this.session.inputNames[0]!]: input });
    const data = out[this.session.outputNames[0]!]!.data as Float32Array;
    return nms(decodeYolox(data, this.minScore));
  }

  /** Looks at a few frames of a finished clip. Throws if the clip cannot be read. */
  analyzeClip(ffmpegPath: string, clipFile: string, durationSec: number, maxFrames: number): Promise<ObjectSummary[]> {
    return summarizeClip({
      durationSec,
      maxFrames,
      extract: (t) => extractFrame(ffmpegPath, clipFile, t),
      detect: (f) => this.detect(f),
    });
  }
}
