import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { buildApp } from "../src/app.js";
import { runAssistant, type ApiCall, type Brain } from "../src/assistant.js";
import { testConfig } from "./helpers.js";

const message = (stop_reason: string, content: unknown[]) => ({ stop_reason, content }) as unknown as Anthropic.Message;

/** A brain that answers from a script, and remembers what it was asked. */
function scripted(...replies: Anthropic.Message[]) {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const brain: Brain = { messages: { create: async (p) => (seen.push(structuredClone(p)), replies.shift()!) } };
  return { brain, seen };
}

describe("assistant", () => {
  it("runs the tool the model picks and returns its closing words", async () => {
    const calls: Array<[string, string, object | undefined]> = [];
    const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: { ok: true } });
    const { brain, seen } = scripted(
      message("tool_use", [{ type: "tool_use", id: "t1", name: "vacuum_action", input: { action: "start" } }]),
      message("end_turn", [{ type: "text", text: "Пылесос поехал." }]),
    );
    const out = await runAssistant({ brain, model: "m", call, text: "пусть робот прокатится по дому" });
    assert.equal(out.reply, "Пылесос поехал.");
    assert.deepEqual(calls, [["POST", "/api/vacuum", { action: "start" }]]);
    assert.deepEqual(out.actions, [{ tool: "vacuum_action", input: { action: "start" }, ok: true }]);
    const back = seen[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    assert.equal(back[0]!.tool_use_id, "t1");
  });

  it("hands an API error back to the model as an error result", async () => {
    const call: ApiCall = async () => ({ status: 502, body: { error: "TV is off" } });
    const { brain, seen } = scripted(
      message("tool_use", [{ type: "tool_use", id: "t1", name: "tv_key", input: { key: "mute" } }]),
      message("end_turn", [{ type: "text", text: "Телевизор не отвечает." }]),
    );
    const out = await runAssistant({ brain, model: "m", call, text: "сделай чтобы стало тихо" });
    assert.equal(out.actions[0]!.ok, false);
    assert.equal(((seen[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!).is_error, true);
  });

  it("presses a key several times, and stops at the first failure", async () => {
    let n = 0;
    const call: ApiCall = async () => ({ status: ++n < 3 ? 200 : 502, body: {} });
    const { brain } = scripted(
      message("tool_use", [{ type: "tool_use", id: "t1", name: "tv_key", input: { key: "volumeUp", times: 5 } }]),
      message("end_turn", [{ type: "text", text: "ок" }]),
    );
    await runAssistant({ brain, model: "m", call, text: "громче" });
    assert.equal(n, 3);
  });

  it("gives up after too many rounds", async () => {
    const call: ApiCall = async () => ({ status: 200, body: {} });
    const loop = () => message("tool_use", [{ type: "tool_use", id: "t", name: "lights_list", input: {} }]);
    const { brain } = scripted(loop(), loop(), loop(), loop(), loop(), loop(), loop());
    const out = await runAssistant({ brain, model: "m", call, text: "?" });
    assert.match(out.reply, /Не успел/);
  });
});

describe("assistant API", () => {
  const auth = { authorization: `Bearer ${"t".repeat(24)}` };
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "assist-"));
    app = await buildApp(testConfig({ dataDir: dir }));
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("teaches a failed phrase by itself once the person fixed it the same way twice", () => {
    const d = mkdtempSync(join(tmpdir(), "mem-"));
    const line = (at: string, text: string, via: string, ok: boolean) => JSON.stringify({ at, text, via, ok, reply: "x", actions: [] });
    const fix = (day: string) => [line(`2026-11-0${day}T10:00:00Z`, "хочу темноту", "model", false), line(`2026-11-0${day}T10:00:20Z`, "выключи свет", "rules", true)];
    const memory = new AssistantMemory(d);
    writeFileSync(join(d, "journal.jsonl"), fix("1").join("\n") + "\n");
    assert.equal(autoTeach(memory), false, "once is only a suggestion");
    writeFileSync(join(d, "journal.jsonl"), [...fix("1"), ...fix("2")].join("\n") + "\n");
    assert.equal(autoTeach(memory), true);
    assert.equal(memory.list()[0]!.phrase, "хочу темноту");
    rmSync(d, { recursive: true, force: true });
  });

  it("offers what the person meant after a failure, and teaches it only when approved", async () => {
    const line = (at: string, text: string, via: string, ok: boolean) => JSON.stringify({ at, text, via, ok, reply: "x", actions: [] });
    writeFileSync(join(dir, "assistant", "journal.jsonl"), [line("2026-11-01T10:00:00Z", "хочу темноту", "model", false), line("2026-11-01T10:00:20Z", "выключи свет", "rules", true)].join("\n") + "\n");
    const offered = (await app.inject({ url: "/api/assistant/suggestions", headers: auth })).json().suggestions;
    assert.deepEqual(offered, [{ phrase: "хочу темноту", becameText: "выключи свет", times: 1 }]);
    const bad = await app.inject({ method: "POST", url: "/api/assistant/teach", headers: auth, payload: { text: "выдумка" } });
    assert.equal(bad.statusCode, 409);
    const ok = await app.inject({ method: "POST", url: "/api/assistant/teach", headers: auth, payload: { text: "Хочу темноту." } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual((await app.inject({ url: "/api/assistant/suggestions", headers: auth })).json().suggestions, []);
    assert.equal((await app.inject({ url: "/api/assistant/journal", headers: auth })).json().learned[0].phrase, "хочу темноту");
  });

  it("says it is off without a key, and refuses commands", async () => {
    assert.equal((await app.inject({ url: "/api/assistant", headers: auth })).json().configured, false);
    const res = await app.inject({ method: "POST", url: "/api/assistant", headers: auth, payload: { text: "привет" } });
    assert.equal(res.statusCode, 404);
  });

  it("needs the token", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/assistant", payload: { text: "x" } })).statusCode, 401);
  });
});

