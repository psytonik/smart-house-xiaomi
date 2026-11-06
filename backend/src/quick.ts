/**
 * The everyday commands, understood by rules instead of by a model: instant, the same every time, and free.
 * A phrase these rules do not fully understand returns null and goes to the model.
 */

export interface Step {
  /** A tool of assistant.ts, or "vacuum_clean" (the rooms named in the phrase, or the whole house). */
  tool: string;
  input: Record<string, unknown>;
  /** What to say if it worked. */
  say: string;
}

const has = (text: string, re: RegExp) => re.test(text);

/** Questions asked when the phrase names the setting but not the value; the next phrase may be just the answer. */
export const ASK_SUCTION = "Какую мощность всасывания: тихо, стандарт, сильно или турбо?";
export const askTurn = (degrees: number) => `Куда повернуть камеру на ${degrees}°: налево или направо?`;
export const ASK_HOME = "Где вы живёте? Назовите город, или нажмите в панели «Определить по GPS».";
export const ASK_WATER = "Сколько воды: мало, средне или много?";
export const ASK_MODE = "Какой режим уборки: сухая, мытьё или двойная?";
/** Asked when the phrase is about a vacuum and nothing could be done with it. */
export const ASK_VACUUM = "Что сделать с пылесосом: запустить, домой, найти, режим уборки, мощность или вода?";

const COLORS: Array<[RegExp, string, Record<string, unknown>]> = [
  [/красн/, "красным", { hue: 0 }],
  [/оранж/, "оранжевым", { hue: 30 }],
  [/[жш]елт|жёлт/, "жёлтым", { hue: 55 }],
  [/зел[её]н/, "зелёным", { hue: 120 }],
  [/голуб|бирюз/, "голубым", { hue: 190 }],
  [/син/, "синим", { hue: 240 }],
  [/фиолет|сирен/, "фиолетовым", { hue: 280 }],
  [/розов/, "розовым", { hue: 320 }],
  [/бел/, "белым", { saturation: 0 }],
];

const WORDS = {
  light: /(свет|лент|ламп|подсветк|освещени)/,
  on: /(включи|зажги|включить|запали)/,
  off: /(выключи|погаси|потуши|выруби|отключи|выключить)/,
  vacuum: /(пылесос|робот|уборк)/,
  tv: /(телевизор|телик|\bтв\b)/,
  camera: /(камер)/,
};

/** Cleaning mode in the phrase: сухая, мокрая / мытьё, двойная. Null when it names none. */
function cleaningMode(t: string): "sweeping" | "mopping" | "both" | null {
  if (has(t, /(двойн|сух\S*\s+и\s+(мокр|влажн)|(мокр|влажн)\S*\s+и\s+сух|и то и другое|\bобе\b|\bоба\b|вместе|смешан)/)) return "both";
  if (has(t, /(мокр|протир|швабр|влажн|мытье|мытьё|мытья|мытьем|мыть|мойк|моющ)/)) return "mopping";
  if (has(t, /(сух|только пылесос|только подмет|без воды|подметани|пылесошен)/)) return "sweeping";
  return null;
}

/** Water level in the phrase: «вода высоко», «больше воды», «средняя вода». Null when the phrase is not about water. */
function waterLevel(t: string, bare = false): "low" | "medium" | "high" | null {
  if (!bare && !has(t, /(вод[аыуе]|влажност)/)) return null;
  if (has(t, /(больше|побольше|много|высок|сильн|максимум|максимальн|полн|high|max)/)) return "high";
  if (has(t, /(меньше|поменьше|мало|низк|слаб|минимум|минимальн|low|min)/)) return "low";
  if (has(t, /(средн|нормальн|обычн|medium|normal)/)) return "medium";
  return null;
}

/** Suction in the phrase: «мощность максимум», «потише», «турбо». Null when it is not about suction. */
/** "Снизь/увеличь мощность": one level down or up from where it is now. */
function suctionDelta(t: string): -1 | 1 | null {
  if (!has(t, /(мощност|всасыван)/)) return null;
  if (has(t, /(сни[зж]|уменьш|пониз|убав|убери|меньше|поменьше|слабее|потише|тише)/)) return -1;
  if (has(t, /(увелич|повыс|подним|добав|больше|побольше|сильнее|помощнее)/)) return 1;
  return null;
}

