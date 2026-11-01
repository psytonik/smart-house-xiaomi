import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JournalEntry } from "../src/assistantMemory.js";
import { analyze } from "../src/journalReport.js";

let clock = Date.parse("2026-11-01T10:00:00Z");
const said = (text: string, over: Partial<JournalEntry> = {}): JournalEntry => ({ at: new Date((clock += 10_000)).toISOString(), text, via: "model", ok: false, reply: "Не получилось.", actions: [], ...over });

describe("journal report", () => {
  it("counts a phrase the rules understand now as fixed, not as a gap", () => {
    const r = analyze([said("Выключи свет."), said("выключи свет")]);
    assert.deepEqual(r.fixedByRules, [{ phrase: "выключи свет", times: 2 }]);
    assert.deepEqual(r.gaps, []);
  });

  it("proposes the phrase the person said right after a failure, once the rules understand it", () => {
    const r = analyze([said("хочу темноту"), said("выключи свет", { via: "rules", ok: true, reply: "Свет выключен." })]);
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0]!.phrase, "хочу темноту");
    assert.equal(r.proposals[0]!.steps[0]!.tool, "lights_set");
  });

  it("does not link a failure to a success that is not the next phrase", () => {
    const r = analyze([said("хочу темноту"), said("абракадабра"), said("выключи свет", { via: "rules", ok: true })]);
    assert.deepEqual(r.proposals.map((p) => p.phrase), ["абракадабра"]);
    assert.deepEqual(r.gaps.map((g) => g.phrase), ["хочу темноту"]);
  });

  it("spots the assistant hearing itself, but not a short command that sits inside a reply", () => {
    const r = analyze([
      said("Привет я голос вашего дома"),
      said("Сколько воды: мало, средне или много?"),
      said("мало", { reply: "Сколько воды: мало, средне или много?" }),
    ]);
    assert.ok(r.echoes.some((e) => e.phrase === "привет я голос вашего дома"));
    assert.ok(!r.echoes.some((e) => e.phrase === "мало"));
  });

  it("leaves phrases that are already taught alone", () => {
    const r = analyze([said("включи ночник")], new Set(["включи ночник"]));
    assert.deepEqual(r.gaps, []);
  });
});
