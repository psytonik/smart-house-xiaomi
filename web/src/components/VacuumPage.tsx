import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, fetchVacuumMap, getVacuumCare, getVacuumHistory, refreshVacuumMap, type CleaningMode, type CleaningRecord, type SuctionLevel, type WaterLevel, type PartWear, type VacuumCare } from "../api";
import { Shell } from "./Shell";
import { useLivePosition } from "../useLivePosition";
import { useVacuum } from "../useVacuum";
import { CLEANING_MODE_LABEL, MODE_LABEL, SUCTION_LABEL, WATER_LABEL, mainAction } from "./vacuumText";

const RADIUS = 100;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A page of its own for the robot vacuum, reached at /vacuum. */
export function VacuumPage({ onLogout }: { onLogout: () => void }) {
  const [toast, setToast] = useState("");
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(""), 4000);
  }, []);
  const fail = useCallback((e: unknown) => say(e instanceof Error ? e.message : "Something went wrong"), [say]);

  const { state, busy, act, setMode, setLevel, reload } = useVacuum(onLogout, fail);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  useEffect(() => {
    const prev = document.title;
    document.title = "Vacuum";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <Shell current="vacuum" onLogout={onLogout}>
      <main className="vpage-main">
        <h1 className="page-title" ref={heading} tabIndex={-1}>
          Vacuum
        </h1>
        {!state && <p className="hint">Connecting to the vacuum…</p>}

        {state && !state.configured && (
          <p className="hint">
            No vacuum is set up. Add VACUUM_IP and VACUUM_TOKEN to backend/.env and restart the server.
          </p>
        )}

        {state && state.configured && !state.reachable && (
          <section className="vpage-offline">
            <p className="hint">The vacuum isn't answering. It may be asleep: wake it with a button on the robot, and check that it's on the same Wi-Fi.</p>
            <button type="button" onClick={reload}>
              Try again
            </button>
          </section>
        )}

        {state?.reachable && <Dashboard state={state} busy={busy} act={act} setMode={setMode} setLevel={setLevel} />}
        {state?.reachable && <Care onAuthError={onLogout} />}
        {state?.reachable && <History onAuthError={onLogout} />}
        {state?.configured && <FloorPlan moving={state.mode === "cleaning" || state.mode === "returning"} onAuthError={onLogout} onError={fail} onNotice={say} />}
      </main>

      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </Shell>
  );
}