import { fromOllamaReply, ollamaBrain, toOllamaMessages } from "../src/ollama.js";

describe("ollama adapter", () => {
  it("turns a finished tool round into Ollama messages", () => {
    const out = toOllamaMessages("sys", [
      { role: "user", content: "громче" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "tv_key", input: { key: "volumeUp" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: '{"ok":true}' }] },
    ]);
    assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(out[2]!.tool_calls![0]!.function.name, "tv_key");
    assert.equal(out[3]!.tool_name, "tv_key");
  });

  it("reads tool calls (arguments as an object or as text) and plain answers", () => {
    const calls = fromOllamaReply({ message: { content: "", tool_calls: [{ function: { name: "lights_list", arguments: "{}" } }, { function: { name: "tv_key", arguments: { key: "mute" } } }] } });
    assert.equal(calls.stop_reason, "tool_use");
    assert.deepEqual((calls.content as unknown as Array<{ name: string; input: unknown }>).map((b) => [b.name, b.input]), [["lights_list", {}], ["tv_key", { key: "mute" }]]);
    const plain = fromOllamaReply({ message: { content: "Готово." } });
    assert.equal(plain.stop_reason, "end_turn");
  });

  it("says what to do when Ollama is down or the model is missing", async () => {
    const params = { model: "qwen3:8b", max_tokens: 10, messages: [{ role: "user" as const, content: "x" }] };
    const down = ollamaBrain("http://x", (async () => Promise.reject(new Error("refused"))) as typeof fetch);
    await assert.rejects(down.messages.create(params), /ollama serve/);
    const missing = ollamaBrain("http://x", (async () => new Response("not found", { status: 404 })) as typeof fetch);
    await assert.rejects(missing.messages.create(params), /ollama pull qwen3:8b/);
  });
});

