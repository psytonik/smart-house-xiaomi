import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.match(out.reply, /Не получилось/);
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
    assert.deepEqual(plan("сделай погромче"), [["tv_key", "volumeUp"]]);
    assert.deepEqual(plan("выключи звук"), [["tv_key", "mute"]]);
    assert.deepEqual(plan("открой ютуб"), [["tv_app", "youtube"]]);
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
