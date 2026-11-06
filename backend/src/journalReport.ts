import { join } from "node:path";
import { plain } from "./assistant.js";
import { AssistantMemory, type JournalEntry } from "./assistantMemory.js";
import { loadConfig } from "./config.js";
import { planQuick, type Step } from "./quick.js";

/** A failed phrase and the phrase the person said next, which the rules understand: the person's own correction. */
export interface Proposal {
  phrase: string;
  /** What it was fixed with. */
  becameText: string;
  steps: Step[];
  times: number;
}

export interface Report {
  total: number;
  byVia: Record<JournalEntry["via"], number>;
  /** Of all phrases, the share that did something and worked. */
  okShare: number;
  /** Went to the model or failed, but the rules understand them now. */
  fixedByRules: Array<{ phrase: string; times: number }>;
  /** The assistant heard its own voice. */
  echoes: Array<{ phrase: string; times: number }>;
  proposals: Proposal[];
  /** Still not understood and not explained by a retry: the next rules to write. */
  gaps: Array<{ phrase: string; times: number }>;
}

/** What the page says on its own, which the microphone can pick up. */
const SPOKEN_BY_PAGE = ["привет, я голос вашего дома"];
/** A retry counts only if it is the very next phrase and comes soon after the failure. */
const RETRY_WITHIN_MS = 90_000;

const count = (phrases: string[]) => {
  const m = new Map<string, number>();
  for (const p of phrases) m.set(p, (m.get(p) ?? 0) + 1);
  return [...m].map(([phrase, times]) => ({ phrase, times })).sort((a, b) => b.times - a.times || a.phrase.localeCompare(b.phrase));
};

const worked = (e: JournalEntry) => e.ok;

/** Entries oldest first. `learned` are phrases already taught, which need no proposal. */
export function analyze(entries: JournalEntry[], learned: ReadonlySet<string> = new Set()): Report {
  const byVia = { rules: 0, learned: 0, model: 0 };
  for (const e of entries) byVia[e.via]++;

  // Words only, so a comma in what was said aloud does not hide it. Three words or more: "turbo" is a command, not an echo.
  const words = (t: string) => plain(t).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const spoken = [...SPOKEN_BY_PAGE, ...entries.map((e) => e.reply)].map(words);
  const isEcho = (phrase: string) => words(phrase).split(" ").length >= 3 && spoken.some((s) => s.includes(words(phrase)) || words(phrase).includes(s));

  const fixed: string[] = [];
  const echoes: string[] = [];
  const gaps: string[] = [];
  const proposed = new Map<string, Proposal>();

  entries.forEach((e, i) => {
    if (worked(e) && e.via !== "model") return; // already handled for free
    const phrase = plain(e.text);
    if (isEcho(phrase)) return void echoes.push(phrase);
    if (learned.has(phrase)) return;
    if (!worked(e) || e.via === "model") {
      if (planQuick(phrase)) return void fixed.push(phrase);
    }
    if (worked(e)) return; // the model managed; "Remember this phrase" is how it gets learned
    const next = entries[i + 1];
    const retry = next && Date.parse(next.at) - Date.parse(e.at) <= RETRY_WITHIN_MS && worked(next) && plain(next.text) !== phrase ? next : undefined;
    const steps = retry && planQuick(plain(retry.text));
    if (retry && steps) {
      const hit = proposed.get(phrase);
      if (hit && hit.becameText === plain(retry.text)) hit.times++;
      else proposed.set(phrase, { phrase, becameText: plain(retry.text), steps, times: 1 });
      return;
    }
    gaps.push(phrase);
  });

  return {
    total: entries.length,
    byVia,
    okShare: entries.length ? entries.filter(worked).length / entries.length : 0,
    fixedByRules: count(fixed),
    echoes: count(echoes),
    proposals: [...proposed.values()].sort((a, b) => b.times - a.times),
    gaps: count(gaps),
  };
}

/** Phrases that failed and were fixed the same way at least twice are taught without asking. True if something was learned. */
export function autoTeach(memory: AssistantMemory): boolean {
  const sure = analyze(memory.recent(500).reverse(), new Set(memory.list().map((l) => l.phrase))).proposals.filter((p) => p.times >= 2);
  return sure.filter((p) => memory.teach(p.phrase, p.steps)).length > 0;
}

export function render(r: Report): string {
  const pct = (n: number) => `${Math.round((n / (r.total || 1)) * 100)}%`;
  const list = (rows: Array<{ phrase: string; times: number }>, max = 15) => (rows.length ? rows.slice(0, max).map((x) => `  ${x.times}× «${x.phrase}»`).join("\n") : "  нет");
  return [
    `Фраз: ${r.total}. Правила ${r.byVia.rules} (${pct(r.byVia.rules)}), выученные ${r.byVia.learned}, модель ${r.byVia.model} (${pct(r.byVia.model)}). Удалось: ${Math.round(r.okShare * 100)}%.`,
    "",
    `Уже исправлено правилами (раньше уходили в модель или не удавались): ${r.fixedByRules.length}`,
    list(r.fixedByRules, 8),
    "",
    `Эхо: помощник услышал сам себя (стоит ли глушить микрофон во время ответа): ${r.echoes.length}`,
    list(r.echoes, 8),
    "",
    `Предложения: не сработало, а следующей фразой вы сказали то, что правила понимают (${r.proposals.length}):`,
    r.proposals.length ? r.proposals.map((p) => `  ${p.times}× «${p.phrase}» → «${p.becameText}» (${p.steps.map((s) => s.tool).join("+")})`).join("\n") : "  нет",
    "",
    `Пробелы: не понято и не объяснено повтором, это следующие правила (${r.gaps.length}):`,
    list(r.gaps),
  ].join("\n");
}

if (process.argv[1]?.endsWith("journalReport.ts") || process.argv[1]?.endsWith("journalReport.js")) {
  const dir = join(loadConfig().dataDir, "assistant");
  const memory = new AssistantMemory(dir);
  const report = analyze(memory.recent(100_000).reverse(), new Set(memory.list().map((l) => l.phrase)));
  console.log(render(report));
  if (process.argv.includes("--apply")) {
    const taught = report.proposals.filter((p) => p.times >= 2).filter((p) => memory.teach(p.phrase, p.steps));
    console.log(`\nВыучено ${taught.length} фраз (нужно ≥ 2 повторов). Перезапустите бэкенд: launchctl kickstart -k gui/$(id -u)/com.psytonik.xiaomi-camera`);
  }
}
