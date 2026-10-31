import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthError,
  clearToken,
  currentToken,
  getMotion,
  getStatus,
  getZones,
  listClips,
  listSnapshots,
  move,
  resetStream,
  saveSnapshot,
  type Clip,
  type Direction,
  type MotionStatus,
  type Snapshot,
  type Zone,
} from "./api";
import { Cameras } from "./components/Cameras";
import { Clips } from "./components/Clips";
import { Gallery } from "./components/Gallery";
import { JogDial } from "./components/JogDial";
import { LightsPage } from "./components/LightsPage";
import { Shell } from "./components/Shell";
import { Login } from "./components/Login";
import { Player, type Mode, type PlayerState } from "./components/Player";
import { PrivacyOverlay } from "./components/PrivacyOverlay";
import { SystemPanel } from "./components/SystemPanel";
import { VacuumPage } from "./components/VacuumPage";
import { useRoute } from "./route";
import { ZoneEditor } from "./components/ZoneEditor";

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "webrtc", label: "WebRTC", hint: "Lowest delay" },
  { id: "hls", label: "HLS", hint: "Smoother, a few seconds behind" },
  { id: "frames", label: "Frames", hint: "A still image every second. Always works." },
];

function loadMode(): Mode {
  try {
    const v = localStorage.getItem("cam.mode");
    if (v === "webrtc" || v === "hls" || v === "frames") return v;
  } catch {
    /* ignore */
  }
  return "webrtc";
}