describe("assistant tools resolve names for the model", () => {
  const rooms = { rooms: [{ id: 3, name: "Кухня" }, { id: 5, name: "Спальня" }] };
  const brainFor = (name: string, input: object) => scripted(message("tool_use", [{ type: "tool_use", id: "t", name, input }]), message("end_turn", [{ type: "text", text: "ок" }])).brain;

  it("cleans rooms by name", async () => {
    const calls: Array<[string, string, object | undefined]> = [];
    const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: u.endsWith("/rooms") ? rooms : { ok: true } });
    await runAssistant({ brain: brainFor("vacuum_clean_rooms", { rooms: ["кухня", "спальню"] }), model: "m", call, text: "x" });
    assert.deepEqual(calls.at(-1), ["POST", "/api/vacuum/clean-rooms", { rooms: [3, 5] }]);
  });

  it("names the rooms that exist when one is unknown, and starts nothing", async () => {
    const calls: string[] = [];
    const call: ApiCall = async (m, u) => (calls.push(`${m} ${u}`), { status: 200, body: rooms });
    const out = await runAssistant({ brain: brainFor("vacuum_clean_rooms", { rooms: ["гараж"] }), model: "m", call, text: "x" });
    assert.equal(out.actions[0]!.ok, false);
    assert.deepEqual(calls, ["GET /api/vacuum/rooms"]);
  });

  describe("camera places", () => {
    const places = { presets: [{ id: "pz-1", name: "Дверь", angle: 80, elevation: 40 }, { id: "pz-2", name: "Окно", angle: 20, elevation: 60 }] };
    const record = (): { calls: Array<[string, string, object | undefined]>; call: ApiCall } => {
      const calls: Array<[string, string, object | undefined]> = [];
      const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: u === "/api/ptz/presets" && m === "GET" ? places : { ok: true } });
      return { calls, call };
    };

    it("sends the camera to a saved place, found by the name people use", async () => {
      for (const said of ["дверь", "Дверь", "двери", "к двери"]) {
        const { calls, call } = record();
        await runAssistant({ brain: brainFor("camera_go_place", { name: said }), model: "m", call, text: "x" });
        assert.deepEqual(calls.at(-1), ["POST", "/api/ptz/presets/pz-1/go", undefined], said);
      }
    });

    it("names the places that exist when the name is unknown, and moves nothing", async () => {
      const { calls, call } = record();
      const out = await runAssistant({ brain: brainFor("camera_go_place", { name: "гараж" }), model: "m", call, text: "x" });
      assert.equal(out.actions[0]!.ok, false);
      assert.deepEqual(calls.map((c) => c[0] + " " + c[1]), ["GET /api/ptz/presets"]);
    });

    it("remembers where the camera points under a name", async () => {
      const { calls, call } = record();
      await runAssistant({ brain: brainFor("camera_save_place", { name: "Гараж" }), model: "m", call, text: "x" });
      assert.deepEqual(calls.at(-1), ["POST", "/api/ptz/presets", { name: "Гараж" }]);
    });

    it("looks where the camera points, and lists the places", async () => {
      const a = record();
      await runAssistant({ brain: brainFor("camera_position", {}), model: "m", call: a.call, text: "x" });
      assert.deepEqual(a.calls.at(-1), ["GET", "/api/ptz/position?refresh=1", undefined]);
      const b = record();
      await runAssistant({ brain: brainFor("camera_places", {}), model: "m", call: b.call, text: "x" });
      assert.deepEqual(b.calls.at(-1), ["GET", "/api/ptz/presets", undefined]);
    });

    it("turns by degrees: left raises the angle, right lowers it, and the range is kept", async () => {
      const turn = async (direction: string, degrees: number, angle: number) => {
        const calls: Array<[string, string, object | undefined]> = [];
        const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: u.startsWith("/api/ptz/position") ? { known: true, angle, elevation: 40 } : { ok: true } });
        await runAssistant({ brain: brainFor("camera_turn", { direction, degrees }), model: "m", call, text: "x" });
        return calls.at(-1);
      };
      assert.deepEqual(await turn("right", 90, 80), ["POST", "/api/ptz/goto", { angle: 55, elevation: 40 }]);
      assert.deepEqual(await turn("left", 90, 20), ["POST", "/api/ptz/goto", { angle: 45, elevation: 40 }]);
      assert.deepEqual(await turn("right", 180, 30), ["POST", "/api/ptz/goto", { angle: 1, elevation: 40 }]);
    });

    it("says so when the camera does not say where it points, and moves nothing", async () => {
      const calls: string[] = [];
      const call: ApiCall = async (m, u) => (calls.push(`${m} ${u}`), { status: 200, body: { known: false } });
      const out = await runAssistant({ brain: brainFor("camera_turn", { direction: "left", degrees: 90 }), model: "m", call, text: "x" });
      assert.equal(out.actions[0]!.ok, false);
      assert.equal(calls.length, 1);
    });

    it("goes back to where the camera pointed before its last move, and forward again on the second ask", async () => {
      let at = { angle: 70, elevation: 40 };
      const gotos: object[] = [];
      const call: ApiCall = async (_m, u, b) => {
        if (u.startsWith("/api/ptz/position")) return { status: 200, body: { known: true, ...at } };
        if (u === "/api/ptz/goto") {
          gotos.push(b!);
          at = b as typeof at;
        }
        if (u === "/api/ptz") at = { angle: 40, elevation: 40 };
        return { status: 200, body: { ok: true } };
      };
      await runAssistant({ brain: brainFor("camera_move", { direction: "right" }), model: "m", call, text: "x" });
      await runAssistant({ brain: brainFor("camera_back", {}), model: "m", call, text: "x" });
      assert.deepEqual(gotos, [{ angle: 70, elevation: 40 }]);
      await runAssistant({ brain: brainFor("camera_back", {}), model: "m", call, text: "x" });
      assert.deepEqual(gotos.at(-1), { angle: 40, elevation: 40 });
    });

    it("goes to a saved place named in a plain phrase, and «направь» is not «вправо»", async () => {
      for (const said of ["камера дверь", "направь камеру к двери", "посмотри на дверь"]) {
        const { calls, call } = record();
        const out = await runAssistant({ brain: {} as never, model: "m", call, text: said });
        assert.deepEqual(calls.at(-1), ["POST", "/api/ptz/presets/pz-1/go", undefined], said);
        assert.equal(out.actions[0]!.tool, "camera_go_place");
      }
      const { calls, call } = record();
      await runAssistant({ brain: {} as never, model: "m", call, text: "поверни камеру направо" });
      assert.deepEqual(calls.filter((c) => c[1] === "/api/ptz").length, 1);
    });

    it("counts going to a place and saving one as things done, but not looking", async () => {
      const { call } = record();
      const go = await runAssistant({ brain: brainFor("camera_go_place", { name: "окно" }), model: "m", call, text: "x" });
      assert.equal(go.actions[0]!.ok, true);
      assert.equal(go.learnable, true);
      const look = await runAssistant({ brain: brainFor("camera_position", {}), model: "m", call, text: "x" });
      assert.equal(look.learnable ?? false, false);
    });
  });

  it("turns every light on when no lamp is named", async () => {
    const calls: Array<[string, string, object | undefined]> = [];
    const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: u === "/api/lights" ? { lights: [{ id: "wifi" }, { id: "ble" }] } : { ok: true } });
    await runAssistant({ brain: brainFor("lights_set", { on: true }), model: "m", call, text: "x" });
    assert.deepEqual(calls.slice(1), [["POST", "/api/lights/wifi", { on: true }], ["POST", "/api/lights/ble", { on: true }]]);
  });
});

