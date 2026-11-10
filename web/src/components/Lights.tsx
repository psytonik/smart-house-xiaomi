import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { AuthError, getLamps, setLamp, type Lamp, type LightPatch } from "../api";

interface Props {
  onAuthError: () => void;
  onError: (e: unknown) => void;
}

/** One line of plain words for a lamp's status, so it never depends on the dot's colour. */
function lampState(l: Lamp): string {
  if (!l.reachable) return l.kind === "bluetooth" ? "Not connected (is the Bluetooth helper running?)" : "Not connected";
  const note = l.stateKnown ? "" : " (last sent)";
  return `Connected\n${l.on ? `On, ${l.brightness ?? 0}%` : "Off"}${note}`;
}

const GROUPS: Array<{ group: Lamp["group"]; title: string }> = [
  { group: "strip", title: "Light strips" },
  { group: "bulb", title: "Bulbs" },
];

/** Strips and bulbs are two sets of controls: a change in one never moves the other. */
export function Lights({ onAuthError, onError }: Props) {
  const [lamps, setLamps] = useState<Lamp[] | null>(null);
  const busy = useRef(0); // >0 while the user is changing something; polling waits

  const load = useCallback(() => {
    if (busy.current > 0) return;
    getLamps()
      .then(setLamps)
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
  }, [onAuthError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (!lamps) return <p className="hint">Looking for lamps…</p>;
  if (lamps.length === 0) return <p className="hint">No lamps are set up.</p>;

  const toggleOne = (l: Lamp) => {
    busy.current += 1;
    setLamps((all) => all && all.map((x) => (x.id === l.id ? { ...x, on: !l.on } : x)));
    setLamp(l.id, { on: !l.on })
      .catch((e) => (e instanceof AuthError ? onAuthError() : onError(e)))
      .finally(() => {
        busy.current = Math.max(0, busy.current - 1);
        load();
      });
  };

  return (
    <>
      {GROUPS.map(({ group, title }) => {
        const inGroup = lamps.filter((l) => l.group === group);
        return inGroup.length === 0 ? null : (
          <LampGroup key={group} title={title} lamps={inGroup} busy={busy} load={load} toggleOne={toggleOne} onAuthError={onAuthError} onError={onError} />
        );
      })}
    </>
  );
}

interface GroupProps extends Props {
  title: string;
  lamps: Lamp[];
  busy: MutableRefObject<number>;
  load: () => void;
  toggleOne: (l: Lamp) => void;
}

/**
 * One set of lamps behind one set of controls: a change goes to every lamp of the group that answers.
 * The picture shown is the first reachable lamp that reports its state.
 */
function LampGroup({ title, lamps, busy, load, toggleOne, onAuthError, onError }: GroupProps) {
  const [view, setView] = useState<LightPatch>({});
  const timer = useRef<number>(0);
  const pending = useRef<LightPatch>({});

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Take the server's picture again whenever it changes, unless the user is mid-change.
  useEffect(() => {
    if (busy.current > 0) return;
    const ref = lamps.find((l) => l.reachable && l.stateKnown) ?? lamps.find((l) => l.reachable);
    if (ref) setView({ on: ref.on, brightness: ref.brightness, hue: ref.hue, saturation: ref.saturation, temperature: ref.temperature });
  }, [lamps, busy]);

  const reachable = lamps.filter((l) => l.reachable);
  const down = lamps.filter((l) => !l.reachable);
  const blind = reachable.some((l) => !l.stateKnown);

  const send = (patch: LightPatch, delay: number) => {
    setView((v) => ({ ...v, ...patch })); // show the change at once
    pending.current = { ...pending.current, ...patch };
    busy.current += 1;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const body = pending.current;
      pending.current = {};
      void Promise.allSettled(reachable.map((l) => setLamp(l.id, body)))
        .then((results) => {
          const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failed) {
            if (failed.reason instanceof AuthError) onAuthError();
            else onError(failed.reason);
          }
        })
        .finally(() => {
          busy.current = 0;
          load();
        });
    }, delay);
  };

  if (reachable.length === 0) {
    return (
      <section className="light" aria-label={title}>
        <h2>{title}</h2>
        <p className="hint">
          No lamp here is answering. Check that they are powered, on the same network, and everything was started with ./camera.sh from Terminal.app
          (close the phone app, it holds the Bluetooth strip).
        </p>
      </section>
    );
  }

  const hue = view.hue ?? 0;
  const sat = view.saturation ?? 100;
  const swatch = `hsl(${hue} ${Math.max(sat, 25)}% 55%)`;

  const hasWarmth = lamps.some((l) => l.group === "bulb" && l.temperature !== undefined);
  const slider = (key: "brightness" | "hue" | "saturation" | "temperature", label: string, value: number, max: number, cls = "", min = 0, step = 1) => (
    <label className="slider" htmlFor={`lamp-all-${key}`}>
      <span>{label}</span>
      <input
        id={`lamp-all-${key}`}
        className={cls}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => send({ [key]: Number(e.target.value) } as LightPatch, 200)}
      />
    </label>
  );

  return (
    <section className="light" aria-label={title}>
      <div className="light-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="power"
          aria-pressed={!!view.on}
          onClick={() => send({ on: !view.on }, 0)}
          style={view.on ? { background: swatch, color: "#11151b" } : undefined}
        >
          {view.on ? "On" : "Off"}
        </button>
      </div>
      <ul className="lamp-status" aria-label={`${title} status`}>
        {lamps.map((l) => (
          <li key={l.id} className={l.reachable ? (l.on ? "on" : "off") : "down"}>
            <span className="dot" aria-hidden="true" />
            <span className="lamp-kind">{l.name}</span>
            <span className="lamp-state">{lampState(l)}</span>
            {l.reachable && (
              <button type="button" className="lamp-toggle" aria-pressed={!!l.on} aria-label={`${l.name}: ${l.on ? "turn off" : "turn on"}`} onClick={() => toggleOne(l)}>
                {l.on ? "On" : "Off"}
              </button>
            )}
            {l.reachable && l.on && <span className="lamp-swatch" style={{ background: `hsl(${l.hue ?? 0} ${Math.max(l.saturation ?? 100, 25)}% 55%)` }} aria-hidden="true" />}
          </li>
        ))}
      </ul>
      {slider("brightness", "Brightness", view.brightness ?? 0, 100)}
      {slider("hue", "Colour", hue, 360, "hue")}
      {slider("saturation", "Saturation", sat, 100)}
      {hasWarmth && slider("temperature", `White warmth ${view.temperature ?? 6500} K (2700 warm, 6500 cool)`, view.temperature ?? 6500, 6500, "", 2700, 100)}
      {down.length > 0 && <p className="hint">Changes go to the lamps that answer.</p>}
      {blind && <p className="hint">A Bluetooth strip can't report its state: it shows what was sent last.</p>}
    </section>
  );
}
