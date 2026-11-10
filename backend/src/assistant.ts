import Anthropic from "@anthropic-ai/sdk";
import { PTZ_OPERATIONS } from "./go2rtc.js";
import { MOTOR_MAX, MOTOR_MIN } from "./ptzGoto.js";
import type { AssistantMemory } from "./assistantMemory.js";
import { ASK_HOME, ASK_VACUUM, planFollowUp, planQuick, type Step } from "./quick.js";
import { APP_IDS, KEY_NAMES } from "./tv/messages.js";
import { CLEANING_MODE_NAMES, SUCTION_NAMES, VACUUM_ACTIONS, WATER_NAMES } from "./vacuum.js";

/** How the assistant reaches the house: the app's own HTTP API, so every route's checks apply to it too. */
export type ApiCall = (method: "GET" | "POST", url: string, body?: object) => Promise<{ status: number; body: unknown }>;

/** The part of the SDK client the loop needs; tests pass a pretend one. */
export interface Brain {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantReply {
  /** What to say out loud and show. */
  reply: string;
  /** The model understood this one and it worked: the person may ask to remember the phrase. */
  learnable?: boolean;
  /** The assistant learned this phrase by itself just now. */
  learned?: boolean;
  /** What was done, for the screen (the tool names with their arguments). */
  actions: Array<{ tool: string; input: unknown; ok: boolean }>;
}

const MAX_ROUNDS = 6;
/** Stems of the verbs by which a reply claims something is being done or was done. */
const CLAIMS_ACTION = /(включ|выключ|закр|заверш|вызва|открыл|запуст|запуск|поверн|откр|переключ|начина|начал|останов|убира|убрал|сделал|делаю|постав|нажим|нажал|гашу|погас|потуш|увелич|уменьш|приглуш)/i;

/** What the microphone gives ("Выключи свет.") reads differently to a small model than what people type; make it one plain form. */
export const plain = (text: string) => text.trim().replace(/[.!?…]+$/u, "").toLowerCase();

const SYSTEM = `Ты голосовой помощник умного дома: камера Xiaomi с поворотом (умеет запоминать места по имени, например «дверь», «окно», и возвращаться к ним), робот-пылесос, ленты света и телевизор TCL.
Пользователь говорит по-русски, иногда по-английски (find the robot значит найти пылесос), всегда отвечай по-русски. Его фразу распознал микрофон, так что в ней бывают ошибки в словах: понимай по смыслу.
Выполняй просьбу инструментами сразу, не переспрашивай, если можно сделать разумно: «включи свет» значит включить весь свет (все лампы и ленты), «включи свет на кухне» или «выключи в спальне» только лампочку этой комнаты (id из lights_list), «включи ленту» или «подсветку» только ленты (group strip), «включи лампочки» только лампочки (group bulb), «выключи звук» и «включи звук» это одно нажатие mute, «громче» и «тише» это кнопки громкости телевизора (две-три штуки), а яркость относится только к свету: «ярче», «темнее», «приглуши».
Любая просьба про устройства, в том числе вопрос о состоянии, требует вызова инструмента: никогда не отвечай про устройства по памяти и не говори, что сделал, если не вызвал инструмент.
Команда только запускает действие: говори «включил», «запустил», «начал уборку», а не «убрано» и не «готово», если дело ещё идёт.
Отвечай одной-двумя короткими фразами простыми словами, без списков и разметки: ответ прочитают вслух.
Если инструмент вернул ошибку, скажи об этом честно и коротко. Если просьба не про дом или инструмента для неё нет, так и скажи.
Не придумывай, что сделал то, чего не делал.`;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, additionalProperties: false, properties, required });

