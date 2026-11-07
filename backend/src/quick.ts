import { PRISMA_QUERY } from "./tvAdb.js";
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

  // --- TV: find and play a movie in Prisma by its name ---
  // Prisma's MainActivity takes the search text in an intent (see TvAdb.prismaSearch), so any text works, no keyboard walking. The text
  // is typed into its search box letter by letter (about 0.9 s each); then «Поиск» is pressed (down ×3, right ×5, OK), which moves the focus
  // into the results, and one «down» lands on the first film.
  const movie = /(?<![а-яё])(найди|найти|поищи|включи|запусти|открой|покажи|давай)\s+(?:мне\s+)?(?:в призме\s+)?(?:фильм|кино)\s+(?:под названием\s+)?(.+?)(?:\s+в призме)?$/.exec(t);
  if (movie) {
    const title = movie[2]!.replace(/[«»"'`$;&|\\]/g, "").replace(/\s+/g, " ").trim();
    if (!PRISMA_QUERY.test(title)) return [{ tool: "ask", input: {}, say: "Не поняла название фильма. Назовите его ещё раз." }];
    const play = /^(включи|запусти)$/.test(movie[1]!);
    const open = play || /^(открой|покажи)$/.test(movie[1]!);
    return [
      { tool: "tv_app", input: { app: "prisma", settle: { package: "top.rootu.prisma", warm: 2000, cold: 15000 } }, say: "" },
      { tool: "prisma_search", input: { query: title }, say: "" },
      { tool: "wait", input: { ms: 1500 + 900 * title.length }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down", times: 3 }, { key: "right", times: 5 }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 3000 }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down" }] }, say: open ? "" : `Нашла «${title}» в Призме` },
      ...(open ? [{ tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: play ? "" : `Открываю «${title}»` }] : []),
      ...(play ? [{ tool: "wait", input: { ms: 3000 }, say: "" }, { tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: `Включаю «${title}»` }] : []),
    ];
  }

  // --- TV: Prisma's screen and the arrow keys, by voice ---
  // The top bar of Prisma's home screen (checked on the TV): after "up" the focus is on «Главная», and each "right" moves one icon:
  // Фильмы 1, Сериалы 2, IPTV 3, Настройки 4, (filter 5), поиск 6, уведомления 7. Prisma must be open on its home screen.
  if (has(t, /(призм|prisma)/)) {
    const bar: Array<[RegExp, number, string]> = [
      [/(?<![а-яё])поиск/, 6, "поиск"],
      [/(?<![а-яё])(уведомлен|колокол)/, 7, "уведомления"],
      [/(?<![а-яё])фильм/, 1, "фильмы"],
      [/(?<![а-яё])сериал/, 2, "сериалы"],
      [/(?<![а-яё])(iptv|айпитив|ай пи ти ви|телевидение|каналы)/, 3, "IPTV"],
      [/(?<![а-яё])настройк/, 4, "настройки"],
    ];
    for (const [re, rights, name] of bar) {
      if (!has(t, re) || !has(t, /(нажми|открой|зайди|перейди|выбери|покажи|включи|найди)/)) continue;
      return [
        // the keys go to whatever is on the screen: Prisma is opened first and given time to start
        // a cold start of Prisma takes about 15 seconds before it takes keys, an app that is already open about 2
        { tool: "tv_app", input: { app: "prisma", settle: { package: "top.rootu.prisma", warm: 2000, cold: 15000 } }, say: "" },
        { tool: "tv_key", input: { key: "up", adb: true }, say: "" },
        ...(rights > 0 ? [{ tool: "tv_key", input: { key: "right", times: rights, adb: true }, say: "" }] : []),
        { tool: "tv_key", input: { key: "ok", adb: true }, say: `Открываю ${name} в Призме` },
      ] as Step[];
    }
  }
  // Arrow keys with the TV (or an app on it) named: "на телевизоре вниз 3 раза", "в призме вправо"
  if (has(t, /(телевизор|телик|(?<![а-яё])тв(?![а-яё])|призм|prisma|ott|плей)/) && !has(t, WORDS.camera)) {
    const dirs: Array<[RegExp, string, string]> = [
      [/(?<![а-яё])вверх/, "up", "Вверх"],
      [/(?<![а-яё])вниз/, "down", "Вниз"],
      [/(?<![а-яё])(влево|налево)/, "left", "Влево"],
      [/(?<![а-яё])(вправо|направо)/, "right", "Вправо"],
    ];
    const n = Math.min(10, Number(/(\d+)/.exec(t)?.[1] ?? { один: 1, два: 2, три: 3, четыре: 4, пять: 5 }[/(?<![а-яё])(один|два|три|четыре|пять)(?![а-яё])/.exec(t)?.[1] ?? ""] ?? 1) || 1);
    for (const [re, key, say] of dirs) if (has(t, re)) return [{ tool: "tv_key", input: { key, times: n, adb: true }, say }];
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
      [/(?<![a-zа-яё])(ott|tt ?play|отт ?плей|отт ?плеер|тт ?плей|тт ?play|эти ?play|эти ?плей|^(?:включи|открой|запусти|давай)\s+(?:play|плей)$|от ?ти ?ти)/, "ottplay", "OTT Player"],
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
  // "включи HDMI 2", "переключи на хдми два": the ids are fixed (hdmi1, hdmi2, av), see parseSources
  const hdmi = t.match(/(?:hdmi|хдми|эйчдиэмай|аш ?ди ?эм ?ай)\s*(?:№\s*)?([1-4]|один|два|три|четыре)(?![а-яё\d])/);
  if (hdmi) {
    const n = { один: 1, два: 2, три: 3, четыре: 4 }[hdmi[1]!] ?? Number(hdmi[1]);
    return [{ tool: "tv_source", input: { source: `hdmi${n}` }, say: `Переключаю на HDMI ${n}` }];
  }
  // the game console is on HDMI 1 in this house ("плойка подключена к hdmi 1")
  if (has(t, /(плойк|плейстейшн|плэйстейшн|playstation|(?<![а-яё])пс ?[345](?![а-яё\d])|приставк)/) && has(t, /(включи|запусти|переключи|давай|хочу)/)) return [{ tool: "tv_source", input: { source: "hdmi1" }, say: "Переключаю на приставку" }];
  if (has(t, /(?<![a-zа-яё])(av|эй ?ви)(?![a-zа-яё])/) && has(t, /(включи|переключи|источник|вход)/)) return [{ tool: "tv_source", input: { source: "av" }, say: "Переключаю на AV" }];
  // "закрой все приложения на телевизоре": needs the TV's ADB, otherwise the API says so
  if (has(t, /(закр|заверш|останов|выключ)/) && has(t, /(?<![а-яё])приложен/) && has(t, /(все|всё|каждое)/)) return [{ tool: "tv_close_apps", input: {}, say: "Закрыл все приложения на телевизоре" }];
  if (has(t, WORDS.tv)) {
    if (has(t, WORDS.off) || has(t, WORDS.on)) return [{ tool: "tv_key", input: { key: "power" }, say: has(t, WORDS.off) ? "Выключаю телевизор" : "Включаю телевизор" }];
    // "нажми на телевизоре пауза", "на телевизоре домой": a remote key with the TV named
    const named: Array<[RegExp, string, string]> = [
      [/(?<![а-яё])(пауз|приостанов|продолж|играй|воспроизв|плей|плэй|плей-?пауз)|(?<![a-z])(play|pause)(?![a-z])/, "playPause", "Готово"],
      [/(?<![а-яё])(домой|главный экран)/, "home", "Домой"],
      [/(?<![а-яё])назад/, "back", "Назад"],
      [/(?<![а-яё])(ок|окей)(?![а-яё])/, "ok", "Готово"],
    ];
    for (const [re, key, say] of named) if (has(t, re)) return [{ tool: "tv_key", input: { key }, say }];
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