function Dashboard({
  state,
  busy,
  act,
  setMode,
  setLevel,
}: {
  state: NonNullable<ReturnType<typeof useVacuum>["state"]>;
  busy: boolean;
  act: ReturnType<typeof useVacuum>["act"];
  setMode: ReturnType<typeof useVacuum>["setMode"];
  setLevel: ReturnType<typeof useVacuum>["setLevel"];
}) {
  const mode = state.mode ?? "unknown";
  const battery = state.battery ?? 0;
  const main = mainAction(mode);
  const moving = mode === "cleaning" || mode === "returning";
  const attention = mode === "error" || battery < 20;
  const docked = mode === "charging" || mode === "charged";

  return (
    <>
      <section className="dial" aria-label="Battery and state">
        <svg viewBox="0 0 240 240" className="dial-ring" aria-hidden="true" focusable="false">
          <circle cx="120" cy="120" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth="14" />
          <circle
            cx="120"
            cy="120"
            r={RADIUS}
            fill="none"
            stroke={attention ? "var(--signal)" : "var(--focus)"}
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * battery) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 120 120)"
          />
        </svg>
        {moving && <span className="dial-orbit" aria-hidden="true" />}
        <div className="dial-core">
          <p className="dial-value">
            <span className="sr-only">Battery </span>
            {battery}
            <span aria-hidden="true">%</span>
            <span className="sr-only"> percent</span>
          </p>
          <p className="dial-state" role="status">
            {MODE_LABEL[mode]}
          </p>
        </div>
      </section>

      <div className="vpage-actions">
        <button type="button" className="primary" onClick={() => void act(main.action)} disabled={busy || mode === "error"}>
          {main.label}
        </button>
        <button type="button" onClick={() => void act("dock")} disabled={busy || docked}>
          Go home
        </button>
        <button type="button" className="vpage-find" onClick={() => void act("find")} disabled={busy}>
          Find the robot
        </button>
      </div>

      {state.cleaningMode && (
        <div className="vpage-modes" role="radiogroup" aria-label="Cleaning mode">
          {(Object.keys(CLEANING_MODE_LABEL) as CleaningMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={state.cleaningMode === m}
              disabled={busy || moving}
              onClick={() => state.cleaningMode !== m && void setMode(m)}
            >
              {CLEANING_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {state.cleaningMode && moving && <p className="hint">The mode can be changed when the robot isn't cleaning.</p>}

      {state.suction && (
        <div className="vpage-levels">
          <p className="vpage-label" id="suction-label">
            Suction
          </p>
          <div className="vpage-modes vpage-suction" role="radiogroup" aria-labelledby="suction-label">
          {(Object.keys(SUCTION_LABEL) as SuctionLevel[]).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={state.suction === l} disabled={busy} onClick={() => state.suction !== l && void setLevel("suction", l)}>
              {SUCTION_LABEL[l]}
            </button>
          ))}
          </div>
        </div>
      )}
      {state.water && (
        <div className="vpage-levels">
          <p className="vpage-label" id="water-label">
            Water
          </p>
          <div className="vpage-modes" role="radiogroup" aria-labelledby="water-label">
          {(Object.keys(WATER_LABEL) as WaterLevel[]).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={state.water === l} disabled={busy} onClick={() => state.water !== l && void setLevel("water", l)}>
              {WATER_LABEL[l]}
            </button>
          ))}
          </div>
        </div>
      )}
      {(state.suction || state.water) && <p className="hint">The robot resets suction and water to the maximum at every start, so your choice is put back a few seconds after it begins.</p>}

      <dl className="vpage-facts">
        {state.areaM2 !== undefined && state.minutes !== undefined && (
          <div>
            <dt>{moving ? "This cleaning" : "Last cleaning"}</dt>
            <dd>
              {state.areaM2} m² in {state.minutes} min
            </dd>
          </div>
        )}
        <div>
          <dt>Model</dt>
          <dd>{state.model ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Firmware</dt>
          <dd>{state.firmware || "unknown"}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>Local network, no cloud</dd>
        </div>
      </dl>
    </>
  );
}

/** Wear below this many percent is flagged: time to order a new part. */
const WORN_PERCENT = 20;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function WearRow({ name, wear }: { name: string; wear: PartWear }) {
  if (wear.percent === undefined) return null;
  const worn = wear.percent < WORN_PERCENT;
  return (
    <li className={worn ? "care-part care-worn" : "care-part"}>
      <div className="care-line">
        <span id={`care-${name}`}>{name}</span>
        <span>
          {wear.percent}% left{wear.hoursLeft !== undefined ? `, about ${wear.hoursLeft} h` : ""}
          {worn ? ", replace soon" : ""}
        </span>
      </div>
      <meter min={0} max={100} low={WORN_PERCENT} optimum={100} value={wear.percent} aria-labelledby={`care-${name}`}>
        {wear.percent}%
      </meter>
    </li>
  );
}

/** Brush and filter wear, and what the robot has cleaned in total. Quietly absent when the robot doesn't answer. */
function Care({ onAuthError }: { onAuthError: () => void }) {
  const [care, setCare] = useState<VacuumCare | null>(null);
  useEffect(() => {
    let alive = true;
    getVacuumCare()
      .then((c) => alive && setCare(c))
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
    return () => {
      alive = false;
    };
  }, [onAuthError]);
  if (!care) return null;
  const t = care.totals;
  return (
    <section className="vpage-care" aria-labelledby="care-title">
      <h2 id="care-title">Care</h2>
      <ul className="care-list">
        <WearRow name="Main brush" wear={care.mainBrush} />
        <WearRow name="Side brush" wear={care.sideBrush} />
        <WearRow name="Filter" wear={care.filter} />
      </ul>
      <dl className="vpage-facts">
        {t.cleanings !== undefined && (
          <div>
            <dt>Cleanings</dt>
            <dd>{t.cleanings}</dd>
          </div>
        )}
        {t.areaM2 !== undefined && (
          <div>
            <dt>Area cleaned</dt>
            <dd>{t.areaM2} m²</dd>
          </div>
        )}
        {t.minutes !== undefined && (
          <div>
            <dt>Time cleaning</dt>
            <dd>{formatDuration(t.minutes)}</dd>
          </div>
        )}
        {t.firstCleanAt && (
          <div>
            <dt>First cleaning</dt>
            <dd>{new Date(t.firstCleanAt).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** The last cleanings the Xiaomi cloud remembers. Quietly absent when the cloud has none or can't be reached. */
function History({ onAuthError }: { onAuthError: () => void }) {
  const [list, setList] = useState<CleaningRecord[]>([]);
  useEffect(() => {
    let alive = true;
    getVacuumHistory()
      .then((l) => alive && setList(l))
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
    return () => {
      alive = false;
    };
  }, [onAuthError]);
  if (!list.length) return null;
  return (
    <section className="vpage-care" aria-labelledby="history-title">
      <h2 id="history-title">Recent cleanings</h2>
      <ul className="history-list">
        {list.map((c) => (
          <li key={c.startedAt}>
            <time dateTime={c.startedAt}>{new Date(c.startedAt).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            <span>
              {c.areaM2} m² in {formatDuration(c.minutes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How often the plan is redrawn while the robot works: the cloud map grows as it cleans. */
const PLAN_REFRESH_MS = 30_000;

/**
 * The apartment as the robot's lidar drew it, with the wall edges, furniture and the way it drove. It redraws itself when
 * the page opens, every half minute while the robot works, and once more when it stops; the button is for doing it by hand.
 */
export function FloorPlan({ moving, onAuthError, onError, onNotice }: { moving: boolean; onAuthError: () => void; onError: (e: unknown) => void; onNotice: (text: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const live = useLivePosition(moving && url !== null, onAuthError);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const current = useRef<string | null>(null);
  const alive = useRef(true);
  const running = useRef(false);
  const wasMoving = useRef(moving);
  const again = useRef(false); // the robot stopped while a redraw was running: do one more when it ends
  const latest = useRef<(byHand: boolean) => Promise<void>>(async () => {});

  const show = useCallback((blob: Blob | null) => {
    if (!blob || !alive.current) return;
    const next = URL.createObjectURL(blob);
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  }, []);

  /** Redraws the plan from the robot's map. `byHand` is the button: it says what it does and what went wrong; the automatic kind stays quiet. */
  const refresh = useCallback(
    async (byHand: boolean) => {
      if (running.current) return; // one at a time: the button stays focusable while it works, so a second press lands here
      running.current = true;
      setBusy(true);
      if (byHand) onNotice("Updating the map…");
      try {
        await refreshVacuumMap();
        show(await fetchVacuumMap(true));
        if (alive.current) setProblem("");
        if (byHand) onNotice("Floor plan updated");
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else if (byHand) onError(e);
        else if (alive.current) setProblem(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        running.current = false;
        if (alive.current) setBusy(false);
        if (again.current && alive.current) {
          again.current = false;
          void latest.current(false);
        }
      }
    },
    [onAuthError, onError, onNotice, show],
  );
  latest.current = refresh;

  // open: show what is saved at once, then redraw it from the robot's current map
  useEffect(() => {
    alive.current = true;
    fetchVacuumMap()
      .then(show)
      .catch((e) => e instanceof AuthError && onAuthError())
      .finally(() => alive.current && void refresh(false));
    return () => {
      alive.current = false;
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = null;
    };
    // refresh is rebuilt when a callback of the page changes; opening must not redraw again for that
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // while the robot works: every half minute (not while the tab is hidden); when it stops: once more for the last stretch
  useEffect(() => {
    if (moving) {
      const timer = setInterval(() => !document.hidden && void refresh(false), PLAN_REFRESH_MS);
      wasMoving.current = true;
      return () => clearInterval(timer);
    }
    if (wasMoving.current) {
      if (running.current) again.current = true;
      else void refresh(false);
    }
    wasMoving.current = false;
  }, [moving, refresh]);

  const caption = url
    ? moving
      ? "It redraws itself every half minute while the robot cleans."
      : "It redraws itself when you open this page."
    : busy
      ? "Drawing the floor plan from the robot's own map…"
      : "No floor plan yet. Load it from the robot's own map.";

  return (
    <div className="plan-box">
      <figure className="plan">
        {url && (
          <div className="plan-stage">
            <img src={url} alt="Floor plan of the apartment" />
            {live?.live && (
              <svg className="plan-live" viewBox={`0 0 ${live.map.width} ${live.map.height}`} preserveAspectRatio="none" aria-hidden="true">
                {live.trail.length > 1 && <polyline className="plan-trail" points={live.trail.map((p) => `${p.x + 0.5},${p.y + 0.5}`).join(" ")} />}
                {live.robot && <circle className="plan-robot" cx={live.robot.x + 0.5} cy={live.robot.y + 0.5} r="2.5" />}
              </svg>
            )}
          </div>
        )}
        {live?.live && <p className="sr-only">The robot is moving. Its position and trail are drawn on the floor plan.</p>}
        <figcaption>{caption}</figcaption>
        {/* always in the page, so a screen reader announces the text when it appears */}
        <p className="plan-problem" role="status">
          {problem && `Couldn't update the map by itself: ${problem}`}
        </p>
      </figure>
      <button type="button" aria-disabled={busy} onClick={() => void refresh(true)}>
        {url ? "Update the map" : "Load the map"}
      </button>
    </div>
  );
}
