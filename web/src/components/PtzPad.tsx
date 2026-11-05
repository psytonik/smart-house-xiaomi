import { useState, type FormEvent, type MouseEvent } from "react";
import { PTZ_MAX, PTZ_MIN, type PtzPlace, type PtzPosition } from "../api";
import type { PtzBusy } from "../usePtz";

const SPAN = PTZ_MAX - PTZ_MIN; // 100

const clamp = (n: number) => Math.min(PTZ_MAX, Math.max(PTZ_MIN, Math.round(n)));

/** A point on the map (0..1 from the left and from the top) as the camera's position. Left is a high angle, the top is a high elevation. */
export function padToPosition(fx: number, fy: number): { angle: number; elevation: number } {
  return { angle: clamp(PTZ_MAX - fx * SPAN), elevation: clamp(PTZ_MAX - fy * SPAN) };
}

/** The camera's position as a place on the map, in percent from the left and from the top. */
export function positionToPad(angle: number, elevation: number): { x: number; y: number } {
  return { x: ((PTZ_MAX - angle) / SPAN) * 100, y: ((PTZ_MAX - elevation) / SPAN) * 100 };
}

interface Props {
  position: PtzPosition | null;
  places: PtzPlace[];
  busy: PtzBusy;
  onGoto: (angle: number, elevation: number) => void;
  onGoPlace: (p: PtzPlace) => void;
  onSavePlace: (name: string) => Promise<void> | void;
  onRemovePlace: (p: PtzPlace) => void;
  onCalibrate: () => void;
}

/** Where the camera points, a map of its range to click on, saved places, and calibration. Beside the dial on the Camera page. */
export function PtzPad({ position, places, busy, onGoto, onGoPlace, onSavePlace, onRemovePlace, onCalibrate }: Props) {
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const known = !!position?.known && position.angle !== undefined && position.elevation !== undefined;
  const here = known ? positionToPad(position!.angle!, position!.elevation!) : null;

  const clickPad = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail === 0) return; // from the keyboard: there is no point to go to (the arrow keys move the camera)
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const { angle, elevation } = padToPosition((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    onGoto(angle, elevation);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || !known) return;
    await onSavePlace(clean);
    setName("");
  };

  return (
    <section className="ptz" aria-labelledby="ptz-title">
      <h2 id="ptz-title" className="ptz-title">
        Position
      </h2>
      <p className="ptz-readout">{known ? `Pan ${position!.angle} · Tilt ${position!.elevation}` : "Position unknown"}</p>

      <button
        type="button"
        className="ptz-pad"
        onClick={clickPad}
        disabled={busy !== null}
        aria-label="Map of the camera's range. Click a point to move the camera there. The arrow keys move it a step."
      >
        {places.map((p) => {
          const at = positionToPad(p.angle, p.elevation);
          return <span key={p.id} className="ptz-spot" style={{ left: `${at.x}%`, top: `${at.y}%` }} aria-hidden="true" />;
        })}
        {here && <span className="ptz-dot" style={{ left: `${here.x}%`, top: `${here.y}%` }} aria-hidden="true" />}
      </button>

      <p className="ptz-status" role="status">
        {busy === "goto" ? "Moving…" : busy === "calibrate" ? "Calibrating… the camera sweeps its range" : ""}
      </p>

      <div className="ptz-places">
        {places.length === 0 && <p className="hint">No saved places yet. Point the camera, name the place and save it.</p>}
        {places.map((p) =>
          removing === p.id ? (
            <span key={p.id} className="ptz-place">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setRemoving(null);
                  onRemovePlace(p);
                }}
                aria-label={`Remove ${p.name}?`}
              >
                Remove {p.name}?
              </button>
              <button type="button" className="quiet" onClick={() => setRemoving(null)}>
                Keep
              </button>
            </span>
          ) : (
            <span key={p.id} className="ptz-place">
              <button type="button" onClick={() => onGoPlace(p)} disabled={busy !== null}>
                {p.name}
              </button>
              <button type="button" className="quiet" onClick={() => setRemoving(p.id)} aria-label={`Remove ${p.name}`}>
                ×
              </button>
            </span>
          ),
        )}
      </div>

      <form className="ptz-save" onSubmit={(e) => void save(e)} aria-label="Save this place">
        <label>
          <span>Name this place</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Door" />
        </label>
        <button type="submit" disabled={!known || !name.trim() || busy !== null}>
          Save place
        </button>
      </form>

      {calibrating ? (
        <div className="ptz-calibrate">
          <p className="hint">The camera sweeps its whole range and moves by itself for a while. Calibrate now?</p>
          <div className="ptz-calibrate-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setCalibrating(false);
                onCalibrate();
              }}
            >
              Calibrate
            </button>
            <button type="button" className="quiet" onClick={() => setCalibrating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="quiet" onClick={() => setCalibrating(true)} disabled={busy !== null}>
          Calibrate…
        </button>
      )}
    </section>
  );
}
