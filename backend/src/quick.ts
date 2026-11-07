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

const NUMBER_WORDS: Record<string, number> = {
  один: 1, одна: 1, первый: 1, два: 2, второй: 2, три: 3, третий: 3, четыре: 4, четвертый: 4, четвёртый: 4, пять: 5, пятый: 5, шесть: 6, шестой: 6, семь: 7, седьмой: 7,
  восемь: 8, восьмой: 8, девять: 9, девятый: 9, десять: 10, десятый: 10, одиннадцать: 11, одиннадцатый: 11, двенадцать: 12, двенадцатый: 12, тринадцать: 13,
  тринадцатый: 13, четырнадцать: 14, четырнадцатый: 14, пятнадцать: 15, пятнадцатый: 15, шестнадцать: 16, шестнадцатый: 16, семнадцать: 17, семнадцатый: 17,
  восемнадцать: 18, восемнадцатый: 18, девятнадцать: 19, девятнадцатый: 19, двадцать: 20, двадцатый: 20,
};
const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");

/** The channel number of a phrase: «канал 15», «канал пятнадцать», «девятый канал». Undefined when none is named. */
function channelNumber(t: string): number | undefined {
  const digits = /(?<![а-яё])(?:канал|телеканал)\s+(?:номер\s+)?(\d{1,4})(?!\d)/.exec(t)?.[1];
  if (digits) return Number(digits);
  const word = new RegExp(`(?<![а-яё])(?:(?:канал|телеканал)\\s+(?:номер\\s+)?(${NUMBER_WORD})|(${NUMBER_WORD})\\s+(?:канал|телеканал))(?![а-яё])`).exec(t);
  const said = word?.[1] ?? word?.[2];
  return said ? NUMBER_WORDS[said] : undefined;
}

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

  // --- TV: a category of Prisma's IPTV page («Спорт», «Кино»…), and a channel by its number inside it ---
  // The list on the left of the IPTV page: «Все каналы» first, then these. From the playlist (where the focus starts) «down» ×(position+1)
  // reaches a category, OK selects it and moves the focus to its first channel; inside a category the grid is numbered 1, 2, 3 … again,
  // the player takes the channel number typed with the digits.
  const categories: Array<[RegExp, string]> = [
    [/(?<![а-яё])(общи\S*|общая)/, "Общие"],
    [/(?<![а-яё])новост\S*/, "Новостные"],
    [/(?<![а-яё])(кино|фильмов\S*|киноканал\S*)/, "Кино"],
    [/(?<![а-яё])спорт\S*/, "Спорт"],
    [/(?<![а-яё])музык\S*/, "Музыка"],
    [/(?<![а-яё])детск\S*/, "Детские"],
    [/(?<![а-яё])познават\S*/, "Познавательные"],
    [/(?<![а-яё])развлека\S*/, "Развлекательные"],
    [/(?<![а-яё])(израил\S*|иврит\S*)/, "Израиль"],
  ];
  const ORDER = ["Общие", "Новостные", "Кино", "Спорт", "Музыка", "Детские", "Познавательные", "Развлекательные", "Израиль"];
  const IPTV_WORD = /(?<![а-яё])(канал\S*|телеканал\S*|категори\S*|iptv|айпитиви)/;
  const inCategory = categories.find(([re]) => re.test(t));
  if (inCategory && has(t, IPTV_WORD) && has(t, /(включи|переключи|открой|покажи|давай|запусти)/)) {
    const name = inCategory[1];
    const n = channelNumber(t) ?? 1;
    if (n < 1 || n > 2147) return [{ tool: "ask", input: {}, say: "Не поняла номер канала." }];
    const said = n === 1 ? `Включаю категорию «${name}»` : `Включаю канал ${n} в категории «${name}»`;
    return [
      { tool: "tv_app", input: { app: "prisma", settle: { package: "top.rootu.prisma", warm: 2000, cold: 20000 } }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "up" }, { key: "right", times: 3 }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 15000 }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down", times: ORDER.indexOf(name) + 2 }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 2500 }, say: "" },
      // OK plays the first channel of the category. A category can be a grid of four columns or a list of rows (Новостные is a list), so
      // channel N is not found by walking the grid; the player takes the number typed with the digits (counted inside the category,
      // «009 / 067»), but not while its stream is still loading, hence the long wait. Two digits at least: «09».
      { tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: n === 1 ? said : "" },
      ...(n === 1 ? [] : [{ tool: "wait", input: { ms: 8000 }, say: "" }, { tool: "tv_keys", input: { keys: [...String(n).padStart(2, "0")].map((d) => ({ key: d })) }, say: said }]),
    ];
  }

  // --- TV: a channel of Prisma's IPTV page by its number ---
  // The IPTV tab (up, right ×3, OK) opens with the focus on the playlist; «down», OK selects «Все каналы» and moves the focus to channel 1; OK
  // plays it. The IPTV player takes the number of a channel typed with the digit keys («0-9 Номер канала», read from its own hint line), so
  // any number of the playlist (here 1..2147) is a few key presses. There is no intent for IPTV, and its search needs a keyboard whose focus
  // cannot be predicted, hence the number.
  const channelN = has(t, /(?<![а-яё])(включи|переключи|открой|покажи|давай)/) ? channelNumber(t) : undefined;
  if (channelN !== undefined) {
    const n = channelN;
    if (n < 1 || n > 2147) return [{ tool: "ask", input: {}, say: "В плейлисте каналы с первого по две тысячи сто сорок седьмой." }];
    return [
      { tool: "tv_app", input: { app: "prisma", settle: { package: "top.rootu.prisma", warm: 2000, cold: 20000 } }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "up" }, { key: "right", times: 3 }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 15000 }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down" }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 2500 }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: n === 1 ? "Включаю канал 1" : "" },
      ...(n === 1 ? [] : [{ tool: "wait", input: { ms: 6000 }, say: "" }, { tool: "tv_keys", input: { keys: [...String(n).padStart(2, "0")].map((d) => ({ key: d })) }, say: `Включаю канал ${n}` }]),
    ];
  }

  // --- TV: find and play a movie or a series in Prisma by its name ---
  // Prisma's MainActivity takes the search text in an intent (see TvAdb.prismaSearch), so any text works, no keyboard walking. The text
  // is typed into its search box letter by letter (about 0.9 s each); then «Поиск» is pressed (down ×3, right ×5, OK), which moves the focus
  // into the results, and one «down» lands on the first film (a second one, on the first series: the rows are «Фильмы», «Сериалы»).
  const movie = /(?<![а-яё])(найди|найти|поищи|включи|запусти|открой|покажи|давай)\s+(?:мне\s+)?(?:в призме\s+)?(фильм|кино|сериал)\s+(?:под названием\s+)?(.+?)(?:\s+в призме)?$/.exec(t);
  if (movie) {
    const series = movie[2] === "сериал";
    let rest = movie[3]!;
    // «… 3 сезон 5 серия», «… сезон 2 серия 7», «… 5 серию»: only the season and episode numbers of the phrase, never part of the title
    const seasonNo = /(?:(\d+)\s*сезон\S*|сезон\S*\s*(\d+))/.exec(rest);
    const episodeNo = /(?:(\d+)\s*(?:серия|серию|серии|эпизод\S*)|(?:серия|серию|эпизод)\s*(\d+))/.exec(rest);
    rest = rest.replace(seasonNo?.[0] ?? "", "").replace(episodeNo?.[0] ?? "", "");
    const season = Number(seasonNo?.[1] ?? seasonNo?.[2] ?? 1);
    const episode = Number(episodeNo?.[1] ?? episodeNo?.[2] ?? 1);
    const title = rest.replace(/[«»"'`$;&|\\]/g, "").replace(/\s+/g, " ").trim();
    if (!PRISMA_QUERY.test(title)) return [{ tool: "ask", input: {}, say: "Не поняла название. Назовите его ещё раз." }];
    if (series && (episode < 1 || episode > 24)) return [{ tool: "ask", input: {}, say: "Номер серии от 1 до 24." }];
    const play = /^(включи|запусти)$/.test(movie[1]!);
    const open = play || /^(открой|покажи)$/.test(movie[1]!);
    const kind = series ? "сериал" : "фильм";
    // from the first episode of the source list: across a row of four, then down (the grid has four columns; «left» would open the side menu)
    const toEpisode: Array<{ key: "down" | "right"; times?: number }> = [{ key: "down", times: 3 }];
    if (Math.floor((episode - 1) / 4) > 0) toEpisode.push({ key: "down", times: Math.floor((episode - 1) / 4) });
    if ((episode - 1) % 4 > 0) toEpisode.push({ key: "right", times: (episode - 1) % 4 });
    // Prisma remembers the season last chosen for a series and opens it; picking another one by voice is not supported yet (the layout of the
    // translation row, which the focus passes through, differs from show to show), so the phrase's season is only said aloud, not applied.
    const what = (series && episode > 1 ? `«${title}», серия ${episode}` : `«${title}»`) + (series && season > 1 ? ". Сезон выбирать голосом пока не умею, играет тот, что выбран в Призме" : "");
    return [
      { tool: "tv_app", input: { app: "prisma", settle: { package: "top.rootu.prisma", warm: 2000, cold: 15000 } }, say: "" },
      { tool: "prisma_search", input: { query: title }, say: "" },
      { tool: "wait", input: { ms: 1500 + 900 * title.length }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down", times: 3 }, { key: "right", times: 5 }, { key: "ok" }] }, say: "" },
      { tool: "wait", input: { ms: 3000 }, say: "" },
      { tool: "tv_keys", input: { keys: [{ key: "down", times: series ? 2 : 1 }] }, say: open ? "" : `Нашла ${kind} «${title}» в Призме` },
      ...(open ? [{ tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: play ? "" : `Открываю ${kind} «${title}»` }] : []),
      ...(play
        ? [
            { tool: "wait", input: { ms: 3000 }, say: "" },
            { tool: "tv_keys", input: { keys: [{ key: "ok" }] }, say: "" }, // «Смотреть»
            // a film shows its sources at once; a series first loads its seasons and episodes (about 8 seconds)
            ...(series
              ? [{ tool: "wait", input: { ms: 9000 }, say: "" }, { tool: "tv_keys", input: { keys: [...toEpisode, { key: "ok" as const }], unlessPlayer: true }, say: `Включаю ${what}` }]
              : [{ tool: "wait", input: { ms: 3500 }, say: "" }, { tool: "tv_keys", input: { keys: [{ key: "down" }, { key: "ok" }], unlessPlayer: true }, say: `Включаю ${what}` }]),
          ]
        : []),
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
