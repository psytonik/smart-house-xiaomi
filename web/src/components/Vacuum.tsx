import { useVacuum } from "../useVacuum";
import { MODE_LABEL, mainAction } from "./vacuumText";

interface Props {
  onAuthError: () => void;
  onError: (e: unknown) => void;
}

/** Robot vacuum card in the side rail: state, battery, two buttons. Renders nothing when no vacuum is configured. */
export function Vacuum({ onAuthError, onError }: Props) {
  const { state, busy, act } = useVacuum(onAuthError, onError);

  if (!state || !state.configured) return null;

  if (!state.reachable) {
    return (
      <section className="light" aria-label="Vacuum">
        <h2>Vacuum</h2>
        <p className="hint">The vacuum isn't answering. It may be asleep: wake it with a button on the robot, or check that it's on the same Wi-Fi.</p>
      </section>
    );
  }

  const mode = state.mode ?? "unknown";
  const main = mainAction(mode);

  return (
    <section className="light" aria-label="Vacuum">
      <div className="light-head">
        <h2>Vacuum</h2>
        <span className="vacuum-battery" role="img" aria-label={`Battery ${state.battery}%`}>
          {state.battery}%
        </span>
      </div>
      <p className="vacuum-status" role="status">
        {MODE_LABEL[mode]}
      </p>
      <div className="vacuum-actions">
        <button type="button" onClick={() => void act(main.action)} disabled={busy || mode === "error"}>
          {main.label}
        </button>
        <button type="button" className="quiet" onClick={() => void act("dock")} disabled={busy || mode === "charging" || mode === "charged"}>
          Go home
        </button>
      </div>
      <a className="vacuum-link" href="#/vacuum">
        Open vacuum page
      </a>
    </section>
  );
}