const KEYS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function Monitor({ onLogout }: { onLogout: () => void }) {
  const [mode, setMode] = useState<Mode>(loadMode);
  const [attempt, setAttempt] = useState(0);
  const [player, setPlayer] = useState<PlayerState>({ status: "connecting" });
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [motion, setMotion] = useState<MotionStatus | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [editingZones, setEditingZones] = useState(false);
  const [managingCameras, setManagingCameras] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [angle, setAngle] = useState(0);
  const [toast, setToast] = useState("");
  const moving = useRef(false);
  const toastTimer = useRef<number>(0);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4000);
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) onLogout();
      else say(e instanceof Error ? e.message : "Something went wrong.");
    },
    [onLogout, say],
  );

  const refresh = useCallback(() => listSnapshots().then(setSnapshots).catch(fail), [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    getZones().then(setZones).catch(fail);
  }, [fail]);

  const refreshClips = useCallback(() => listClips().then(setClips).catch(fail), [fail]);

  useEffect(() => {
    void refreshClips();
    const t = setInterval(() => void refreshClips(), 10_000);
    return () => clearInterval(t);
  }, [refreshClips]);

  useEffect(() => {
    const poll = () => {
      getStatus()
        .then((s) => setReachable(s.reachable))
        .catch((e) => (e instanceof AuthError ? onLogout() : setReachable(false)));
      getMotion()
        .then(setMotion)
        .catch((e) => e instanceof AuthError && onLogout());
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [onLogout]);

  const handleMove = useCallback(
    async (dir: Direction) => {
      if (moving.current) return;
      moving.current = true;
      setAngle((a) => a + (dir === "right" || dir === "up" ? 6 : -6));
      try {
        await move(dir);
      } catch (e) {
        fail(e);
      } finally {
        moving.current = false;
      }
    },
    [fail],
  );

  const capture = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      await saveSnapshot();
      await refresh();
      say("Snapshot saved");
    } catch (e) {
      fail(e);
    } finally {
      setCapturing(false);
    }
  }, [capturing, refresh, say, fail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, dialog, [role=radio]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = KEYS[e.key];
      if (dir) {
        e.preventDefault();
        void handleMove(dir);
      } else if (e.key === "c" || e.key === "C") {
        void capture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleMove, capture]);

  // The player is removed while the backend lets go of the camera: an open player would keep the session alive.
  const reset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    try {
      const { otherViewers } = await resetStream();
      say(otherViewers > 0 ? `Stream reset. ${otherViewers} other viewer${otherViewers === 1 ? " is" : "s are"} still connected: close those tabs for a fully fresh connection.` : "Stream reset");
    } catch (e) {
      fail(e);
    } finally {
      setResetting(false);
      setPlayer({ status: "connecting" });
      setAttempt((n) => n + 1);
    }
  }, [resetting, say, fail]);

  function chooseMode(next: Mode) {
    try {
      localStorage.setItem("cam.mode", next);
    } catch {
      /* ignore */
    }
    setMode(next);
  }

  const live = player.status === "live";
  const statusText =
    reachable === false
      ? "go2rtc isn't running"
      : motion?.recording
        ? "Recording motion"
        : live
          ? "Live"
          : player.status === "error"
            ? "No picture"
            : "Connecting…";

  return (
    <Shell current="camera" onLogout={onLogout} live={live}>
      <div className="monitor">
        <header className="bar">
          <div className="who">
            <h1 className="sr-only">Camera</h1>
            <span className="state" role="status">
              {statusText}
            </span>
          </div>
          <div className="modes" role="radiogroup" aria-label="Video mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={m.hint} onClick={() => chooseMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="bar-actions">
            <button type="button" className="quiet" onClick={() => void reset()} disabled={resetting} title="Drop the buffered picture and reconnect to the camera">
              {resetting ? "Resetting…" : "Reset stream"}
            </button>
            <button type="button" className="quiet" onClick={() => setManagingCameras(true)}>
              Cameras
            </button>
            <button type="button" className="quiet" onClick={() => setEditingZones(true)}>
              Zones
            </button>
          </div>
        </header>

        <main className="stage">
          <section className="viewport" aria-label="Camera view">
            {!resetting && <Player mode={mode} attempt={attempt} onState={setPlayer} onAuthError={onLogout} />}
            <PrivacyOverlay zones={zones} />
            {resetting && (
              <div className="overlay solid" role="status">
                <p className="headline">Resetting the stream…</p>
                <p>Letting go of the camera and connecting again. This takes a few seconds.</p>
              </div>
            )}
            {live && !resetting && motion?.unstable && (
              <div className="overlay solid" role="status">
                <p className="headline">Reconnecting to the camera…</p>
                <p>The picture can be damaged for a few seconds. It comes back by itself.</p>
              </div>
            )}
            {!live && !resetting && (
              <div className="overlay">
                {player.status === "error" ? (
                  <>
                    <p className="headline">The stream didn't start.</p>
                    <p>{player.message}</p>
                    <div className="actions">
                      <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                        Try again
                      </button>
                      {mode !== "frames" && (
                        <button type="button" onClick={() => chooseMode("frames")}>
                          Switch to Frames
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p>Connecting to the camera…</p>
                )}
              </div>
            )}
          </section>

          <aside className="rail">
            <JogDial angle={angle} onMove={handleMove} onCapture={capture} capturing={capturing} />
            <p className="hint">Hold a side to keep moving. Arrow keys move the camera and C captures.</p>
          </aside>

          <section className="sheet clips" aria-labelledby="clips-title">
            <h2 id="clips-title">Motion clips</h2>
            <Clips clips={clips} motion={motion} zones={zones} onChanged={refreshClips} onError={fail} />
          </section>

          <section className="sheet system" aria-labelledby="system-title">
            <h2 id="system-title">System</h2>
            <SystemPanel onAuthError={onLogout} />
          </section>

          <section className="sheet snapshots" aria-labelledby="sheet-title">
            <h2 id="sheet-title">Snapshots</h2>
            <Gallery items={snapshots} zones={zones} />
          </section>
        </main>

        {editingZones && (
          <ZoneEditor
            onClose={() => setEditingZones(false)}
            onSaved={(saved) => {
              setZones(saved);
              say("Zones saved");
            }}
            onAuthError={onLogout}
            onError={fail}
          />
        )}
        {managingCameras && <Cameras onClose={() => setManagingCameras(false)} onAuthError={onLogout} />}

        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      </div>
    </Shell>
  );
}

export function App() {
  const [authed, setAuthed] = useState(() => currentToken() !== "");
  const logout = useCallback(() => {
    clearToken();
    setAuthed(false);
  }, []);
  const route = useRoute();
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  switch (route) {
    case "vacuum":
      return <VacuumPage onLogout={logout} />;
    case "lights":
      return <LightsPage onLogout={logout} />;
    default:
      return <Monitor onLogout={logout} />;
  }
}
