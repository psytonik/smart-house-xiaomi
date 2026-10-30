/** "20261030T125003123Z.jpg" -> Date (names are UTC). */
export function snapshotDate(name: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.jpg$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h, mi, s, ms));
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function snapshotTime(name: string): string {
  const d = snapshotDate(name);
  return d ? timeFmt.format(d) : name;
}

export function snapshotDay(name: string): string {
  const d = snapshotDate(name);
  return d ? dayFmt.format(d) : "";
}

const dateTime = (iso: string) => new Date(iso);

export function clipTime(iso: string): string {
  return timeFmt.format(dateTime(iso));
}

export function clipDay(iso: string): string {
  return dayFmt.format(dateTime(iso));
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")} min`;
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
