/** Spells numbers out in Russian words: the cloned voice skips digits, so "16 градусов" is sent as "шестнадцать градусов". */

const ONES_M = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
/** Words after which "один/два" are feminine ("одна минута", "две секунды"). */
const FEMININE = /^(минут|секунд|недел|камер|комнат|лампочк|штук|единиц|точк|розетк|кварт|част|тысяч)/i;

type Gender = "m" | "f";

function below1000(n: number, g: Gender): string[] {
  const out: string[] = [];
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)]!);
  const r = n % 100;
  if (r >= 20) {
    out.push(TENS[Math.floor(r / 10)]!);
    if (r % 10) out.push(unit(r % 10, g));
  } else if (r > 0) out.push(unit(r, g));
  return out;
}

function unit(n: number, g: Gender): string {
  if (g === "f" && n === 1) return "одна";
  if (g === "f" && n === 2) return "две";
  return ONES_M[n]!;
}

function plural(n: number, forms: [string, string, string]): string {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return forms[2];
  if (m10 === 1) return forms[0];
  if (m10 >= 2 && m10 <= 4) return forms[1];
  return forms[2];
}

/** A whole number up to 999 999 999 in words. */
export function numberToWords(n: number, g: Gender = "m"): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return String(n);
  if (n === 0) return ONES_M[0]!;
  const words: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor(n / 1000) % 1000;
  const rest = n % 1000;
  if (millions) words.push(...below1000(millions, "m"), plural(millions, ["миллион", "миллиона", "миллионов"]));
  if (thousands) words.push(...below1000(thousands, "f"), plural(thousands, ["тысяча", "тысячи", "тысяч"]));
  if (rest) words.push(...below1000(rest, g));
  return words.join(" ");
}

/** Replaces every number in the text with words ("-3" → "минус три", "1,5" → "один и пять десятых", "22:30" → "двадцать два тридцать"). */
export function spellNumbers(text: string): string {
  return text
    .replace(/(\d{1,2}):(\d{2})(?!\d)/g, (_, h: string, m: string) => `${numberToWords(+h)} ${m === "00" ? "ровно" : m.startsWith("0") ? `ноль ${numberToWords(+m, "f")}` : numberToWords(+m, "f")}`)
    .replace(/(?<![\p{L}\d])(-|−)?(\d+)(?:[.,](\d{1,2}))?(%?)(?=$|[^\d])(\s*)(\p{L}*)/gu, (all, minus: string | undefined, whole: string, frac: string | undefined, pct: string, space: string, next: string) => {
      const g: Gender = FEMININE.test(next) ? "f" : "m";
      const sign = minus ? "минус " : "";
      let words: string;
      if (frac) {
        const f = Number(frac);
        const denom = frac.length === 1 ? ["десятая", "десятых", "десятых"] : ["сотая", "сотых", "сотых"];
        words = `${numberToWords(+whole, "f")} ${+whole === 1 ? "целая" : "целых"} ${numberToWords(f, "f")} ${plural(f, denom as [string, string, string])}`;
        if (+whole % 10 !== 1 || +whole % 100 === 11) words = words.replace(/ целая /, " целых ");
      } else {
        words = numberToWords(+whole, g);
        if (g === "f" && /у$/i.test(next) && words.endsWith("одна")) words = `${words.slice(0, -4)}одну`; // "одну минуту"
      }
      return `${sign}${words}${pct ? ` ${plural(+whole, ["процент", "процента", "процентов"])}` : ""}${space}${next}`;
    });
}
