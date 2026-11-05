import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, calibrateCamera, getPtzPosition, goPlace, gotoPtz, listPlaces, removePlace, savePlace, type GotoResult, type PtzPlace, type PtzPosition } from "./api";

export type PtzBusy = "goto" | "calibrate" | null;

/** Words for how a walk to a position ended; empty when it got there. */
export function gotoNote(r: GotoResult): string {
  if (r.reached) return "";
  if (r.reason === "limit") return "The camera stopped at the end of its range";
  if (r.reason === "max-steps") return "The camera didn't get all the way there";
  return "The camera didn't say where it points";
}

/**
 * Where the camera points and the saved places, kept fresh: the last answer is read every few seconds (cheap, the server does not
 * bother the camera) and shortly after a move. `say` shows a short message; errors go to `onError`.
 */
export function usePtz(onError: (e: unknown) => void, say: (m: string) => void, pollMs = 5000) {
  const [position, setPosition] = useState<PtzPosition | null>(null);
  const [places, setPlaces] = useState<PtzPlace[]>([]);
  const [busy, setBusy] = useState<PtzBusy>(null);
  const timer = useRef<number>(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const read = useCallback(
    (refresh = false) =>
      getPtzPosition(refresh)
        .then((p) => alive.current && setPosition(p))
        .catch((e) => {
          if (e instanceof AuthError) onError(e);
          // a failed read of the position is not worth a message: the next one comes soon
        }),
    [onError],
  );

  const loadPlaces = useCallback(() => listPlaces().then((p) => alive.current && setPlaces(p)).catch(onError), [onError]);

  useEffect(() => {
    void read();
    void loadPlaces();
    const t = setInterval(() => !document.hidden && void read(), pollMs);
    return () => clearInterval(t);
  }, [read, loadPlaces, pollMs]);

  /** Ask again in a moment: the camera has just been told to move. */
  const soon = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void read(), 900);
  }, [read]);

  const run = useCallback(
    async (kind: Exclude<PtzBusy, null>, task: () => Promise<GotoResult | void>, done: (r: GotoResult | void) => string) => {
      if (busy) return;
      setBusy(kind);
      try {
        const r = await task();
        const note = done(r);
        if (note) say(note);
        await read(true);
      } catch (e) {
        onError(e);
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [busy, onError, read, say],
  );

  return {
    position,
    places,
    busy,
    soon,
    goto: (angle: number, elevation: number) => run("goto", () => gotoPtz(angle, elevation), (r) => (r ? gotoNote(r) : "")),
    goPlace: (p: PtzPlace) => run("goto", () => goPlace(p.id), (r) => (r && !(r as GotoResult).reached ? gotoNote(r as GotoResult) : `At ${p.name}`)),
    calibrate: () => run("calibrate", calibrateCamera, () => "Calibrated"),
    save: async (name: string) => {
      try {
        const p = await savePlace(name);
        say(`Saved ${p.name}`);
        await loadPlaces();
      } catch (e) {
        onError(e);
      }
    },
    remove: async (p: PtzPlace) => {
      try {
        await removePlace(p.id);
        say(`Removed ${p.name}`);
        await loadPlaces();
      } catch (e) {
        onError(e);
      }
    },
  };
}