/** What the assistant may do. Deliberately small: nothing that resets, pairs, deletes or changes settings. */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "camera_move",
    description: "Повернуть камеру. Один шаг это небольшой поворот; для «сильно» поставь до 5 шагов.",
    input_schema: object({ direction: { type: "string", enum: Object.keys(PTZ_OPERATIONS) }, steps: { type: "integer", minimum: 1, maximum: 5 } }, ["direction"]),
  },
  {
    name: "weather",
    description: "Погода на улице сейчас (температура, небо, ветер, нужен ли зонт). Если место дома не задано, вернёт ошибку home-not-set: спроси, в каком городе человек живёт.",
    input_schema: object({}),
  },
  {
    name: "camera_back",
    description: "Вернуть камеру туда, куда она смотрела до последнего поворота («назад», «верни как было»). Повторный вызов возвращает обратно.",
    input_schema: object({}),
  },
  {
    name: "camera_turn",
    description: "Повернуть камеру влево или вправо на заданное число градусов («направо на 90 градусов», «разверни на 180»). Приблизительно: камера идёт шагами, пока не придёт в нужное положение или не упрётся в край.",
    input_schema: object({ direction: { type: "string", enum: ["left", "right"] }, degrees: { type: "integer", minimum: 1, maximum: 360 } }, ["direction", "degrees"]),
  },
  {
    name: "camera_places",
    description: "Какие места камера запомнила (например «дверь», «окно»).",
    input_schema: object({}),
  },
  {
    name: "camera_go_place",
    description: "Повернуть камеру к запомненному месту по названию, как его называет человек («дверь», «окно»). Это долгое движение, камера идёт шагами.",
    input_schema: object({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "camera_save_place",
    description: "Запомнить место, куда камера смотрит сейчас, под именем («дверь»). Такое же имя заменяет старое место.",
    input_schema: object({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "camera_position",
    description: "Куда сейчас смотрит камера: положение по горизонтали (pan) и вертикали (tilt), от 1 до 101.",
    input_schema: object({}),
  },
  {
    name: "lights_list",
    description: "Какие лампочки (Кухня, Спальня, Туалет) и ленты света есть: id, название, group (bulb или strip), включены ли и какая яркость.",
    input_schema: object({}),
  },
  {
    name: "lights_set",
    description: "Включить, выключить или настроить свет. Без id действует на все лампы и ленты сразу; если названа комната («на кухне», «в спальне», «в туалете»), укажи id этой лампы. Указывай только то, что меняется.",
    input_schema: object(
      {
        id: { type: "string", description: "id лампы из lights_list (kitchen, sleeping, toilet, wifi, ble); не указывай, если нужны все" },
        group: { type: "string", enum: ["strip", "bulb"], description: "только ленты (strip: подсветка, лента) или только лампочки (bulb); не указывай, если не сказано иначе" },
        on: { type: "boolean" },
        brightness: { type: "integer", minimum: 0, maximum: 100 },
        hue: { type: "integer", minimum: 0, maximum: 360, description: "цвет: 0 красный, 120 зелёный, 240 синий" },
        saturation: { type: "integer", minimum: 0, maximum: 100 },
      },
    ),
  },
  {
    name: "vacuum_status",
    description: "Состояние пылесоса: что делает, заряд, ошибки.",
    input_schema: object({}),
  },
  {
    name: "vacuum_action",
    description: "Команда пылесосу: start (начать уборку), pause, stop (закончить), dock (домой на базу), find (подать голос), empty (опустошить бак на базе).",
    input_schema: object({ action: { type: "string", enum: VACUUM_ACTIONS } }, ["action"]),
  },
  {
    name: "vacuum_mode",
    description: "Режим уборки пылесоса: sweeping (сухая), mopping (мокрая, швабра), both (сухая и мокрая). Только переключает режим, уборку не запускает.",
    input_schema: object({ mode: { type: "string", enum: CLEANING_MODE_NAMES } }, ["mode"]),
  },
  {
    name: "vacuum_suction",
    description: "Мощность всасывания пылесоса: quiet (тихо), standard, strong, turbo.",
    input_schema: object({ level: { type: "string", enum: SUCTION_NAMES } }, ["level"]),
  },
  {
    name: "vacuum_water",
    description: "Сколько воды подаёт пылесос при мокрой уборке: low, medium, high.",
    input_schema: object({ level: { type: "string", enum: WATER_NAMES } }, ["level"]),
  },
  {
    name: "vacuum_map_refresh",
    description: "Обновить карту пылесоса: заново взять свежую карту у робота и перерисовать план.",
    input_schema: object({}),
  },
  {
    name: "vacuum_rooms",
    description: "Комнаты, сохранённые на карте пылесоса, с их номерами.",
    input_schema: object({}),
  },
  {
    name: "vacuum_clean_rooms",
    description: "Убрать только выбранные комнаты, по названиям (как их называет человек, например «кухня»). Пылесос должен стоять или быть на базе.",
    input_schema: object({ rooms: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 } }, ["rooms"]),
  },
  {
    name: "tv_key",
    description: "Нажать кнопку пульта телевизора: громкость, питание, стрелки, ok, назад, домой, воспроизведение и так далее.",
    input_schema: object({ key: { type: "string", enum: KEY_NAMES }, times: { type: "integer", minimum: 1, maximum: 10, description: "сколько раз нажать, например громкость" } }, ["key"]),
  },
  {
    name: "tv_app",
    description: "Открыть приложение на телевизоре.",
    input_schema: object({ app: { type: "string", enum: APP_IDS } }, ["app"]),
  },
  {
    name: "tv_close_apps",
    description: "Закрыть все запущенные приложения на телевизоре (нужен ADB). Только если просят закрыть все приложения.",
    input_schema: object({}),
  },
  {
    name: "tv_sources",
    description: "Какие источники сигнала у телевизора (HDMI 1, HDMI 2, AV, ТВ) и их id.",
    input_schema: object({}),
  },
  {
    name: "tv_source",
    description: "Переключить телевизор на источник (id из tv_sources).",
    input_schema: object({ source: { type: "string", pattern: "^[a-z0-9]{1,16}$" } }, ["source"]),
  },
];

/** Same word up to its ending: «спальню» is «Спальня», «на кухне» is «Кухня». */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= Math.max(3, Math.min(a.length, b.length) - 2);
}
const matchesRoom = (said: string, name: string) => {
  const n = name.toLowerCase();
  return said === n || said.split(/\s+/).some((w) => n.split(/\s+/).some((x) => sameWord(w, x)));
};

/** Small models put 255 where 100 is the limit; keep the values inside what the lamps accept. */
const clamp = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v))));
function tidyLight(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  if (out.brightness !== undefined) out.brightness = clamp(out.brightness, 100);
  if (out.saturation !== undefined) out.saturation = clamp(out.saturation, 100);
  if (out.hue !== undefined) out.hue = clamp(out.hue, 360);
  return out;
}