describe("assistant honesty", () => {
  it("sends the model back to act when it only claims it did", async () => {
    const calls: string[] = [];
    const call: ApiCall = async (m, u) => (calls.push(`${m} ${u}`), { status: 200, body: {} });
    const { brain, seen } = scripted(
      message("end_turn", [{ type: "text", text: "Включил." }]),
      message("tool_use", [{ type: "tool_use", id: "t", name: "vacuum_status", input: {} }]),
      message("end_turn", [{ type: "text", text: "Пылесос на базе." }]),
    );
    const out = await runAssistant({ brain, model: "m", call, text: "x" });
    assert.equal(out.reply, "Пылесос на базе.");
    assert.equal(seen.length, 3);
    assert.deepEqual(calls, ["GET /api/vacuum"]);
  });

  it("keeps lamp values inside their limits", async () => {
    const calls: Array<object | undefined> = [];
    const call: ApiCall = async (_m, _u, b) => (calls.push(b), { status: 200, body: {} });
    const { brain } = scripted(message("tool_use", [{ type: "tool_use", id: "t", name: "lights_set", input: { id: "wifi", brightness: 255, saturation: 255, hue: 400 } }]), message("end_turn", [{ type: "text", text: "ок" }]));
    await runAssistant({ brain, model: "m", call, text: "x" });
    assert.deepEqual(calls[0], { brightness: 100, saturation: 100, hue: 360 });
  });
});

import { plain } from "../src/assistant.js";

describe("assistant input and honesty", () => {
  it("gives the model the phrase in one plain form", () => {
    assert.equal(plain("  Выключи свет. "), "выключи свет");
  });

  it("does not repeat an empty promise when the model never acts", async () => {
    const call: ApiCall = async () => ({ status: 200, body: {} });
    const { brain } = scripted(message("end_turn", [{ type: "text", text: "Выключаю свет." }]), message("end_turn", [{ type: "text", text: "Выключаю свет." }]));
    const out = await runAssistant({ brain, model: "m", call, text: "Сделай чтобы стало темно" });
    assert.match(out.reply, /Не поняла/);
    assert.deepEqual(out.actions, []);
  });
});


import { ASK_MODE, ASK_SUCTION, ASK_VACUUM, ASK_WATER, planQuick } from "../src/quick.js";

