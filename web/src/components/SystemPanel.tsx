import { useEffect, useState } from "react";
import { AuthError, getSystem, type SystemCheck, type SystemHealth } from "../api";

const LABEL: Record<SystemCheck["level"], string> = { ok: "OK", info: "Note", warn: "Warning", error: "Problem" };
const RANK: Record<SystemCheck["level"], number> = { error: 0, warn: 1, info: 2, ok: 3 };
const SUMMARY: Record<SystemHealth["level"], string> = {
  ok: "Everything is working",
  warn: "Needs attention",
  error: "There is a problem",
};

function uptime(sec: number): string {
  if (sec < 60) return `up ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `up ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `up ${h} h ${min % 60} min`;
  return `up ${Math.floor(h / 24)} d ${h % 24} h`;
}

export function SystemPanel({ onAuthError }: { onAuthError: () => void }) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let gone = false;
    const refresh = () =>
      getSystem().then(
        (h) => {
          if (gone) return;
          setHealth(h);
          setStale(false);
        },
        (e) => {
          if (gone) return;
          if (e instanceof AuthError) onAuthError();
          else setStale(true);
        },
      );
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!health) return <p className="empty">{stale ? "Couldn't load the system status." : "Checking…"}</p>;

  const checks = [...health.checks].sort((a, b) => RANK[a.level] - RANK[b.level]);
  return (
    <div className="system">
      <p className={`system-summary ${health.level}`} role="status">
        <strong>{SUMMARY[health.level]}</strong>
        <span>{uptime(health.uptimeSec)}</span>
      </p>
      {stale && <p className="hint">Couldn't refresh, showing the last answer.</p>}
      <ul className="system-list">
        {checks.map((c) => (
          <li key={c.id} className={c.level}>
            <span className="badge">{LABEL[c.level]}</span>
            <div>
              <strong>{c.title}</strong>
              <p>{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