function suctionLevel(t: string, needsPowerWord: boolean): "quiet" | "standard" | "strong" | "turbo" | null {
  const about = has(t, /(мощност|всасыван)/);
  if (needsPowerWord && !about) return null;
  if (has(t, /(тих|тише|потише|слаб|quiet|silent|eco|эко)/)) return "quiet";
  if (has(t, /(турбо|turbo|тур бо|максимальн|максимум|max|на полную)/)) return "turbo";
  if (has(t, /(сильн|мощн(?!ост)|высок|strong|high)/)) return "strong";
  if (has(t, /(стандарт|standard|обычн|средн|нормальн|medium|normal)/) && about) return "standard";
  return null;
}

/** «1 час, 2 часа, 5 часов». */
const plural = (n: number, one: string, few: string, many: string) => (n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many);

/** One short command (no "and") to the steps it means, or null if it is not one the rules know. */
function planOne(part: string): Step[] | null {
  const t = part.trim();
  if (!t) return null;

  // --- time and date: nothing to do, only to say (the "ask" step says its text and does nothing) ---
  if (has(t, /(который час|сколько (сейчас )?времени|сколько время|скажи время|сколько натикало)/)) {
    const d = new Date();
    return [{ tool: "ask", input: {}, say: `Сейчас ${d.getHours()} ${plural(d.getHours(), "час", "часа", "часов")} ${d.getMinutes()} ${plural(d.getMinutes(), "минута", "минуты", "минут")}` }];
  }
  if (has(t, /(какое (сегодня )?число|какой (сегодня )?(день|дата)|какая (сегодня )?дата|сегодня какое)/)) {
    const day = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
    return [{ tool: "ask", input: {}, say: `Сегодня ${day}` }];
  }

  // --- weather outside, and where the house is (for the weather) ---
  // The weather of another place («в Париже») is not the house's weather: the model's business, not a rule's.
  if (has(t, /погод\S*\s+(в|во|на)\s+(?!улиц)\S+/)) return null;
  if (has(t, /(погод|сколько градусов|температур\S* на улице|на улице (тепло|холодно|дожд|снег|жарко|сколько)|нужен ли зонт|брать зонт|идёт ли дождь|идет ли дождь|будет ли дождь)/)) return [{ tool: "weather", input: {}, say: "" }];
  const lives = /(?:я живу|мой дом|мой город)\s+(?:в|во|на)\s+(.+)$/.exec(t);
  if (lives) return [{ tool: "home_place", input: { name: lives[1]!.trim() }, say: "Запомнил, где вы живёте" }];

  // --- light ---
  if (has(t, WORDS.light) && !has(t, WORDS.vacuum) && !has(t, WORDS.camera)) {
    for (const [re, name, patch] of COLORS) {
      if (has(t, re)) return [{ tool: "lights_set", input: { on: true, brightness: 100, saturation: 100, ...patch }, say: `Свет стал ${name}` }];
    }
    if (has(t, /(ярче|поярче|светлее|посветлее|максимум)/)) return [{ tool: "lights_set", input: { on: true, brightness: 100 }, say: "Сделал ярче" }];
    if (has(t, /(темнее|потемнее|приглуши|тусклее|потусклее)/)) return [{ tool: "lights_set", input: { on: true, brightness: 30 }, say: "Приглушил свет" }];
    if (has(t, WORDS.off)) return [{ tool: "lights_set", input: { on: false }, say: "Свет выключен" }];
    if (has(t, WORDS.on)) return [{ tool: "lights_set", input: { on: true }, say: "Свет включён" }];
    return null;
  }

  // --- vacuum: redraw the floor plan from the robot's own map ---
  if (has(t, /карт/) && has(t, /(обнови|обновить|обновление|перерисуй|перезагрузи|загрузи|свежую|свежая|refresh|update)/) && !has(t, WORDS.light) && !has(t, WORDS.tv)) {
    return [{ tool: "vacuum_map_refresh", input: {}, say: "Обновляю карту пылесоса" }];
  }

  // --- vacuum: empty the bin. The microphone hears "очисти бак" as "очись баг", "очисть бэк" and the like, so the sound is matched loosely.
  if (has(t, /(очис|очист|опустош|опорожн|вытряхн|выгрузи|разгрузи)/) && has(t, /(бак|бач|баг|бэк|бег|бук|back|мусор|пыл)/) && !has(t, WORDS.light)) {
    return [{ tool: "vacuum_action", input: { action: "empty" }, say: "Опустошаю бак пылесоса" }];
  }

  // --- vacuum: water and suction named on their own ("вода высоко", "мощность максимум"), with no word «пылесос» ---
  if (!has(t, WORDS.light) && !has(t, WORDS.tv) && !has(t, WORDS.vacuum)) {
    const water = waterLevel(t);
    if (water) return [{ tool: "vacuum_water", input: { level: water }, say: "Поменял количество воды" }];
    const delta = suctionDelta(t);
    if (delta) return [{ tool: "vacuum_suction", input: { delta }, say: "Поменял мощность пылесоса" }];
    const suction = suctionLevel(t, true);
    if (suction) return [{ tool: "vacuum_suction", input: { level: suction }, say: "Поменял мощность пылесоса" }];
    if (has(t, /(мощност|всасыван)/)) return [{ tool: "ask", input: {}, say: ASK_SUCTION }];
    if (has(t, /(уровень|количество|подач)\S* воды/)) return [{ tool: "ask", input: {}, say: ASK_WATER }];
  }

  // --- vacuum ---
  // «Поменяй режим на мытьё» names no robot, but nothing else in the house has a cleaning mode.
  if (has(t, WORDS.vacuum) || (has(t, /режим/) && cleaningMode(t) !== null && !has(t, WORDS.tv) && !has(t, WORDS.camera)) || (has(t, /(пропылесос|убери|помой пол|подмети)/) && !has(t, /(звук|громкост)/))) {
    if (has(t, /(найди|где|подай голос|позови)/)) return [{ tool: "vacuum_action", input: { action: "find" }, say: "Пылесос подаёт голос" }];
    if (has(t, /(опустоши|вытряхни|очисти бак|опорожни)/)) return [{ tool: "vacuum_action", input: { action: "empty" }, say: "Опустошаю бак" }];
    if (has(t, /(домой|на базу|на станцию|на зарядку|заряжаться|вернись)/)) return [{ tool: "vacuum_action", input: { action: "dock" }, say: "Пылесос едет на базу" }];
    if (has(t, /(пауза|паузу|приостанов)/)) return [{ tool: "vacuum_action", input: { action: "pause" }, say: "Пауза" }];
    if (has(t, /(останов|прекрати|стоп|хватит|заверши|отмени)/)) return [{ tool: "vacuum_action", input: { action: "stop" }, say: "Уборка остановлена" }];
    // What kind of cleaning, how hard, how wet. "Мокрая уборка" sets the mode; with "запусти" it also starts.
    const start = has(t, /(запусти|начни|начать|поехали|поезжай)/);
    const mode = cleaningMode(t);
    const modeWords = { both: "двойную уборку", mopping: "мытьё", sweeping: "сухую уборку" } as const;
    if (mode) {
      const steps: Step[] = [{ tool: "vacuum_mode", input: { mode }, say: `Включил ${modeWords[mode]}` }];
      if (start) steps.push({ tool: "vacuum_clean", input: { text: t }, say: "Пылесос начал уборку" });
      return steps;
    }
    const delta = suctionDelta(t);
    if (delta && !start) return [{ tool: "vacuum_suction", input: { delta }, say: "Поменял мощность пылесоса" }];
    const suction = suctionLevel(t, false);
    if (suction && !start) return [{ tool: "vacuum_suction", input: { level: suction }, say: "Поменял мощность пылесоса" }];
    const water = waterLevel(t);
    if (water) return [{ tool: "vacuum_water", input: { level: water }, say: "Поменял количество воды" }];
    if (has(t, /(мощност|всасыван)/)) return [{ tool: "ask", input: {}, say: ASK_SUCTION }];
    if (has(t, /режим\S*\s+(уборк|мытья|мытье|мытьё|работы)|тип уборки|вид уборки/)) return [{ tool: "ask", input: {}, say: ASK_MODE }];
    if (has(t, /(уровень|количество|подач)\S* воды|вода|воды/)) return [{ tool: "ask", input: {}, say: ASK_WATER }];
    if (has(t, /(запусти|включи|начни|начать|поехали|убери|пропылесось|пылесось|поезжай|продолжи|подмети|помой)/)) return [{ tool: "vacuum_clean", input: { text: t }, say: "Пылесос начал уборку" }];
    return null;
  }

  // --- camera ---
  if (has(t, WORDS.camera) || has(t, /(поверни|повернись|крути)/)) {
    const far = has(t, /(сильно|сильнее|намного|до конца|побольше)/);
    // "назад", "верни как было": back to where the camera pointed before its last move.
    if (has(t, /(назад|обратно|на место|как было|прежн|изначальн|исходн)/) && !has(t, /(лев|влево|налево|прав|вправо|направо|вверх|вниз)/)) {
      return [{ tool: "camera_back", input: {}, say: "Камера вернулась на прежнее место" }];
    }
    // "направо на 180 градусов": a turn by an angle, walked by the camera's own position, not a couple of steps.
    const turn = /(\d{1,3})\s*(?:°|градус)/.exec(t);
    const side = has(t, /((?<![а-яё])лев|влево|налево)/) ? "left" : has(t, /((?<![а-яё])прав|вправо|направо)/) ? "right" : null;
    if (turn && side) {
      const degrees = Math.min(360, Number(turn[1]));
      if (degrees > 0) return [{ tool: "camera_turn", input: { direction: side, degrees }, say: `Камера повернулась ${side === "left" ? "налево" : "направо"} примерно на ${degrees}°` }];
    }
    if (turn && !side && has(t, /(поверни|повернись|крути)/)) return [{ tool: "ask", input: { degrees: Math.min(360, Number(turn[1])) }, say: askTurn(Math.min(360, Number(turn[1]))) }];
    const dir = has(t, /((?<![а-яё])лев|влево|налево)/) ? "left" : has(t, /((?<![а-яё])прав|вправо|направо)/) ? "right" : has(t, /(вверх|выше|поднимись|наверх)/) ? "up" : has(t, /(вниз|ниже|опустись)/) ? "down" : null;
    if (dir && has(t, /(поверни|повернись|крути|двинь|посмотри|смотри|наклони|камер)/)) {
      const names = { left: "налево", right: "направо", up: "вверх", down: "вниз" } as const;
      return [{ tool: "camera_move", input: { direction: dir, steps: far ? 4 : 2 }, say: `Камера повернулась ${names[dir]}` }];
    }
    return null;
  }

  // --- TV: apps ---
  if (has(t, /(открой|запусти|включи|поставь|давай)/)) {
    const apps: Array<[RegExp, string, string]> = [
      [/(ютуб|youtube|ютьюб)/, "youtube", "YouTube"],
      [/(нетфликс|netflix)/, "netflix", "Netflix"],
      [/(прайм|prime)/, "prime", "Prime Video"],
      [/(дисней|disney)/, "disney", "Disney+"],
      [/(твич|twitch)/, "twitch", "Twitch"],
      [/(призм|prisma)/, "prisma", "Prisma"],
    ];
    for (const [re, id, name] of apps) if (has(t, re)) return [{ tool: "tv_app", input: { app: id }, say: `Открываю ${name}` }];
  }

  // --- TV: sound and remote ---
  const loudness = has(t, /(звук|громкост)/) || has(t, /(громче|погромче|тише|потише)/);
  if (loudness && !has(t, WORDS.light)) {
    if (has(t, /(выключи звук|включи звук|без звука|убери звук|верни звук|mute|мьют|отключи звук)/)) return [{ tool: "tv_key", input: { key: "mute" }, say: "Звук переключён" }];
    const big = has(t, /(намного|сильно|гораздо|значительно)/);
    if (has(t, /(громче|погромче|прибавь|добавь|увеличь|выше)/)) return [{ tool: "tv_key", input: { key: "volumeUp", times: big ? 6 : 3 }, say: "Сделал громче" }];
    if (has(t, /(тише|потише|убавь|уменьши|ниже)/)) return [{ tool: "tv_key", input: { key: "volumeDown", times: big ? 6 : 3 }, say: "Сделал тише" }];
    return null;
  }
  if (has(t, WORDS.tv)) {
    if (has(t, WORDS.off) || has(t, WORDS.on)) return [{ tool: "tv_key", input: { key: "power" }, say: has(t, WORDS.off) ? "Выключаю телевизор" : "Включаю телевизор" }];
    return null;
  }
  const keys: Array<[RegExp, string, string]> = [
    [/^(домой|на главный экран|главный экран)$/, "home", "Домой"],
    [/^(назад|вернись назад)$/, "back", "Назад"],
    [/^(ок|окей|выбери|подтверди)$/, "ok", "Готово"],
    [/^(пауза|поставь на паузу|продолжи|продолжи видео|играй)$/, "playPause", "Готово"],
  ];
  for (const [re, key, say] of keys) if (has(t, re)) return [{ tool: "tv_key", input: { key }, say }];

  return null;
}

