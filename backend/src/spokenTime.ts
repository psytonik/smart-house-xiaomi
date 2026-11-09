/** «1 час, 2 часа, 5 часов». */
const plural = (n: number, one: string, few: string, many: string) => (n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many);

/** The part of the day people name after the hour: 12-hour clock, then ночи / утра / дня / вечера. */
function partOfDay(hour: number): string {
  if (hour < 4) return "ночи";
  if (hour < 12) return "утра";
  if (hour < 17) return "дня";
  return "вечера";
}

/**
 * The time as people say it: «5 часов вечера 11 минут», not «17 часов 11 минут». Digits stay (the page shows them; the voice spells them out).
 * Night is 0:00-3:59, morning 4:00-11:59, day 12:00-16:59, evening from 17:00. On the hour: «5 часов вечера ровно».
 */
export function spokenTime(d: Date): string {
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const minutes = d.getMinutes();
  const hours = `${h12} ${plural(h12, "час", "часа", "часов")} ${partOfDay(h24)}`;
  return minutes === 0 ? `${hours} ровно` : `${hours} ${minutes} ${plural(minutes, "минута", "минуты", "минут")}`;
}
