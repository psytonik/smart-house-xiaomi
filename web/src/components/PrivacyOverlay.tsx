import type { Zone } from "../api";

/**
 * Black blocks over the private areas of a picture. Place it inside a box that has the picture's shape
 * and is `position: relative`: the blocks are sized in percent of that box.
 * Snapshots and thumbnails are also blacked out by the server; this covers the live video and older files.
 */
export function PrivacyOverlay({ zones }: { zones: Zone[] }) {
  const hidden = zones.filter((z) => z.mode === "privacy");
  if (hidden.length === 0) return null;
  return (
    <div className="privacy-layer" aria-hidden="true">
      {hidden.map((z) => (
        <span key={z.id} className="privacy-block" style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }} />
      ))}
    </div>
  );
}