describe("quick commands (rules, no model)", () => {
  const plan = (t: string) => planQuick(plain(t))?.map((s) => [s.tool, s.input.action ?? s.input.direction ?? s.input.key ?? s.input.app ?? s.input.on]);

  it("understands the everyday phrases, as the microphone writes them", () => {
    assert.deepEqual(plan("Выключи свет."), [["lights_set", false]]);
    assert.deepEqual(plan("включи свет"), [["lights_set", true]]);
    assert.deepEqual(plan("Найди пылесос"), [["vacuum_action", "find"]]);
    assert.deepEqual(plan("find the robot") ?? null, null); // English goes to the model
    assert.deepEqual(plan("пылесос домой"), [["vacuum_action", "dock"]]);
    assert.deepEqual(plan("останови пылесос"), [["vacuum_action", "stop"]]);
    assert.deepEqual(plan("поверни камеру налево"), [["camera_move", "left"]]);
    assert.equal(planQuick(plain("направь камеру к двери")), null); // "направь" is not "вправо": that is a saved place, not a turn
    assert.deepEqual(plan("верни камеру назад"), [["camera_back", undefined]]);
    assert.deepEqual(plan("камера как было"), [["camera_back", undefined]]);
    assert.deepEqual(plan("сделай погромче"), [["tv_key", "volumeUp"]]);
    assert.deepEqual(plan("выключи звук"), [["tv_key", "mute"]]);
    assert.deepEqual(plan("открой ютуб"), [["tv_app", "youtube"]]);
  });

  it("tells the time and the date without a model", () => {
    const say = (t: string) => planQuick(plain(t))?.[0]?.say;
    assert.match(say("Который час") ?? "", /^Сейчас \d+ (час|часа|часов) \d+ (минута|минуты|минут)$/);
    assert.match(say("сколько времени") ?? "", /^Сейчас /);
    assert.match(say("какое сегодня число") ?? "", /^Сегодня /);
  });

  it("sets the cleaning mode even when the robot is not named", () => {
    assert.deepEqual(planQuick(plain("Поменяй режим на мытьё"))?.map((s) => [s.tool, s.input.mode]), [["vacuum_mode", "mopping"]]);
    assert.deepEqual(planQuick(plain("режим сухая уборка"))?.map((s) => [s.tool, s.input.mode]), [["vacuum_mode", "sweeping"]]);
  });

  it("reads suction: «мощность» alone is not «strong»; down and up are relative; no level asks", () => {
    const input = (t: string) => planQuick(plain(t))?.[0]?.input;
    assert.deepEqual(input("снизь мощность пылесоса"), { delta: -1 });
    assert.deepEqual(input("увеличь мощность пылесоса"), { delta: 1 });
    assert.deepEqual(input("слабая мощность пылесоса"), { level: "quiet" });
    assert.deepEqual(input("мощность пылесоса сильная"), { level: "strong" });
    assert.equal(planQuick(plain("поменяй мощность пылесоса"))?.[0]?.tool, "ask");
  });

  it("moves suction one level from where the robot is, and stops at the ends", async () => {
    const run = async (have: string, delta: number) => {
      const calls: Array<[string, string, object | undefined]> = [];
      const call: ApiCall = async (m, u, b) => (calls.push([m, u, b]), { status: 200, body: u === "/api/vacuum" ? { suction: have } : { ok: true } });
      await runAssistant({ brain: scripted(message("tool_use", [{ type: "tool_use", id: "t", name: "vacuum_suction", input: { delta } }]), message("end_turn", [{ type: "text", text: "ок" }])).brain, model: "m", call, text: "x" });
      return calls.at(-1);
    };
    assert.deepEqual(await run("strong", -1), ["POST", "/api/vacuum/suction", { level: "standard" }]);
    assert.deepEqual(await run("standard", 1), ["POST", "/api/vacuum/suction", { level: "strong" }]);
    assert.deepEqual(await run("quiet", -1), ["POST", "/api/vacuum/suction", { level: "quiet" }]);
  });

  it("leaves the camera places to the model: only the model knows the names a person gave them", () => {
    for (const heard of ["поверни камеру к двери", "посмотри на окно", "камера на дверь", "запомни это место как дверь"]) assert.equal(planQuick(plain(heard)), null, heard);
  });

  it("hears \"очисти бак\" even as the microphone mangles it", () => {
    for (const heard of ["Очисти бак.", "очись баг", "Очисть бэк", "очисти бак пылесоса", "опустоши бак", "вытряхни мусор"]) assert.deepEqual(plan(heard), [["vacuum_action", "empty"]], heard);
    assert.equal(planQuick(plain("очисти свет")), null);
  });

  it("sets the cleaning mode, power and water", () => {
    const one = (t: string) => planQuick(plain(t))?.map((x) => [x.tool, x.input.mode ?? x.input.level]);
    assert.deepEqual(one("Очисти бачок пылесоса"), [["vacuum_action", undefined]]);
    assert.deepEqual(one("Поменяй в пылесосе на мокрую уборку"), [["vacuum_mode", "mopping"]]);
    assert.deepEqual(one("пылесос сухая и мокрая уборка"), [["vacuum_mode", "both"]]);
    assert.deepEqual(one("пылесос только сухая уборка"), [["vacuum_mode", "sweeping"]]);
    assert.deepEqual(one("запусти мокрую уборку"), [["vacuum_mode", "mopping"], ["vacuum_clean", undefined]]);
    assert.deepEqual(one("пылесос потише"), [["vacuum_suction", "quiet"]]);
    assert.deepEqual(one("пылесос на полную мощность"), [["vacuum_suction", "turbo"]]);
    assert.deepEqual(one("пылесос больше воды"), [["vacuum_water", "high"]]);
    assert.deepEqual(one("Вода высоко."), [["vacuum_water", "high"]]);
    assert.deepEqual(one("вода низко"), [["vacuum_water", "low"]]);
    assert.deepEqual(one("вода средняя"), [["vacuum_water", "medium"]]);
    assert.deepEqual(one("мощность максимум"), [["vacuum_suction", "turbo"]]);
    assert.deepEqual(one("мощность тихо"), [["vacuum_suction", "quiet"]]);
    assert.deepEqual(one("режим всасывания Turbo"), [["vacuum_suction", "turbo"]]);
    assert.deepEqual(one("режим всасывания strong"), [["vacuum_suction", "strong"]]);
    assert.deepEqual(one("вода High"), [["vacuum_water", "high"]]);
    assert.equal(planQuick(plain("сделай потише")) ?.[0]?.tool, "tv_key"); // volume, not suction
  });

  it("asks for the value when only the setting is named, and takes the next phrase as the answer", async () => {
    assert.equal(planQuick(plain("у пылесоса режим всасывания"))?.[0]?.say, ASK_SUCTION);
    assert.equal(planQuick(plain("уровень воды"))?.[0]?.say, ASK_WATER);
    const calls: string[] = [];
    const call: ApiCall = async (m, u, b) => (calls.push(`${m} ${u} ${JSON.stringify(b)}`), { status: 200, body: {} });
    const never: Brain = { messages: { create: async () => assert.fail("no model") } };
    const asked = await runAssistant({ brain: never, model: "m", call, text: "у пылесоса режим всасывания" });
    assert.equal(asked.reply, ASK_SUCTION);
    assert.deepEqual(calls, []);
    await runAssistant({ brain: never, model: "m", call, text: "Турбо.", history: [{ role: "user", content: "x" }, { role: "assistant", content: ASK_SUCTION }] });
    assert.deepEqual(calls, ['POST /api/vacuum/suction {"level":"turbo"}']);
    await runAssistant({ brain: never, model: "m", call, text: "много", history: [{ role: "assistant", content: ASK_WATER }] });
    assert.equal(calls.at(-1), 'POST /api/vacuum/water {"level":"high"}');
  });

  it("understands the cleaning mode as people say it, and asks when no mode is named", async () => {
    const one = (t: string) => planQuick(plain(t))?.map((x) => [x.tool, x.input.mode ?? x.say]);
    assert.deepEqual(one("пылесос режим уборки двойной"), [["vacuum_mode", "both"]]);
    assert.deepEqual(one("режим уборки мытьё"), [["vacuum_mode", "mopping"]]);
    assert.deepEqual(one("пылесос режим мытья"), [["vacuum_mode", "mopping"]]);
    assert.deepEqual(one("пылесос режим уборки"), [["ask", ASK_MODE]]);
    const calls: string[] = [];
    const call: ApiCall = async (m, u, b) => (calls.push(`${m} ${u} ${JSON.stringify(b)}`), { status: 200, body: {} });
    const never: Brain = { messages: { create: async () => assert.fail("no model") } };
    await runAssistant({ brain: never, model: "m", call, text: "Двойной.", history: [{ role: "assistant", content: ASK_MODE }] });
    assert.deepEqual(calls, ['POST /api/vacuum/mode {"mode":"both"}']);
  });

  it("asks what is meant when the model does nothing about the vacuum", async () => {
    const { brain } = scripted(message("end_turn", [{ type: "text", text: "Нет инструмента для этой просьбы." }]), message("end_turn", [{ type: "text", text: "Нет инструмента для этой просьбы." }]));
    const out = await runAssistant({ brain, model: "m", call: async () => ({ status: 200, body: {} }), text: "пылесос фигня какая-то" });
    assert.equal(out.reply, ASK_VACUUM);
  });

  it("refreshes the map", () => {
    assert.deepEqual(planQuick(plain("Обнови карту."))?.map((x) => x.tool), ["vacuum_map_refresh"]);
    assert.deepEqual(planQuick(plain("обнови карту пылесоса"))?.map((x) => x.tool), ["vacuum_map_refresh"]);
    assert.equal(planQuick(plain("покажи карту")), null);
  });

  it("splits several commands in one phrase", () => {
    assert.deepEqual(plan("включи свет и запусти пылесос"), [["lights_set", true], ["vacuum_clean", undefined]]);
  });

  it("leaves what it does not know to the model", () => {
    assert.equal(planQuick(plain("какая погода в Париже")), null);
    assert.equal(planQuick(plain("включи свет и расскажи анекдот")), null);
    assert.equal(planQuick(plain("убери звук"))?.[0]?.tool, "tv_key"); // not a cleaning command
  });

  it("cleans the named room, or starts the whole house when none is named", async () => {
    const calls: string[] = [];
    const call: ApiCall = async (m, u, b) => (calls.push(`${m} ${u} ${b ? JSON.stringify(b) : ""}`.trim()), { status: 200, body: u.endsWith("/rooms") ? { rooms: [{ id: 3, name: "Кухня" }] } : { ok: true } });
    const never: Brain = { messages: { create: async () => assert.fail("the model must not be asked") } };
    const room = await runAssistant({ brain: never, model: "m", call, text: "Убери на кухне." });
    assert.match(room.reply, /Кухня/);
    assert.equal(calls.at(-1), 'POST /api/vacuum/clean-rooms {"rooms":[3]}');
    await runAssistant({ brain: never, model: "m", call, text: "запусти пылесос" });
    assert.equal(calls.at(-1), 'POST /api/vacuum {"action":"start"}');
  });

  it("reports a failed device in words", async () => {
    const call: ApiCall = async () => ({ status: 502, body: { error: "TV is off" } });
    const out = await runAssistant({ brain: { messages: { create: async () => assert.fail("no model") } }, model: "m", call, text: "громче" });
    assert.match(out.reply, /TV is off/);
    assert.equal(out.actions[0]!.ok, false);
  });
});