/** The whole phrase (several commands may be joined by "и", a comma or "потом") to steps, or null if any part is unknown. */
export function planQuick(text: string): Step[] | null {
  // "сухая и мокрая" is one mode, not two commands
  const joined = text.replace(/(сух\S*\s+и\s+(мокр|влажн)\S*|(мокр|влажн)\S*\s+и\s+сух\S*)/g, "смешанная");
  const parts = joined.split(/\s+и\s+|\s*,\s*|\s+потом\s+|\s+затем\s+|\s+а потом\s+/).filter((p) => p.trim());
  if (parts.length === 0 || parts.length > 4) return null;
  const steps: Step[] = [];
  for (const part of parts) {
    const one = planOne(part);
    if (!one) return null;
    steps.push(...one);
  }
  return steps;
}

/** The answer to a question the assistant just asked ("турбо" after «какую мощность»). Null when the last thing said was not one. */
export function planFollowUp(phrase: string, lastAssistant: string | undefined): Step[] | null {
  if (lastAssistant === ASK_SUCTION) {
    const level = suctionLevel(phrase, false);
    return level ? [{ tool: "vacuum_suction", input: { level }, say: "Поменял мощность пылесоса" }] : null;
  }
  if (lastAssistant === ASK_MODE) {
    const mode = cleaningMode(phrase);
    return mode ? [{ tool: "vacuum_mode", input: { mode }, say: { both: "Включил двойную уборку", mopping: "Включил мытьё", sweeping: "Включил сухую уборку" }[mode] }] : null;
  }
  if (lastAssistant === ASK_HOME) {
    // «Хайфа», «в Хайфе», «я живу в городе Хайфа».
    const name = phrase.replace(/^(я )?(живу )?(в|во|на) /, "").replace(/^(городе|город|селе|посёлке) /, "").trim();
    return name ? [{ tool: "home_place", input: { name }, say: "Запомнил, где вы живёте" }, { tool: "weather", input: {}, say: "" }] : null;
  }
  const asked = /^Куда повернуть камеру на (\d+)°/.exec(lastAssistant ?? "");
  if (asked) {
    const side = has(phrase, /((?<![а-яё])лев|влево|налево)/) ? "left" : has(phrase, /((?<![а-яё])прав|вправо|направо)/) ? "right" : null;
    return side ? [{ tool: "camera_turn", input: { direction: side, degrees: Number(asked[1]) }, say: `Камера повернулась ${side === "left" ? "налево" : "направо"} примерно на ${asked[1]}°` }] : null;
  }
  if (lastAssistant === ASK_WATER) {
    const level = waterLevel(phrase, true);
    return level ? [{ tool: "vacuum_water", input: { level }, say: "Поменял количество воды" }] : null;
  }
  return null;
}
