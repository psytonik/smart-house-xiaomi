import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, fetchVacuumMap, getVacuumCare, getVacuumHistory, getVacuumRooms, getVacuumSchedule, type ScheduledTask, getVacuumSettings, cleanVacuumRooms, type VacuumRoom, refreshVacuumMap, resetVacuumPart, sendVacuumSwitch, type VacuumPartName, type VacuumSettings, type VacuumSwitch, type CleaningMode, type CleaningRecord, type SuctionLevel, type WaterLevel, type PartWear, type VacuumCare } from "../api";
import { Shell } from "./Shell";
import { useLivePosition } from "../useLivePosition";
import { useVacuum } from "../useVacuum";
import { CLEANING_MODE_LABEL, MODE_LABEL, SUCTION_LABEL, TASK_LABEL, WATER_LABEL, mainAction, repeatsText } from "./vacuumText";

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

        <div className="vgrid">
          {state?.reachable && (
            <div className="vcol">
              <Hero state={state} busy={busy} act={act} />
              <Settings state={state} busy={busy} setMode={setMode} setLevel={setLevel} />
            </div>
          )}
          <div className="vcol">
            {state?.configured && (
              <section className="vcard" aria-labelledby="plan-title">
                <h2 id="plan-title">Floor plan</h2>
                <FloorPlan moving={state.mode === "cleaning" || state.mode === "returning"} onAuthError={onLogout} onError={fail} onNotice={say} />
              </section>
            )}
            {state?.reachable && <Rooms busy={state.mode === "cleaning" || state.mode === "returning" || state.mode === "error"} onAuthError={onLogout} onError={fail} onNotice={say} onStarted={reload} />}
            {state?.reachable && <Care onAuthError={onLogout} onError={fail} />}
            {state?.reachable && <History onAuthError={onLogout} />}
            {state?.reachable && <Schedule onAuthError={onLogout} />}
            {state?.reachable && <RobotSettings onAuthError={onLogout} onError={fail} />}
            {state?.reachable && <About state={state} />}
          </div>
        </div>
      </main>

      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </Shell>
  );
}

type VacuumState = NonNullable<ReturnType<typeof useVacuum>["state"]>;

/** The robot at a glance: battery ring, state, what it did last, and the three things you do with it. */
function Hero({ state, busy, act }: { state: VacuumState; busy: boolean; act: ReturnType<typeof useVacuum>["act"] }) {
  const mode = state.mode ?? "unknown";
  const battery = state.battery ?? 0;
  const main = mainAction(mode);
  const moving = mode === "cleaning" || mode === "returning";
  const attention = mode === "error" || battery < 20;
  const docked = mode === "charging" || mode === "charged" || mode === "emptying";
  const stoppable = mode === "cleaning" || mode === "paused" || mode === "returning";
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!stoppable) setStopping(false); // it stopped by itself: nothing left to confirm
  }, [stoppable]);

  return (
    <section className="vcard vhero" aria-label="Battery and state">
      <div className="dial">
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
          <p className={attention ? "dial-state dial-attention" : "dial-state"} role="status">
            {MODE_LABEL[mode]}
          </p>
        </div>
      </div>

      {state.task && <p className="vhero-task">{TASK_LABEL[state.task]}</p>}

      {state.fault && (
        <div className="vfault" role="alert">
          <p className="vfault-title">{state.fault.title}</p>
          <p>{state.fault.hint}</p>
        </div>
      )}

      {state.areaM2 !== undefined && state.minutes !== undefined && (
        <dl className="vhero-last">
          <dt>{moving ? "This cleaning" : "Last cleaning"}</dt>
          <dd>
            {state.areaM2} m² in {state.minutes} min
          </dd>
        </dl>
      )}

      <div className={stoppable ? "vpage-actions vpage-actions-running" : "vpage-actions"}>
        <button type="button" className="primary" onClick={() => void act(main.action)} disabled={busy || mode === "error"}>
          {main.label}
        </button>
        {stoppable && !stopping && (
          <button type="button" className="vpage-stop" onClick={() => setStopping(true)} disabled={busy}>
            Stop
          </button>
        )}
        {stoppable && stopping && (
          <div className="vpage-stop-ask" role="group" aria-label="Stop the cleaning">
            <span>End this cleaning? Pause lets you go on later; stop doesn't.</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStopping(false);
                void act("stop");
              }}
            >
              Yes, stop
            </button>
            <button type="button" onClick={() => setStopping(false)}>
              Keep going
            </button>
          </div>
        )}
        <button type="button" onClick={() => void act("dock")} disabled={busy || docked}>
          Go home
        </button>
        <button type="button" className="vpage-find" onClick={() => void act("find")} disabled={busy}>
          Find the robot
        </button>
        {state.dustStation && (
          <button type="button" className="vpage-empty" onClick={() => void act("empty")} disabled={busy || !state.dustStation.ready || state.dustStation.emptying} aria-describedby="empty-hint">
            {state.dustStation.emptying ? "Emptying the bin…" : "Empty the bin"}
          </button>
        )}
      </div>
      {state.dustStation && (
        <p className="hint vhero-hint" id="empty-hint">
          {state.dustStation.limited ? "The dock won't empty the bin again so soon. Try a little later." : docked || state.dustStation.ready ? (state.dustStation.autoEmpty ? "The dock also empties the bin by itself after a cleaning." : "The dock empties the bin only when you ask.") : "The bin can be emptied when the robot is on its dock."}
        </p>
      )}
    </section>
  );
}

