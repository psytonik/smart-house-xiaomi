import { useEffect, useRef, useState } from "react";
import { AuthError, fetchFrame, getMotion, getZones, saveZones, type MotionStatus, type Zone } from "../api";
import { CORNER_PRESETS, cornerZone, nextZoneId, rectFromDrag, type Point, type Rect } from "../zones";

interface Props {
  onClose: () => void;
  onSaved: (zones: Zone[]) => void;
  onAuthError: () => void;
  onError: (e: unknown) => void;
}

type Mode = Zone["mode"];

export function ZoneEditor({ onClose, onSaved, onAuthError, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<SVGSVGElement>(null);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [motion, setMotion] = useState<MotionStatus | null>(null);
  const [mode, setMode] = useState<Mode>("ignore");
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  // Where the current drag started. A ref, so a move or release that arrives before React has re-rendered still sees it.
  const dragFrom = useRef<Point | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (e: unknown) => (e instanceof AuthError ? onAuthError() : onError(e));

  useEffect(() => {
    const dlg = dialog.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  useEffect(() => {
    getZones().then(setZones).catch(fail);
    let url: string | null = null;
    let gone = false;
    fetchFrame()
      .then((blob) => {
        if (gone) return;
        url = URL.createObjectURL(blob);
        setFrame(url);
      })
      .catch(fail);
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The live level is the point of this dialog: draw a zone, watch the bar drop.
  useEffect(() => {
    const poll = () => getMotion().then(setMotion).catch(() => {});
    poll();
    const t = setInterval(poll, 500);
    return () => clearInterval(t);
  }, []);

  function point(e: React.PointerEvent): Point | null {
    const box = stage.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  }

  function finish(e: React.PointerEvent) {
    const from = dragFrom.current;
    const to = point(e);
    if (from && to) {
      const rect: Rect | null = rectFromDrag(from, to);
      if (rect) setZones((current) => (current ? [...current, { id: nextZoneId(current), mode, ...rect }] : current));
    }
    dragFrom.current = null;
    setDrag(null);
  }

  async function save() {
    if (!zones) return;
    setSaving(true);
    try {
      const saved = await saveZones(zones);
      onSaved(saved);
      dialog.current?.close();
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  const draft = drag ? rectFromDrag(drag.from, drag.to) : null;
  const level = motion?.level ?? 0;
  const threshold = motion?.threshold ?? 1.2;
  const scale = Math.max(threshold * 4, level, 1);

  return (
    <dialog ref={dialog} className="viewer zone-editor" aria-labelledby="zones-title" onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
      <div className="viewer-body">
        <h2 id="zones-title">Motion zones</h2>
        <p className="hint">
          Drag on the picture to draw. An <strong>ignore</strong> zone switches motion off in that area: use it for the time stamp the camera prints in a corner,
          trees or a road. If you add a <strong>watch</strong> zone, motion counts only inside watch zones. A <strong>hidden</strong> zone also blacks the area out
          in the live view, snapshots and clip thumbnails (recorded clips are not changed). Without zones motion counts everywhere.
        </p>

        <div className="zone-stage">
          {frame ? <img src={frame} alt="Current picture from the camera" draggable={false} /> : <p>Loading the picture…</p>}
          <svg
            ref={stage}
            className="zone-layer"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
            onPointerDown={(e) => {
              const from = point(e);
              if (!from) return;
              try {
                e.currentTarget.setPointerCapture?.(e.pointerId); // keeps the drag going outside the picture
              } catch {
                /* not an active pointer (some touch and test cases): the drag still works inside */
              }
              dragFrom.current = from;
              setDrag({ from, to: from });
            }}
            onPointerMove={(e) => {
              const to = point(e);
              if (dragFrom.current && to) setDrag({ from: dragFrom.current, to });
            }}
            onPointerUp={finish}
            onPointerCancel={() => {
              dragFrom.current = null;
              setDrag(null);
            }}
          >
            {(zones ?? []).map((z) => (
              <rect key={z.id} className={`zone ${z.mode}`} x={z.x} y={z.y} width={z.w} height={z.h} />
            ))}
            {draft && <rect className={`zone ${mode} draft`} x={draft.x} y={draft.y} width={draft.w} height={draft.h} />}
          </svg>
        </div>

        <div
          className="level"
          role="meter"
          aria-label="Motion level"
          aria-valuemin={0}
          aria-valuemax={scale}
          aria-valuenow={level}
          aria-valuetext={`Motion ${level}% of the picture, counts from ${threshold}%`}
        >
          <span className={`bar${level > threshold ? " over" : ""}`} style={{ width: `${Math.min(100, (level / scale) * 100)}%` }} />
          <span className="mark" style={{ left: `${(threshold / scale) * 100}%` }} />
          <span className="caption">
            {level}% now, counts from {threshold}%
          </span>
        </div>

        <div className="zone-tools">
          <div className="modes" role="radiogroup" aria-label="Kind of the next zone">
            <button type="button" role="radio" aria-checked={mode === "ignore"} onClick={() => setMode("ignore")}>
              Ignore here
            </button>
            <button type="button" role="radio" aria-checked={mode === "watch"} onClick={() => setMode("watch")}>
              Only watch here
            </button>
            <button type="button" role="radio" aria-checked={mode === "privacy"} onClick={() => setMode("privacy")}>
              Hide (privacy)
            </button>
          </div>
          <div className="presets">
            {CORNER_PRESETS.map((c) => (
              <button key={c.id} type="button" onClick={() => zones && setZones([...zones, cornerZone(c.id, mode, nextZoneId(zones))])}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {zones && zones.length === 0 && <p className="empty">No zones: motion counts on the whole picture.</p>}
        <ul className="zone-list">
          {(zones ?? []).map((z) => (
            <li key={z.id}>
              <span className={`swatch ${z.mode}`} aria-hidden="true" />
              <span>
                {z.id} · {z.mode === "ignore" ? "ignore" : z.mode === "watch" ? "watch only" : "hidden"}
              </span>
              <button type="button" aria-label={`Remove ${z.id}`} onClick={() => setZones(zones!.filter((x) => x.id !== z.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="viewer-bar">
          <button type="button" onClick={save} disabled={saving || zones === null}>
            {saving ? "Saving…" : "Save zones"}
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
