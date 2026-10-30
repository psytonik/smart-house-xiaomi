import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, getLight, setLight, type LightPatch, type LightState } from "../api";

interface Props {
  onAuthError: () => void;
  onError: (e: unknown) => void;
}

/** Light strip controls. Renders nothing when the backend has no lamp configured. */
export function Light({ onAuthError, onError }: Props) {
  const [state, setState] = useState<LightState | null>(null);
  const timer = useRef<number>(0);
  const pending = useRef<LightPatch>({});
  const dragging = useRef(false);

  const load = useCallback(() => {
    if (dragging.current) return;
    getLight()
      .then(setState)
      .catch((e) => (e instanceof AuthError ? onAuthError() : setState({ configured: true, reachable: false })));
  }, [onAuthError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => {
      clearInterval(t);
      window.clearTimeout(timer.current);
    };
  }, [load]);

  const send = useCallback(
    (patch: LightPatch, delay: number) => {
      setState((s) => (s ? { ...s, ...patch } : s)); // show the change at once
      pending.current = { ...pending.current, ...patch };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const body = pending.current;
        pending.current = {};
        setLight(body)
          .then(setState)
          .catch((e) => {
            if (e instanceof AuthError) onAuthError();
            else onError(e);
            load();
          });
      }, delay);
    },
    [onAuthError, onError, load],
  );

  if (!state || !state.configured) return null;

  if (!state.reachable) {
    return (
      <section className="light" aria-label="Light strip">
        <h2>Light strip</h2>
        <p className="hint">The lamp isn't answering. Check that it's powered and on the same Wi-Fi.</p>
      </section>
    );
  }

  const hue = state.hue ?? 0;
  const sat = state.saturation ?? 100;
  const swatch = `hsl(${hue} ${Math.max(sat, 25)}% 55%)`;

  const slider = (id: string, label: string, value: number, max: number, key: keyof LightPatch, cls = "") => (
    <label className="slider" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className={cls}
        type="range"
        min={0}
        max={max}
        value={value}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onChange={(e) => send({ [key]: Number(e.target.value) } as LightPatch, 200)}
      />
    </label>
  );

  return (
    <section className="light" aria-label="Light strip">
      <div className="light-head">
        <h2>Light strip</h2>
        <button
          type="button"
          className="power"
          aria-pressed={!!state.on}
          onClick={() => send({ on: !state.on }, 0)}
          style={state.on ? { background: swatch, color: "#11151b" } : undefined}
        >
          {state.on ? "On" : "Off"}
        </button>
      </div>
      {slider("light-bright", "Brightness", state.brightness ?? 0, 100, "brightness")}
      {slider("light-hue", "Colour", hue, 360, "hue", "hue")}
      {slider("light-sat", "Saturation", sat, 100, "saturation")}
    </section>
  );
}
