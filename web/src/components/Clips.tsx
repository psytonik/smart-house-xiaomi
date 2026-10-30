import { useEffect, useRef, useState } from "react";
import { deleteClip, type Clip, type MotionStatus, type Zone } from "../api";
import { dayKey, dayLabel, episodeLabels, filterByDay, filterByObject, groupEpisodes, hasAnalysis, type Episode, type ObjectFilter, type ObjectLabel } from "../episodes";
import { clipDay, clipTime, duration, megabytes } from "../util";
import { PrivacyOverlay } from "./PrivacyOverlay";

const WORD: Record<ObjectLabel, string> = { person: "Person", vehicle: "Vehicle", animal: "Animal" };
const FILTERS: Array<{ id: ObjectFilter | null; label: string }> = [
  { id: null, label: "All" },
  { id: "person", label: "People" },
  { id: "vehicle", label: "Vehicles" },
  { id: "animal", label: "Animals" },
  { id: "none", label: "Nothing found" },
];

function Card({ episode, zones, onOpen }: { episode: Episode; zones: Zone[]; onOpen: (e: Episode) => void }) {
  const first = episode.clips[0]!;
  const many = episode.count > 1;
  return (
    <li>
      <button
        type="button"
        className="clip"
        onClick={() => onOpen(episode)}
        aria-label={
          many
            ? `Play episode of ${episode.count} clips from ${clipDay(episode.startedAt)}, ${clipTime(episode.startedAt)}, ${duration(episode.totalSec)}`
            : `Play clip from ${clipDay(first.startedAt)}, ${clipTime(first.startedAt)}, ${duration(first.durationSec)}`
        }
      >
        <span className="thumb">
          {first.thumbUrl ? <img src={first.thumbUrl} alt="" loading="lazy" /> : <span className="placeholder" />}
          <PrivacyOverlay zones={zones} />
          {many && <span className="count">{episode.count}</span>}
        </span>
        <span className="caption">
          <strong>{clipTime(episode.startedAt)}</strong>
          {episodeLabels(episode).length > 0 && (
            <span className="tags">
              {episodeLabels(episode).map((l) => (
                <span key={l} className="tag">
                  {WORD[l]}
                </span>
              ))}
            </span>
          )}
          <span>
            {many ? `${episode.count} clips, ${duration(episode.totalSec)}` : `${clipDay(first.startedAt)}, ${duration(first.durationSec)}`}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Plays the clips of one episode in order; deleting one moves on to the next. */
function Player({ episode, onClose, onChanged, onError }: { episode: Episode; onClose: () => void; onChanged: () => void; onError: (e: unknown) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [clips, setClips] = useState<Clip[]>(episode.clips);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const many = episode.count > 1; // an episode keeps its controls even after clips are deleted from it
  const clip = clips[index]!;

  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  async function remove() {
    try {
      await deleteClip(clip.id);
      const rest = clips.filter((c) => c.id !== clip.id);
      setConfirming(false);
      onChanged();
      if (rest.length === 0) {
        ref.current?.close();
        return;
      }
      setClips(rest);
      setIndex(Math.min(index, rest.length - 1));
    } catch (e) {
      setConfirming(false);
      onError(e);
    }
  }

  function go(to: number) {
    setConfirming(false);
    setIndex(to);
  }

  return (
    <dialog ref={ref} className="viewer" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <div className="viewer-body">
        <video key={clip.id} src={clip.clipUrl} controls autoPlay playsInline />
        <div className="viewer-bar">
          <span>
            {clipDay(clip.startedAt)}, {clipTime(clip.startedAt)} for {duration(clip.durationSec)}, {megabytes(clip.bytes)}
            {clip.objects && clip.objects.length > 0 && <> · {clip.objects.map((o) => WORD[o.label]).join(", ")}</>}
          </span>
          {many && (
            <>
              <button type="button" aria-label="Previous clip" onClick={() => go(index - 1)} disabled={index === 0}>
                Previous
              </button>
              <span>
                Clip {index + 1} of {clips.length}
              </span>
              <button type="button" aria-label="Next clip" onClick={() => go(index + 1)} disabled={index === clips.length - 1}>
                Next
              </button>
            </>
          )}
          <a href={clip.clipUrl} download={`${clip.id}.mp4`}>
            Download
          </a>
          {confirming ? (
            <>
              <button type="button" className="danger" onClick={remove}>
                Delete for good
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setConfirming(true)}>
                Delete
              </button>
              <button type="button" onClick={() => ref.current?.close()}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

interface Props {
  clips: Clip[];
  motion: MotionStatus | null;
  /** Private areas to black out on the thumbnails (older thumbnails were made before the zones existed). */
  zones?: Zone[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function Clips({ clips, motion, zones = [], onChanged, onError }: Props) {
  const [open, setOpen] = useState<Episode | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [seen, setSeen] = useState<ObjectFilter | null>(null);

  if (clips.length === 0) {
    let message = "No motion yet. Clips appear here when something moves in front of the camera.";
    if (motion && !motion.enabled) message = "Motion recording is turned off (MOTION_ENABLED=false in backend/.env).";
    else if (motion?.state === "ffmpeg-missing") message = "Motion recording can't start because ffmpeg wasn't found. Install it with brew install ffmpeg, then restart the backend.";
    return <p className="empty">{message}</p>;
  }

  const days = [...new Set(clips.map((c) => dayKey(c.startedAt)))].sort().reverse();
  const shown = day !== null && days.includes(day) ? day : null; // the chosen day may have vanished from the list
  const analysed = hasAnalysis(clips);
  const seenNow = analysed ? seen : null;
  const episodes = groupEpisodes(filterByObject(filterByDay(clips, shown), seenNow));
  const now = new Date();

  return (
    <>
      {days.length > 1 && (
        <div className="modes day-filter" role="radiogroup" aria-label="Day">
          {[null, ...days].map((d) => (
            <button key={d ?? "all"} type="button" role="radio" aria-checked={shown === d} onClick={() => setDay(d)}>
              {d === null ? "All" : dayLabel(d, now)}
            </button>
          ))}
        </div>
      )}
      {analysed && (
        <div className="modes day-filter" role="radiogroup" aria-label="Contains">
          {FILTERS.map((f) => (
            <button key={f.id ?? "all"} type="button" role="radio" aria-checked={seenNow === f.id} onClick={() => setSeen(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      <ul className="clip-grid">
        {episodes.map((e) => (
          <Card key={e.id} episode={e} zones={zones} onOpen={setOpen} />
        ))}
      </ul>
      {open && <Player episode={open} onClose={() => setOpen(null)} onChanged={onChanged} onError={onError} />}
    </>
  );
}
