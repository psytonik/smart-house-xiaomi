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

/** One short command (no "and") to the steps it means, or null if it is not one the rules know. */
function planOne(part: string): Step[] | null {
  const t = part.trim();
  if (!t) return null;

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

  // --- vacuum: empty the bin. The microphone hears "очисти бак" as "очись баг", "очисть бэк" and the like, so the sound is matched loosely.
  if (has(t, /(очис|очист|опустош|опорожн|вытряхн|выгрузи|разгрузи)/) && has(t, /(бак|баг|бэк|бег|бук|back|мусор|пыл)/) && !has(t, WORDS.light)) {
    return [{ tool: "vacuum_action", input: { action: "empty" }, say: "Опустошаю бак пылесоса" }];
  }

  // --- vacuum ---
  if (has(t, WORDS.vacuum) || (has(t, /(пропылесос|убери|помой пол|подмети)/) && !has(t, /(звук|громкост)/))) {
    if (has(t, /(найди|где|подай голос|позови)/)) return [{ tool: "vacuum_action", input: { action: "find" }, say: "Пылесос подаёт голос" }];
    if (has(t, /(опустоши|вытряхни|очисти бак|опорожни)/)) return [{ tool: "vacuum_action", input: { action: "empty" }, say: "Опустошаю бак" }];
    if (has(t, /(домой|на базу|на станцию|на зарядку|заряжаться|вернись)/)) return [{ tool: "vacuum_action", input: { action: "dock" }, say: "Пылесос едет на базу" }];
    if (has(t, /(пауза|паузу|приостанов)/)) return [{ tool: "vacuum_action", input: { action: "pause" }, say: "Пауза" }];
    if (has(t, /(останов|прекрати|стоп|хватит|заверши|отмени)/)) return [{ tool: "vacuum_action", input: { action: "stop" }, say: "Уборка остановлена" }];
    if (has(t, /(запусти|включи|начни|начать|поехали|убери|пропылесось|пылесось|поезжай|продолжи|подмети|помой)/)) return [{ tool: "vacuum_clean", input: { text: t }, say: "Пылесос начал уборку" }];
    return null;
  }

  // --- camera ---
  if (has(t, WORDS.camera) || has(t, /(поверни|повернись|крути)/)) {
    const far = has(t, /(сильно|сильнее|намного|до конца|побольше)/);
    const dir = has(t, /(лев|влево|налево)/) ? "left" : has(t, /(прав|вправо|направо)/) ? "right" : has(t, /(вверх|выше|поднимись|наверх)/) ? "up" : has(t, /(вниз|ниже|опустись)/) ? "down" : null;
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
  const parts = text.split(/\s+и\s+|\s*,\s*|\s+потом\s+|\s+затем\s+|\s+а потом\s+/).filter((p) => p.trim());
  if (parts.length === 0 || parts.length > 4) return null;
  const steps: Step[] = [];
  for (const part of parts) {
    const one = planOne(part);
    if (!one) return null;
    steps.push(...one);
  }
  return steps;
}