/** One labelled row of choices (a segmented control). */
function Choice<T extends string>({ id, label, labels, value, disabled, onPick, className }: { id: string; label: string; labels: Record<T, string>; value: T; disabled: boolean; onPick: (v: T) => void; className?: string }) {
  return (
    <div className="vpage-levels">
      <p className="vpage-label" id={id}>
        {label}
      </p>
      <div className={className ? `vpage-modes ${className}` : "vpage-modes"} role="radiogroup" aria-labelledby={id}>
        {(Object.keys(labels) as T[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={value === k} disabled={disabled} onClick={() => value !== k && onPick(k)}>
            {labels[k]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Mode, suction and water in one card, each as a labelled row. */
function Settings({ state, busy, setMode, setLevel }: { state: VacuumState; busy: boolean; setMode: ReturnType<typeof useVacuum>["setMode"]; setLevel: ReturnType<typeof useVacuum>["setLevel"] }) {
  const moving = state.mode === "cleaning" || state.mode === "returning";
  if (!state.cleaningMode && !state.suction && !state.water) return null;
  return (
    <section className="vcard" aria-labelledby="settings-title">
      <h2 id="settings-title">Cleaning settings</h2>
      {state.cleaningMode && <Choice id="mode-label" label="Mode" labels={CLEANING_MODE_LABEL} value={state.cleaningMode} disabled={busy || moving} onPick={(m: CleaningMode) => void setMode(m)} />}
      {state.suction && <Choice id="suction-label" label="Suction" labels={SUCTION_LABEL} value={state.suction} disabled={busy} onPick={(l: SuctionLevel) => void setLevel("suction", l)} className="vpage-suction" />}
      {state.water && <Choice id="water-label" label="Water" labels={WATER_LABEL} value={state.water} disabled={busy} onPick={(l: WaterLevel) => void setLevel("water", l)} />}
      {state.cleaningMode && moving && <p className="hint">The mode can be changed when the robot isn't cleaning.</p>}
      {(state.suction || state.water) && <p className="hint">The robot resets suction and water to the maximum at every start, so your choice is put back a few seconds after it begins.</p>}
    </section>
  );
}

/**
 * Clean some rooms and not the whole home. Shown only when the robot has been taught rooms (in the Dreamehome app); the rooms are
 * cleaned in the order they were picked.
 */
function Rooms({ busy, onAuthError, onError, onNotice, onStarted }: { busy: boolean; onAuthError: () => void; onError: (e: unknown) => void; onNotice: (text: string) => void; onStarted: () => void }) {
  const [rooms, setRooms] = useState<VacuumRoom[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    getVacuumRooms()
      .then((r) => alive && setRooms(r))
      .catch((e) => {
        if (e instanceof AuthError) onAuthError(); // no floor plan yet or no answer: no rooms to show
      });
    return () => {
      alive = false;
    };
  }, [onAuthError]);
  if (rooms.length < 2) return null;

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const start = async () => {
    setStarting(true);
    try {
      await cleanVacuumRooms(picked);
      onNotice(`Cleaning ${picked.length === 1 ? "1 room" : `${picked.length} rooms`}`);
      setPicked([]);
      window.setTimeout(onStarted, 1500);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else onError(e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="vcard" aria-labelledby="rooms-title">
      <h2 id="rooms-title">Rooms</h2>
      <ul className="room-list">
        {rooms.map((r) => {
          const order = picked.indexOf(r.id) + 1;
          return (
            <li key={r.id}>
              <label>
                <input type="checkbox" checked={order > 0} onChange={() => toggle(r.id)} disabled={busy || starting} />
                <span className="room-name">{r.name}</span>
                <span className="room-area">{r.areaM2} m²</span>
                {order > 0 && <span className="room-order" aria-label={`number ${order} in the order`}>{order}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <button type="button" className="primary" disabled={busy || starting || picked.length === 0} onClick={() => void start()}>
        {picked.length === 0 ? "Pick the rooms to clean" : `Clean ${picked.length === 1 ? "1 room" : `${picked.length} rooms`}`}
      </button>
      {busy && <p className="hint">The robot is busy: rooms can be picked when it is idle or on its dock.</p>}
    </section>
  );
}

/** The schedule kept on the robot. Absent when it has none (or doesn't answer): it is set in the Dreamehome app. */
function Schedule({ onAuthError }: { onAuthError: () => void }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  useEffect(() => {
    let alive = true;
    getVacuumSchedule()
      .then((t) => alive && setTasks(t))
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
    return () => {
      alive = false;
    };
  }, [onAuthError]);
  if (!tasks.length) return null;
  return (
    <section className="vcard" aria-labelledby="schedule-title">
      <h2 id="schedule-title">Schedule</h2>
      <ul className="history-list">
        {tasks.map((t) => (
          <li key={t.id} className={t.enabled ? undefined : "schedule-off"}>
            <time>{t.time}</time>
            <span>
              {repeatsText(t.days, t.once)}
              {t.enabled ? "" : ", off"}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">Change the schedule in the Dreamehome app.</p>
    </section>
  );
}

const SWITCHES: Array<{ name: VacuumSwitch; label: string; hint: string }> = [
  { name: "resumeCleaning", label: "Resume after charging", hint: "If the battery runs low mid-cleaning, it charges and goes on." },
  { name: "carpetBoost", label: "Carpet boost", hint: "Suction goes up on carpets." },
  { name: "obstacleAvoidance", label: "Obstacle avoidance", hint: "The robot steers around things on the floor." },
  { name: "childLock", label: "Child lock", hint: "The buttons on the robot do nothing." },
  { name: "dnd", label: "Do not disturb", hint: "Quiet hours: no sounds, and the dock doesn't empty the bin." },
];

/** The robot's own on/off settings, and a few it only shows. Quietly absent when the robot doesn't answer. */
function RobotSettings({ onAuthError, onError }: { onAuthError: () => void; onError: (e: unknown) => void }) {
  const [settings, setSettings] = useState<VacuumSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      getVacuumSettings()
        .then(setSettings)
        .catch((e) => {
          if (e instanceof AuthError) onAuthError();
        }),
    [onAuthError],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (!settings) return null;

  const flip = async (name: VacuumSwitch, on: boolean) => {
    setBusy(true);
    try {
      await sendVacuumSwitch(name, on);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else onError(e);
    } finally {
      setBusy(false);
      void load(); // show what the robot really has, also when it refused
    }
  };
  const value = (name: VacuumSwitch) => (name === "dnd" ? settings.dnd?.enabled : settings[name]);

  return (
    <section className="vcard" aria-labelledby="robot-settings-title">
      <h2 id="robot-settings-title">Robot settings</h2>
      <ul className="switch-list">
        {SWITCHES.map(({ name, label, hint }) => {
          const on = value(name);
          if (on === undefined) return null;
          return (
            <li key={name}>
              <div>
                <p id={`switch-${name}`}>{label}</p>
                <p className="switch-hint" id={`switch-${name}-hint`}>
                  {name === "dnd" && settings.dnd?.from && settings.dnd.to ? `${settings.dnd.from} to ${settings.dnd.to}. ${hint}` : hint}
                </p>
              </div>
              <button type="button" role="switch" aria-checked={on} aria-labelledby={`switch-${name}`} aria-describedby={`switch-${name}-hint`} disabled={busy} onClick={() => void flip(name, !on)} className="switch">
                <span className="switch-knob" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <dl className="vpage-facts">
        {settings.customizedCleaning !== undefined && (
          <div>
            <dt>Customized cleaning</dt>
            <dd>{settings.customizedCleaning ? "On, suction and water are kept per room" : "Off"}</dd>
          </div>
        )}
        {settings.carpetSensitivity && (
          <div>
            <dt>Carpet sensitivity</dt>
            <dd>{settings.carpetSensitivity[0]!.toUpperCase() + settings.carpetSensitivity.slice(1)}</dd>
          </div>
        )}
        {settings.volume !== undefined && (
          <div>
            <dt>Volume</dt>
            <dd>{settings.volume}%</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** Technical details nobody needs every day: folded away. */
function About({ state }: { state: VacuumState }) {
  return (
    <details className="vcard vabout">
      <summary>About the robot</summary>
      <dl className="vpage-facts">
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
    </details>
  );
}

/** Wear below this many percent is flagged: time to order a new part. */
const WORN_PERCENT = 20;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function WearRow({ name, wear, onReset, done = "Replaced", question = "Start counting {name} from 100% again?", yes = "Yes, it's new" }: { name: string; wear: PartWear; onReset: () => Promise<void>; done?: string; question?: string; yes?: string }) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
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
        {wear.percent < 100 && !asking && (
          <button type="button" className="care-replaced" onClick={() => setAsking(true)} aria-label={`${name} ${done.toLowerCase()}`}>
            {done}
          </button>
        )}
      </div>
      <meter min={0} max={100} low={WORN_PERCENT} optimum={100} value={wear.percent} aria-labelledby={`care-${name}`}>
        {wear.percent}%
      </meter>
      {wear.percent < 100 &&
        asking && (
          <div className="care-ask" role="group" aria-label={`Reset ${name}`}>
            <span>{question.replace("{name}", name.toLowerCase())}</span>
            <button
              type="button"
              disabled={working}
              onClick={() => {
                setWorking(true);
                void onReset().finally(() => {
                  setWorking(false);
                  setAsking(false);
                });
              }}
            >
              {yes}
            </button>
            <button type="button" disabled={working} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        )}
    </li>
  );
}

/** Brush and filter wear, and what the robot has cleaned in total. Quietly absent when the robot doesn't answer. */
function Care({ onAuthError, onError }: { onAuthError: () => void; onError: (e: unknown) => void }) {
  const [care, setCare] = useState<VacuumCare | null>(null);
  const load = useCallback(
    () =>
      getVacuumCare()
        .then(setCare)
        .catch((e) => {
          if (e instanceof AuthError) onAuthError();
        }),
    [onAuthError],
  );
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
  const reset = (part: VacuumPartName) => async () => {
    try {
      await resetVacuumPart(part);
      await load();
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else onError(e);
    }
  };
  if (!care) return null;
  const t = care.totals;
  return (
    <section className="vcard vpage-care" aria-labelledby="care-title">
      <h2 id="care-title">Care</h2>
      <ul className="care-list">
        <WearRow name="Main brush" wear={care.mainBrush} onReset={reset("mainBrush")} />
        <WearRow name="Side brush" wear={care.sideBrush} onReset={reset("sideBrush")} />
        <WearRow name="Filter" wear={care.filter} onReset={reset("filter")} />
        {care.sensor && <WearRow name="Sensors" wear={care.sensor} onReset={reset("sensor")} done="Cleaned" question="You wiped the sensors: start counting from 100% again?" yes="Yes, wiped" />}
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

/** How many cleanings the history shows before "Show all". */
const HISTORY_SHOWN = 5;

/** The last cleanings the Xiaomi cloud remembers. Quietly absent when the cloud has none or can't be reached. */
function History({ onAuthError }: { onAuthError: () => void }) {
  const [list, setList] = useState<CleaningRecord[]>([]);
  const [all, setAll] = useState(false);
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
    <section className="vcard vpage-care" aria-labelledby="history-title">
      <h2 id="history-title">Recent cleanings</h2>
      <ul className="history-list">
        {(all ? list : list.slice(0, HISTORY_SHOWN)).map((c) => (
          <li key={c.startedAt}>
            <time dateTime={c.startedAt}>{new Date(c.startedAt).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            <span>
              {c.areaM2} m² in {formatDuration(c.minutes)}
            </span>
          </li>
        ))}
      </ul>
      {list.length > HISTORY_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
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