import { AssistantMemory } from "../src/assistantMemory.js";
import { autoTeach } from "../src/journalReport.js";

describe("tv keys with the TV named", () => {
  it("presses pause for «нажми на телевизоре пауза»", () => {
    assert.deepEqual(planQuick("нажми на телевизоре пауза")?.map((x) => x.input), [{ key: "playPause" }]);
    assert.deepEqual(planQuick("нажми на телевизоре кнопку play")?.map((x) => x.input), [{ key: "playPause" }]);
    assert.deepEqual(planQuick("нажми на телевизоре плей")?.map((x) => x.input), [{ key: "playPause" }]);
    assert.deepEqual(planQuick("закрой все приложения на телевизоре")?.map((x) => x.tool), ["tv_close_apps"]);
    assert.deepEqual(planQuick("включи hdmi 2")?.map((x) => x.input), [{ source: "hdmi2" }]);
    assert.deepEqual(planQuick("переключи на хдми один")?.map((x) => x.input), [{ source: "hdmi1" }]);
    assert.deepEqual(planQuick("включи плойку")?.map((x) => x.input), [{ source: "hdmi1" }]);
    assert.deepEqual(planQuick("открой ott player")?.map((x) => x.input), [{ app: "ottplay" }]);
    assert.deepEqual(planQuick("включила тт play")?.map((x) => x.input), [{ app: "ottplay" }]);
    assert.deepEqual(planQuick("включил вот эти play")?.map((x) => x.input), [{ app: "ottplay" }]);
    assert.deepEqual(planQuick("включила tt play")?.map((x) => x.input), [{ app: "ottplay" }]);
    assert.equal(planQuick("открой оттенок"), null);
    assert.deepEqual(planQuick("на телевизоре домой")?.map((x) => x.input), [{ key: "home" }]);
    assert.deepEqual(planQuick("в телевизоре нажми кнопку окей")?.map((x) => x.input), [{ key: "ok" }]);
  });
});