/**
 * How many degrees one unit of the camera's 1..101 angle scale is. NOT measured: assumed from a typical pan of about 355 degrees over
 * the range. Turn the camera "on 180 degrees" and, if it ends up short or past, change this number.
 */
export const DEGREES_PER_UNIT = 3.55;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CameraPos {
  angle: number;
  elevation: number;
}
/** Where the camera pointed before its last move by this assistant, so "back" has somewhere to go. */
let cameraBefore: CameraPos | undefined;

async function cameraNow(call: ApiCall, fresh: boolean): Promise<CameraPos | undefined> {
  try {
    const r = await call("GET", fresh ? "/api/ptz/position?refresh=1" : "/api/ptz/position");
    const b = r.body as { known?: boolean; angle?: number; elevation?: number };
    return r.status < 400 && b.known && b.angle !== undefined && b.elevation !== undefined ? { angle: b.angle, elevation: b.elevation } : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a camera move and remembers where the camera was, if the move worked. */
async function movingCamera(call: ApiCall, move: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }> {
  const before = await cameraNow(call, false);
  const out = await move();
  if (out.status < 400 && before) cameraBefore = before;
  return out;
}

/** One tool call becomes one or more calls to the app's own API. */
async function runTool(name: string, input: Record<string, unknown>, call: ApiCall): Promise<{ status: number; body: unknown }> {
  switch (name) {
    case "camera_move":
      return movingCamera(call, () => call("POST", "/api/ptz", { direction: input.direction, ...(input.steps ? { steps: input.steps } : {}) }));
    case "camera_back": {
      if (!cameraBefore) return { status: 409, body: { error: "I do not remember where the camera pointed before: nothing was moved by voice yet" } };
      const target = cameraBefore;
      const here = await cameraNow(call, true);
      const out = await call("POST", "/api/ptz/goto", target);
      if (out.status < 400 && here) cameraBefore = here; // saying it again goes forward again
      return out;
    }
    case "camera_turn": {
      const here = await call("GET", "/api/ptz/position?refresh=1");
      if (here.status >= 400) return here;
      const pos = here.body as { known?: boolean; angle?: number; elevation?: number };
      if (!pos.known || pos.angle === undefined || pos.elevation === undefined) return { status: 409, body: { error: "the camera did not say where it points: is the stream up?" } };
      const units = Math.round(Number(input.degrees) / DEGREES_PER_UNIT);
      // Left raises the angle, right lowers it (measured on the camera); the range is 1..101.
      const angle = Math.max(MOTOR_MIN, Math.min(MOTOR_MAX, pos.angle + (input.direction === "left" ? units : -units)));
      const out = await call("POST", "/api/ptz/goto", { angle, elevation: pos.elevation });
      if (out.status < 400) cameraBefore = { angle: pos.angle, elevation: pos.elevation };
      return out;
    }
    case "weather":
      return call("GET", "/api/weather");
    case "home_place":
      return call("POST", "/api/home/place", { name: String(input.name ?? "") });
    case "camera_places":
      return call("GET", "/api/ptz/presets");
    case "camera_position":
      return call("GET", "/api/ptz/position?refresh=1");
    case "camera_save_place":
      return call("POST", "/api/ptz/presets", { name: String(input.name ?? "") });
    case "camera_go_place": {
      // The model says the place the way people do ("к двери"); the id is the app's business.
      const saved = await call("GET", "/api/ptz/presets");
      if (saved.status >= 400) return saved;
      const known = (saved.body as { presets?: Array<{ id: string; name: string }> }).presets ?? [];
      const said = String(input.name ?? "").trim().toLowerCase();
      const hit = known.find((p) => p.name.toLowerCase() === said) ?? known.find((p) => matchesRoom(said, p.name));
      if (!hit) return { status: 400, body: { error: `no such place: ${said}`, places: known.map((p) => p.name) } };
      return movingCamera(call, () => call("POST", `/api/ptz/presets/${encodeURIComponent(hit.id)}/go`));
    }
    case "lights_list":
      return call("GET", "/api/lights");
    case "lights_set": {
      const { id, group, where, ...raw } = input;
      const patch = tidyLight(raw);
      if (id) return call("POST", `/api/lights/${encodeURIComponent(String(id))}`, patch);
      const list = await call("GET", "/api/lights");
      const all = ((list.body as { lights?: Array<{ id: string; name?: string; group?: string }> }).lights ?? []).filter((l) => !group || l.group === group);
      // «на кухне» picks the lamp called Кухня; a place no lamp is called means nothing was singled out, so all of them
      const place = typeof where === "string" ? all.find((l) => matchesRoom(where.toLowerCase(), l.name ?? "")) : undefined;
      const lamps = place ? [place] : all;
      const ids = lamps.map((l) => l.id);
      if (list.status >= 400) return list;
      if (ids.length === 0) return { status: 404, body: { error: group ? `no lights of kind ${String(group)}` : "no lights are configured" } };
      const results = await Promise.all(ids.map((lamp) => call("POST", `/api/lights/${encodeURIComponent(lamp)}`, patch)));
      return results.find((r) => r.status >= 400) ?? results[0]!;
    }
    case "vacuum_status":
      return call("GET", "/api/vacuum");
    case "vacuum_action":
      return call("POST", "/api/vacuum", { action: input.action });
    case "vacuum_mode":
      return call("POST", "/api/vacuum/mode", { mode: input.mode });
    case "vacuum_suction": {
      let level = input.level;
      if (input.delta !== undefined) {
        // One level up or down from where the robot is now.
        const now = await call("GET", "/api/vacuum");
        const have = (now.body as { suction?: string }).suction;
        const at = SUCTION_NAMES.indexOf(have as (typeof SUCTION_NAMES)[number]);
        if (now.status >= 400 || at < 0) return { status: 409, body: { error: "the robot did not say its current suction" } };
        const next = Math.max(0, Math.min(SUCTION_NAMES.length - 1, at + Number(input.delta)));
        level = SUCTION_NAMES[next];
      }
      return call("POST", "/api/vacuum/suction", { level });
    }
    case "vacuum_water":
      return call("POST", "/api/vacuum/water", { level: input.level });
    case "vacuum_map_refresh":
      return call("POST", "/api/vacuum/map/refresh");
    case "vacuum_rooms":
      return call("GET", "/api/vacuum/rooms");
    case "vacuum_clean_rooms": {
      // The model names rooms the way people do; the numbers are the robot's business.
      const saved = await call("GET", "/api/vacuum/rooms");
      if (saved.status >= 400) return saved;
      const known = (saved.body as { rooms?: Array<{ id: number; name: string }> }).rooms ?? [];
      const wanted = ((input.rooms as unknown[]) ?? []).map((r) => String(r).trim().toLowerCase());
      const ids: number[] = [];
      const missing: string[] = [];
      for (const w of wanted) {
        const hit = known.find((r) => r.name.toLowerCase() === w) ?? known.find((r) => matchesRoom(w, r.name));
        if (hit) ids.push(hit.id);
        else missing.push(w);
      }
      if (missing.length) return { status: 400, body: { error: `no such room: ${missing.join(", ")}`, rooms: known.map((r) => r.name) } };
      return call("POST", "/api/vacuum/clean-rooms", { rooms: [...new Set(ids)] });
    }
    case "tv_key": {
      const times = Math.min(Number(input.times ?? 1), 10);
      let last = { status: 200, body: {} as unknown };
      for (let i = 0; i < times; i++) {
        if (i > 0) await sleep(input.adb === true ? 250 : 150);
        last = await call("POST", "/api/tv/key", { key: input.key, ...(input.adb === true && { adb: true }) });
        if (last.status >= 400) break;
      }
      return last;
    }
    case "prisma_search":
      return call("POST", "/api/tv/prisma/search", { query: input.query });
    case "tv_keys":
      return call("POST", "/api/tv/keys", { keys: input.keys });
    case "tv_app":
      return call("POST", "/api/tv/app", { app: input.app });
    case "tv_close_apps":
      return call("POST", "/api/tv/running/close", Array.isArray(input.packages) ? { packages: input.packages } : { all: true });
    case "tv_sources":
      return call("GET", "/api/tv/sources");
    case "tv_source":
      return call("POST", "/api/tv/source", { source: input.source });
    default:
      return { status: 400, body: { error: `unknown tool ${name}` } };
  }
}

/** Rooms named in the phrase (by the robot's saved map), or none. */
async function roomsIn(text: string, call: ApiCall): Promise<string[]> {
  const saved = await call("GET", "/api/vacuum/rooms");
  if (saved.status >= 400) return [];
  const known = (saved.body as { rooms?: Array<{ name: string }> }).rooms ?? [];
  return known.filter((r) => matchesRoom(text, r.name)).map((r) => r.name);
}

/** Does the steps one after another and reports in words; stops at the first one that fails. */
async function runSteps(steps: Step[], call: ApiCall, pause: (ms: number) => Promise<void> = sleep): Promise<AssistantReply> {
  const actions: AssistantReply["actions"] = [];
  const said: string[] = [];
  for (const step of steps) {
    // A question back to the person: nothing is done, and the next phrase is the answer.
    if (step.tool === "ask") return { reply: step.say, actions };
    // Keys meant for a list that may not be there: «Смотреть» of a series with progress starts the player at once, and keys sent into it would pause it.
    if (step.tool === "tv_keys" && step.input.unlessPlayer === true) {
      const front = await call("GET", "/api/tv/foreground").catch(() => undefined);
      if (/PlayerActivity/.test(String((front?.body as { window?: string } | undefined)?.window ?? ""))) {
        if (step.say) said.push(step.say);
        continue;
      }
      step.input = { keys: step.input.keys };
    }
    // A pause between steps (an app needs time to open before it gets keys); never more than 20 seconds.
    if (step.tool === "wait") {
      await pause(Math.min(20_000, Number(step.input.ms) || 0));
      continue;
    }
    let tool = step.tool;
    let input = step.input;
    let say = step.say;
    if (tool === "vacuum_clean") {
      const rooms = await roomsIn(String(input.text), call);
      if (rooms.length) {
        tool = "vacuum_clean_rooms";
        input = { rooms };
        say = `Пылесос убирает: ${rooms.join(", ")}`;
      } else {
        tool = "vacuum_action";
        input = { action: "start" };
      }
    }
    // An app that must be given time to start before the next steps send it keys: more if it was not running.
    const settle = tool === "tv_app" ? (input.settle as { package: string; warm: number; cold: number } | undefined) : undefined;
    let wasRunning = true;
    if (settle) {
      input = { app: input.app };
      const list = await call("GET", "/api/tv/running").catch(() => undefined);
      wasRunning = ((list?.body as { apps?: Array<{ package: string }> } | undefined)?.apps ?? []).some((a) => a.package === settle.package);
    }
    let out: { status: number; body: unknown };
    try {
      out = await runTool(tool, input, call);
    } catch (e) {
      out = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    if (settle && out.status < 400) await pause(wasRunning ? settle.warm : settle.cold);
    const ok = out.status < 400;
    actions.push({ tool, input, ok });
    // The weather needs to know where the house is: ask once, and the next phrase is the answer.
    if (tool === "weather" && out.status === 409 && (out.body as { error?: string } | null)?.error === "home-not-set") return { reply: ASK_HOME, actions };
    if (ok && tool === "weather") say = String((out.body as { text?: string }).text ?? "");
    if (!ok) {
      const why = (out.body as { error?: string } | null)?.error;
      return { reply: spokenFailure(tool, why), actions };
    }
    if (say) said.push(say);
  }
  return { reply: said.join(". ") + ".", actions };
}

/** Tools that change something; the others only look, and are not worth remembering. */
/** Device names for the spoken failure, by the start of the tool name. Each phrase made from them is in COMMON_PHRASES (tts.ts), so it plays at once from the cache. */
const DEVICE_WORD: Array<[prefix: string, word: string]> = [
  ["vacuum", "пылесос"],
  ["lights", "свет"],
  ["tv", "телевизор"],
  ["camera", "камера"],
];

/** What the voice says when a tool failed. "vacuum did not answer" is English, which the Russian voice reads badly and slowly: a device that is silent gets a short fixed phrase from the cache. */
export function spokenFailure(tool: string, why: string | undefined): string {
  const device = DEVICE_WORD.find(([prefix]) => tool.startsWith(prefix))?.[1];
  if (!why || /did not answer|unreachable|timed? ?out|refused|ECONN/i.test(why)) return device ? `Не получилось: ${device} не отвечает.` : "Не получилось: устройство не отвечает.";
  return `Не получилось: ${why}.`; // a reason that says something (the TV is off, the robot is not on its dock) is kept as it is
}

const DOES = new Set(["camera_move", "camera_back", "camera_turn", "camera_go_place", "camera_save_place", "lights_set", "vacuum_action", "vacuum_map_refresh", "vacuum_mode", "vacuum_suction", "vacuum_water", "vacuum_clean_rooms", "tv_key", "tv_keys", "tv_app", "tv_source", "tv_close_apps"]);

/** Words that make a phrase about the camera, so a saved place named in it ("дверь") is a place to look at. */
const CAMERA_TALK = /(камер|направь|поверни|повернись|посмотри|покажи|смотри)/;

/** «Направь камеру к двери», «камера дверь»: the camera goes to the saved place the phrase names, if it names one. */
async function placeInPhrase(phrase: string, call: ApiCall): Promise<Step[] | null> {
  if (!CAMERA_TALK.test(phrase) || /(запомни|сохрани|удали|забудь)/.test(phrase)) return null;
  try {
    const saved = await call("GET", "/api/ptz/presets");
    const known = (saved.body as { presets?: Array<{ name: string }> }).presets ?? [];
    const hit = saved.status < 400 ? known.find((p) => matchesRoom(phrase, p.name)) : undefined;
    return hit ? [{ tool: "camera_go_place", input: { name: hit.name }, say: `Камера повернулась к месту «${hit.name}»` }] : null;
  } catch {
    return null;
  }
}

/** The model's own words for "I could not do that". */
const NOT_UNDERSTOOD = /(не (могу|знаю|понял|поняла|умею|получилось)|нет (функци|инструмент|возможност)|у меня нет)/i;

/** The person says the last guess was wrong: it must not be learned (or is forgotten if just learned). */
const CORRECTION = /^(?:нет|не то|не так|неправильно|не надо|отмена|отмени)(?![а-яё])/u;

/** Understands one spoken phrase (with the recent turns for context) and does it. */
export async function runAssistant(opts: { brain: Brain; model: string; call: ApiCall; text: string; history?: Turn[]; memory?: AssistantMemory; /** Replaces the real waits between steps (tests). */ pause?: (ms: number) => Promise<void> }): Promise<AssistantReply> {
  const phrase = plain(opts.text);
  const { memory } = opts;
  if (CORRECTION.test(phrase)) memory?.correction();
  // The last phrase was not understood and the person was asked what they meant: this phrase is the explanation.
  const explains = CORRECTION.test(phrase) ? undefined : memory?.takeAsked();
  // What the household taught it, then the everyday rules: instant, free, and never "say it and not do it". The model is for the rest.
  const taught = memory?.find(phrase);
  const lastSaid = [...(opts.history ?? [])].reverse().find((t) => t.role === "assistant")?.content;
  const steps = taught ?? planFollowUp(phrase, lastSaid) ?? (await placeInPhrase(phrase, opts.call)) ?? planQuick(phrase);
  let via: "rules" | "learned" | "model" = taught ? "learned" : "rules";
  let result: AssistantReply;
  if (steps) result = await runSteps(steps, opts.call, opts.pause);
  else {
    via = "model";
    result = await askModel(opts);
    // About the vacuum, but nothing was done (no tool fit, or the model only talked): ask what is meant instead of "no tool for that".
    if (result.actions.length === 0 && /(пылесос|уборк|робот)/.test(phrase)) {
      result = { reply: ASK_VACUUM, actions: [] };
      memory?.ask(phrase);
    } else if (result.actions.length === 0 && NOT_UNDERSTOOD.test(result.reply)) {
      // Not "no tool for that" and stop: ask what was meant, and learn the answer.
      result = { reply: `Не поняла «${opts.text.trim().replace(/[.!?]+$/u, "")}». Что вы имели в виду? Скажите по-другому, и я запомню.`, actions: [] };
      memory?.ask(phrase);
    }
    const done = result.actions.filter((a) => DOES.has(a.tool));
    if (done.length > 0 && done.every((a) => a.ok)) {
      const learnedNow = memory?.offer(phrase, done.map((a) => ({ tool: a.tool, input: a.input as Record<string, unknown>, say: result.reply.replace(/[.!]+$/u, "") })));
      if (learnedNow) result.learned = true;
      else result.learnable = true;
    }
  }
  if (explains && explains !== phrase && result.actions.length > 0 && result.actions.every((a) => a.ok)) {
    const done = result.actions.filter((a) => DOES.has(a.tool));
    const taught = steps ?? done.map((a) => ({ tool: a.tool, input: a.input as Record<string, unknown>, say: result.reply.replace(/[.!]+$/u, "") }));
    if (done.length > 0 && memory?.teach(explains, taught)) result.learned = true;
  }
  memory?.note({ text: opts.text, via, ok: result.actions.length > 0 && result.actions.every((a) => a.ok), reply: result.reply, actions: result.actions.map((a) => ({ tool: a.tool, ok: a.ok })) });
  return result;
}

async function askModel(opts: { brain: Brain; model: string; call: ApiCall; text: string; history?: Turn[] }): Promise<AssistantReply> {
  const { brain, model, call } = opts;
  const messages: Anthropic.MessageParam[] = [...(opts.history ?? []).map((t): Anthropic.MessageParam => ({ role: t.role, content: t.content })), { role: "user", content: plain(opts.text) }];
  const actions: AssistantReply["actions"] = [];
  let nudged = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await brain.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: TOOLS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages,
    });

    if (res.stop_reason === "refusal") return { reply: "Не могу с этим помочь.", actions };

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) {
      // A small model sometimes answers in words without touching anything ("done", or a made-up status). Once, send it back to use a tool.
      if (actions.length === 0 && !nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: text }, { role: "user", content: "Ты не вызвал ни одного инструмента. Если просьба про дом, вызови нужный инструмент сейчас. Если для неё нет инструмента или она не про дом, коротко скажи об этом." });
        continue;
      }
      // Said it, did nothing, and the nudge changed nothing: do not pass the empty promise on to the person.
      if (actions.length === 0 && CLAIMS_ACTION.test(text)) return { reply: "Не получилось выполнить команду. Скажите ещё раз, чуть по-другому.", actions };
      return { reply: text || "Готово.", actions };
    }

    // The assistant turn goes back whole (thinking blocks included); all results return in one user message.
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      let out: { status: number; body: unknown };
      try {
        out = await runTool(use.name, input, call);
      } catch (e) {
        out = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      const ok = out.status < 400;
      actions.push({ tool: use.name, input, ok });
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.body).slice(0, 6000), ...(ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "Не успел довести до конца, попробуйте сказать проще.", actions };
}
