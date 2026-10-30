import { useEffect, useRef, useState } from "react";
import type { Direction } from "../api";

const C = 140;
const rad = (deg: number) => ((deg - 90) * Math.PI) / 180; // 0deg = up, clockwise
const pt = (r: number, a: number): [number, number] => [C + r * Math.cos(rad(a)), C + r * Math.sin(rad(a))];

function wedge(a1: number, a2: number, r1 = 64, r2 = 118): string {
  const [x1, y1] = pt(r2, a1);
  const [x2, y2] = pt(r2, a2);
  const [x3, y3] = pt(r1, a2);
  const [x4, y4] = pt(r1, a1);
  return `M${x1} ${y1}A${r2} ${r2} 0 0 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 0 0 ${x4} ${y4}Z`;
}

const SIDES: Array<{ dir: Direction; angle: number; label: string }> = [
  { dir: "up", angle: 0, label: "Tilt up" },
  { dir: "right", angle: 90, label: "Pan right" },
  { dir: "down", angle: 180, label: "Tilt down" },
  { dir: "left", angle: 270, label: "Pan left" },
];

const TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = i * 5;
  const len = i % 18 === 0 ? 11 : i % 6 === 0 ? 7 : 4;
  const [x1, y1] = pt(134 - len, a);
  const [x2, y2] = pt(134, a);
  return { x1, y1, x2, y2, major: i % 18 === 0 };
});

interface Props {
  /** Rotation of the tick ring in degrees; it turns a little with every move. */
  angle: number;
  onMove: (dir: Direction) => void;
  onCapture: () => void;
  capturing: boolean;
}

export function JogDial({ angle, onMove, onCapture, capturing }: Props) {
  const [pressed, setPressed] = useState<Direction | null>(null);
  const fire = (dir: Direction) => onMove(dir);
  // Stops the repeat of the side that is held right now, if any.
  const release = useRef<(() => void) | null>(null);

  // The camera must not keep turning after the dial is gone (screen closed, signed out) or if a release was missed.
  useEffect(() => () => release.current?.(), []);

  function press(dir: Direction) {
    release.current?.(); // a second finger replaces the first instead of stacking another repeat
    setPressed(dir);
    fire(dir);
    const timer = setInterval(() => fire(dir), 450);
    const stop = () => {
      clearInterval(timer);
      setPressed(null);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (release.current === stop) release.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    release.current = stop;
  }

  return (
    <svg className="dial" viewBox="0 0 280 280" role="group" aria-label="Camera controls">
      <g className="ticks" style={{ transform: `rotate(${angle}deg)` }} aria-hidden="true">
        {TICKS.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={t.major ? "major" : undefined} />
        ))}
      </g>

      {SIDES.map(({ dir, angle: a, label }) => {
        const [cx, cy] = pt(91, a);
        return (
          <g key={dir}>
            <path
              d={wedge(a - 38, a + 38)}
              className={`wedge${pressed === dir ? " pressed" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={label}
              onPointerDown={(e) => {
                e.preventDefault();
                press(dir);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fire(dir);
                }
              }}
            />
            <path
              d="M-7 3.5L0 -3.5L7 3.5"
              className="chevron"
              transform={`translate(${cx} ${cy}) rotate(${a})`}
              aria-hidden="true"
            />
          </g>
        );
      })}

      <g
        className={`capture${capturing ? " busy" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Capture snapshot"
        onClick={onCapture}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCapture();
          }
        }}
      >
        <circle cx={C} cy={C} r="54" />
        <g transform="translate(140 130)" aria-hidden="true">
          <path d="M-13 -6h5l2.5 -4h11l2.5 4h5a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-26a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z" />
          <circle r="5.5" cy="3" />
        </g>
        <text x={C} y="165" textAnchor="middle">
          {capturing ? "Saving…" : "Capture"}
        </text>
      </g>
    </svg>
  );
}
