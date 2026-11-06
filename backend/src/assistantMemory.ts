import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "./quick.js";

export interface JournalEntry {
  at: string;
  text: string;
  /** Who understood the phrase. */
  via: "rules" | "learned" | "model";
  /** Whether it did something and every action worked. */
  ok: boolean;
  reply: string;
  actions: Array<{ tool: string; ok: boolean }>;
}

const MAX_PENDING = 50;
const MAX_LEARNED = 500;
const AUTO_LEARN_RUNS = 2;
const UNDO_WITHIN_MS = 120_000;
const ASKED_WITHIN_MS = 60_000;

/** What the assistant has learned from the household, and a journal of what it was asked. Plain files in the data folder. */
export class AssistantMemory {
  private learned = new Map<string, Step[]>();
  /** The last successful model run of each phrase: what "Remember" would save. Never taken from the client. */
  private pending = new Map<string, { steps: Step[]; runs: number }>();
  /** The phrase learned on its own most recently, which "no, not that" takes back. */
  private asked: { phrase: string; at: number } | undefined;
  private lastAuto: { phrase: string; at: number } | undefined;
  private readonly learnedFile: string;
  private readonly journalFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.learnedFile = join(dir, "learned.json");
    this.journalFile = join(dir, "journal.jsonl");
    try {
      if (existsSync(this.learnedFile)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.learnedFile, "utf8")) as Record<string, Step[]>)) this.learned.set(k, v);
    } catch {
      /* a damaged file starts empty rather than stopping the assistant */
    }
  }

  find(phrase: string): Step[] | undefined {
    return this.learned.get(phrase);
  }

  /**
   * A model run that worked: it can be learned if the person says so. The second run of the same phrase that
   * does the same thing is learned on its own (returns true): one lucky guess of a small model is not enough.
   */
  offer(phrase: string, steps: Step[]): boolean {
    const same = (a: Step[], b: Step[]) => JSON.stringify(a.map((s) => [s.tool, s.input])) === JSON.stringify(b.map((s) => [s.tool, s.input]));
    const prev = this.pending.get(phrase);
    const runs = prev && same(prev.steps, steps) ? prev.runs + 1 : 1;
    this.pending.delete(phrase);
    this.pending.set(phrase, { steps, runs });
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    if (runs < AUTO_LEARN_RUNS || !this.learn(phrase)) return false;
    this.lastAuto = { phrase, at: Date.now() };
    return true;
  }

  /** The assistant did not understand this phrase and asked what was meant: the next phrase that works is taught for it. */
  ask(phrase: string): void {
    this.asked = { phrase, at: Date.now() };
  }

  /** The phrase waiting for an explanation, once (so a later, unrelated command is never taught for it). */
  takeAsked(): string | undefined {
    const a = this.asked;
    this.asked = undefined;
    return a && Date.now() - a.at <= ASKED_WITHIN_MS ? a.phrase : undefined;
  }

  /** "No, not that": the last guess is dropped, and a phrase learned a moment ago is forgotten. */
  correction(): void {
    const last = [...this.pending.keys()].pop();
    if (last) this.pending.delete(last);
    if (this.lastAuto && Date.now() - this.lastAuto.at <= UNDO_WITHIN_MS) this.forget(this.lastAuto.phrase);
    this.lastAuto = undefined;
  }

  learn(phrase: string): boolean {
    const steps = this.pending.get(phrase)?.steps;
    if (!steps || this.learned.size >= MAX_LEARNED) return false;
    this.learned.set(phrase, steps);
    this.pending.delete(phrase);
    this.save();
    return true;
  }

  /** Teaches a phrase directly (from the journal report), not from a model run. */
  teach(phrase: string, steps: Step[]): boolean {
    if (this.learned.has(phrase) || this.learned.size >= MAX_LEARNED) return false;
    this.learned.set(phrase, steps);
    this.save();
    return true;
  }

  forget(phrase: string): boolean {
    const had = this.learned.delete(phrase);
    if (had) this.save();
    return had;
  }

  list(): Array<{ phrase: string; steps: Step[] }> {
    return [...this.learned].map(([phrase, steps]) => ({ phrase, steps }));
  }

  note(entry: Omit<JournalEntry, "at">): void {
    try {
      appendFileSync(this.journalFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      /* the journal is a convenience, never a reason to fail a command */
    }
  }

  /** The newest entries first. */
  recent(n = 100): JournalEntry[] {
    try {
      const lines = readFileSync(this.journalFile, "utf8").split("\n").filter(Boolean);
      return lines.slice(-n).reverse().map((l) => JSON.parse(l) as JournalEntry);
    } catch {
      return [];
    }
  }

  private save(): void {
    const tmp = `${this.learnedFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.learned), null, 2));
    renameSync(tmp, this.learnedFile);
  }
}