describe("assistant learns from the household", () => {
  const brainThatActs = () =>
    scripted(message("tool_use", [{ type: "tool_use", id: "t", name: "lights_set", input: { on: true, brightness: 20 } }]), message("end_turn", [{ type: "text", text: "Включил ночник" }])).brain;
  const okCall: ApiCall = async (_m, u) => ({ status: 200, body: u === "/api/lights" ? { lights: [{ id: "wifi" }] } : { ok: true } });
  const tmp = () => mkdtempSync(join(tmpdir(), "mem-"));

  it("remembers a phrase the model handled and then needs no model", async () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    const first = await runAssistant({ brain: brainThatActs(), model: "m", call: okCall, text: "Включи ночник", memory });
    assert.equal(first.learnable, true);
    assert.equal(memory.learn("включи ночник"), true);

    const never: Brain = { messages: { create: async () => assert.fail("learned phrases must not reach the model") } };
    const again = await runAssistant({ brain: never, model: "m", call: okCall, text: "включи ночник!", memory });
    assert.match(again.reply, /ночник/i);
    // and it survives a restart
    assert.equal(new AssistantMemory(dir).find("включи ночник")?.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("learns a phrase by itself on the second identical success, and 'нет' takes it back", async () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    const run = (text: string, brain = brainThatActs()) => runAssistant({ brain, model: "m", call: okCall, text, memory });
    const first = await run("Включи ночник");
    assert.equal(first.learnable, true);
    assert.equal(first.learned, undefined);
    assert.equal(memory.find("включи ночник"), undefined, "one run is not enough");
    const second = await run("Включи ночник");
    assert.equal(second.learned, true);
    assert.equal(memory.find("включи ночник")?.length, 1);

    // "no, not that" right after forgets what was just learned
    const never: Brain = { messages: { create: async () => assert.fail("not needed") } };
    await run("включи ночник", never); // answered from memory
    await runAssistant({ brain: scripted(message("end_turn", [{ type: "text", text: "Ок" }]), message("end_turn", [{ type: "text", text: "Ок" }])).brain, model: "m", call: okCall, text: "Нет, не то", memory });
    assert.equal(memory.find("включи ночник"), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks what was meant when it does not understand, and learns the explanation", async () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    const calls: string[] = [];
    const call: ApiCall = async (m, u) => (calls.push(`${m} ${u}`), { status: 200, body: { ok: true } });
    const miss = scripted(message("end_turn", [{ type: "text", text: "Нет инструмента для уборки всего дома." }]), message("end_turn", [{ type: "text", text: "Нет инструмента для уборки всего дома." }]));
    const asked = await runAssistant({ brain: miss.brain, model: "m", call, text: "Помой дом", memory });
    assert.match(asked.reply, /Не поняла «Помой дом»\. Что вы имели в виду/);
    assert.deepEqual(asked.actions, []);

    const never: Brain = { messages: { create: async () => assert.fail("rules understand this") } };
    const answer = await runAssistant({ brain: never, model: "m", call, text: "запусти пылесос", memory });
    assert.equal(answer.learned, true);
    assert.equal(memory.find("помой дом")?.[0]?.tool, "vacuum_clean");

    const again = await runAssistant({ brain: never, model: "m", call, text: "помой дом", memory });
    assert.equal(again.actions[0]?.tool, "vacuum_action");
    // an unrelated command later is not taught for a question nobody asked
    assert.equal(memory.takeAsked(), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not learn when the two runs did different things", () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    assert.equal(memory.offer("x", [{ tool: "tv_key", input: { key: "mute" }, say: "a" }]), false);
    assert.equal(memory.offer("x", [{ tool: "tv_key", input: { key: "ok" }, say: "a" }]), false);
    assert.equal(memory.find("x"), undefined);
    assert.equal(memory.offer("x", [{ tool: "tv_key", input: { key: "ok" }, say: "b" }]), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("cannot remember what was never done, and can forget", async () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    assert.equal(memory.learn("что-то левое"), false);
    const { brain } = scripted(message("end_turn", [{ type: "text", text: "Не знаю." }]), message("end_turn", [{ type: "text", text: "Не знаю." }]));
    const out = await runAssistant({ brain, model: "m", call: okCall, text: "что-то левое", memory });
    assert.equal(out.learnable, undefined);
    memory.offer("a", [{ tool: "tv_key", input: { key: "mute" }, say: "ок" }]);
    memory.learn("a");
    assert.equal(memory.forget("a"), true);
    assert.equal(memory.find("a"), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a journal saying who understood each phrase", async () => {
    const dir = tmp();
    const memory = new AssistantMemory(dir);
    await runAssistant({ brain: brainThatActs(), model: "m", call: okCall, text: "выключи свет", memory });
    await runAssistant({ brain: brainThatActs(), model: "m", call: okCall, text: "включи ночник", memory });
    assert.deepEqual(memory.recent().map((e) => [e.text, e.via, e.ok]), [["включи ночник", "model", true], ["выключи свет", "rules", true]]);
    rmSync(dir, { recursive: true, force: true });
  });
});
