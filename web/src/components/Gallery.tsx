import { useEffect, useRef, useState } from "react";
import type { Snapshot, Zone } from "../api";
import { snapshotDay, snapshotTime } from "../util";
import { PrivacyOverlay } from "./PrivacyOverlay";

function Frame({ item, zones, onOpen }: { item: Snapshot; zones: Zone[]; onOpen: (s: Snapshot) => void }) {
  return (
    <li>
      <button type="button" className="frame" onClick={() => onOpen(item)} aria-label={`Open snapshot from ${snapshotTime(item.name)}`}>
        <img src={item.url} alt="" loading="lazy" />
        <PrivacyOverlay zones={zones} />
        <span className="stamp">{snapshotTime(item.name)}</span>
      </button>
    </li>
  );
}

function Viewer({ item, zones, onClose }: { item: Snapshot; zones: Zone[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);
  return (
    <dialog ref={ref} className="viewer" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <div className="viewer-body">
        <div className="shot">
          <img src={item.url} alt={`Snapshot from ${snapshotTime(item.name)}`} />
          <PrivacyOverlay zones={zones} />
        </div>
        <div className="viewer-bar">
          <span>
            {snapshotDay(item.name)}, {snapshotTime(item.name)}
          </span>
          <a href={item.url} download={item.name}>
            Download
          </a>
          <button type="button" onClick={() => ref.current?.close()}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function Gallery({ items, zones = [] }: { items: Snapshot[]; zones?: Zone[] }) {
  const [open, setOpen] = useState<Snapshot | null>(null);

  if (items.length === 0) {
    return <p className="empty">No snapshots yet. Press Capture in the dial to save the current frame.</p>;
  }
  return (
    <>
      <ul className="sheet-grid">
        {items.slice(0, 24).map((item) => (
          <Frame key={item.name} item={item} zones={zones} onOpen={setOpen} />
        ))}
      </ul>
      {open && <Viewer item={open} zones={zones} onClose={() => setOpen(null)} />}
    </>
  );
}
