import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AuthError, cancelTvPairing, closeTvApps, getTv, getTvRunning, getTvSources, launchTvApp, sendTvCode, sendTvKey, startTvPairing, switchTvSource, type TvKey, type TvRunningApp, type TvState } from "../api";
import { Shell } from "./Shell";
import { CODE_PATTERN, appName } from "./tvText";

/** How often the page asks the TV what it is doing (screen, volume, the app in front). */
const POLL_MS = 3000;
/** A held arrow or volume key repeats after this delay, then at this rate. */
const HOLD_MS = 400;
const REPEAT_MS = 120;

/** The TV remote, reached at /tv. */
export function TvPage({ onLogout }: { onLogout: () => void }) {
  const [state, setState] = useState<TvState | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const say = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4000);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onLogout();
      say(e instanceof Error ? e.message : "Something went wrong");
    },
    [onLogout, say],
  );

  const load = useCallback(() => {
    getTv()
      .then(setState)
      .catch((e) => {
        if (e instanceof AuthError) onLogout();
        else setState((s) => s ?? { configured: true, link: "offline", paired: true });
      });
  }, [onLogout]);
  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const prev = document.title;
    document.title = "TV";
    return () => {
      document.title = prev;
    };
  }, []);

  const ready = state?.link === "ready";
  const press = useCallback(
    (key: TvKey) => {
      sendTvKey(key).catch(fail);
      if (key === "volumeUp" || key === "volumeDown" || key === "mute" || key === "power") window.setTimeout(load, 600); // the TV says its new state a moment later
    },
    [fail, load],
  );

  // the keyboard works the remote: arrows, Enter, Esc/Backspace, + and -, M
  useEffect(() => {
    if (!ready) return;
    const map: Record<string, TvKey> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Escape: "back", Backspace: "back", "+": "volumeUp", "=": "volumeUp", "-": "volumeDown", m: "mute", M: "mute" };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null; // a key pressed with nothing focused has the document or window as target
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, summary")) return;
      const key = e.key === "Enter" && !el?.closest("button, a") ? "ok" : map[e.key];
      if (!key) return;
      e.preventDefault();
      if (!e.repeat || key === "up" || key === "down" || key === "left" || key === "right" || key === "volumeUp" || key === "volumeDown") press(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, press]);

  return (
    <Shell current="tv" onLogout={onLogout}>
      <main className="vpage-main tv-main">
        <h1 className="page-title" ref={heading} tabIndex={-1}>
          TV
        </h1>
        {!state && <p className="hint">Connecting to the TV…</p>}
        {state && !state.configured && <p className="hint">No TV is set up. Add TV_IP to backend/.env and restart the server.</p>}
        {state?.configured && !state.paired && <Pairing state={state} onChange={load} onError={fail} onDone={() => say("Paired with the TV")} />}
        {state?.configured && state.paired && (
          <div className="vgrid tv-grid">
            <div className="vcol">
              <Status state={state} press={press} />
              <Remote ready={ready} press={press} adb={state.adb === true} />
            </div>
            <div className="vcol">
              {state.adb && <Sources onError={fail} onAuthError={onLogout} />}
              {state.adb && <Running onError={fail} onAuthError={onLogout} onNotice={say} />}
              <Apps state={state} ready={ready} onError={fail} />
              <MoreKeys ready={ready} press={press} adb={state.adb === true} />
              <section className="vcard tv-pair-again">
                <details>
                  <summary>Pair again</summary>
                  <p className="hint">If the TV stopped answering the remote (after a factory reset, say), pair it again.</p>
                  <button type="button" onClick={() => void startTvPairing().then(load, fail)}>
                    Show a new code on the TV
                  </button>
                </details>
              </section>
            </div>
          </div>
        )}
      </main>
      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </Shell>
  );
}

// ---------- status ----------
function Status({ state, press }: { state: TvState; press: (key: TvKey) => void }) {
  const ready = state.link === "ready";
  const v = state.volume;
  return (
    <section className="vcard tv-status" aria-label="TV state">
      <div className="tv-status-text">
        <p className={`tv-link tv-link-${ready ? "on" : "off"}`} role="status">
          {ready ? (state.powered === false ? "Connected, screen off" : "Connected") : state.link === "connecting" ? "Connecting…" : "Not answering"}
        </p>
        {ready && state.app && <p className="tv-now">Now: {appName(state.app)}</p>}
        {ready && v && <p className="tv-now">{v.muted ? "Muted" : `Volume ${v.level}`}</p>}
        {!ready && <p className="hint">The TV may be off or asleep. Turn it on with its own remote; this page connects by itself.</p>}
      </div>
      <button type="button" className="tv-power" onClick={() => press("power")} disabled={!ready} aria-label={state.powered === false ? "Turn the TV on" : "Turn the TV off"}>
        <Icon d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />
        <span>{state.powered === false ? "On" : "Off"}</span>
      </button>
    </section>
  );
}

// ---------- the remote ----------
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

/**
 * A key. A mouse or finger presses it on the way down (and, when `hold`, keeps pressing while held); a key from the keyboard
 * arrives as a click with no pointer behind it. Each press is sent once.
 */
function Key({ k, label, press, disabled, hold = false, className, children }: { k: TvKey; label: string; press: (key: TvKey) => void; disabled: boolean; hold?: boolean; className?: string; children: ReactNode }) {
  const timers = useRef<{ wait?: number; repeat?: number }>({});
  const stop = () => {
    window.clearTimeout(timers.current.wait);
    window.clearInterval(timers.current.repeat);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className={className ? `tv-key ${className}` : "tv-key"}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button > 0) return; // the left button, a finger or a pen
        press(k);
        if (hold) timers.current.wait = window.setTimeout(() => (timers.current.repeat = window.setInterval(() => press(k), REPEAT_MS)), HOLD_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => hold && e.preventDefault()}
      onClick={(e) => e.detail === 0 && press(k)}
    >
      {children}
    </button>
  );
}

const ARROW = {
  up: "M12 6l6 8H6z",
  down: "M12 18l-6-8h12z",
  left: "M6 12l8-6v12z",
  right: "M18 12l-8 6V6z",
};

function Remote({ ready, press, adb }: { ready: boolean; press: (key: TvKey) => void; adb: boolean }) {
  const off = !ready;
  const k = (key: TvKey, label: string, body: ReactNode, extra: { hold?: boolean; className?: string } = {}) => (
    // the Input key opens the TV's own Source Choice over ADB, which does not need the remote link
    <Key k={key} label={label} press={press} disabled={key === "input" && adb ? false : off} {...extra}>
      {body}
    </Key>
  );
  return (
    <section className="vcard tv-remote" aria-label="Remote">
      <div className="tv-row tv-row-3">
        {k("back", "Back", <><Icon d="M9 7 4 12l5 5M4 12h11a5 5 0 0 1 5 5v1" /><span>Back</span></>)}
        {k("home", "Home", <><Icon d="M4 11l8-7 8 7M6 10v9h12v-9" /><span>Home</span></>)}
        {k("input", adb ? "Input: open Source Choice" : "Input", <><Icon d="M4 8h12M4 8l3-3M4 8l3 3M20 16H8M20 16l-3-3M20 16l-3 3" /><span>Input</span></>)}
      </div>

      <div className="tv-middle">
        <div className="tv-side" role="group" aria-label="Volume">
          {k("volumeUp", "Volume up", <Icon d="M12 5v14M5 12h14" />, { hold: true })}
          {k("mute", "Mute", <Icon d="M4 9v6h4l5 4V5L8 9H4zM17 9l4 6M21 9l-4 6" />)}
          {k("volumeDown", "Volume down", <Icon d="M5 12h14" />, { hold: true })}
        </div>

        <div className="tv-dpad" role="group" aria-label="Arrows">
          {k("up", "Up", <Icon d={ARROW.up} />, { hold: true, className: "tv-up" })}
          {k("left", "Left", <Icon d={ARROW.left} />, { hold: true, className: "tv-left" })}
          {k("ok", "OK", <span>OK</span>, { className: "tv-ok" })}
          {k("right", "Right", <Icon d={ARROW.right} />, { hold: true, className: "tv-right" })}
          {k("down", "Down", <Icon d={ARROW.down} />, { hold: true, className: "tv-down" })}
        </div>

        <div className="tv-side" role="group" aria-label="Channel">
          {k("channelUp", "Channel up", <Icon d="M6 15l6-6 6 6" />)}
          {k("guide", "Guide", <span>Guide</span>)}
          {k("channelDown", "Channel down", <Icon d="M6 9l6 6 6-6" />)}
        </div>
      </div>

      <div className="tv-row tv-row-5" role="group" aria-label="Playback">
        {k("previous", "Previous", <Icon d="M7 6v12M18 6l-8 6 8 6z" />)}
        {k("rewind", "Rewind", <Icon d="M12 7l-7 5 7 5zM20 7l-7 5 7 5z" />)}
        {k("playPause", "Play or pause", <Icon d="M4 5l8 7-8 7zM16 5v14M20 5v14" />, { className: "tv-play" })}
        {k("fastForward", "Fast forward", <Icon d="M12 7l7 5-7 5zM4 7l7 5-7 5z" />)}
        {k("next", "Next", <Icon d="M17 6v12M6 6l8 6-8 6z" />)}
      </div>
      <p className="hint tv-keys-hint">Keyboard: arrows, Enter for OK, Esc or Backspace for Back, + and − for volume, M to mute.</p>
    </section>
  );
}

// ---------- apps and the rest of the keys ----------
function Apps({ state, ready, onError }: { state: TvState; ready: boolean; onError: (e: unknown) => void }) {
  const [opening, setOpening] = useState<string | null>(null);
  if (!state.apps?.length) return null;
  return (
    <section className="vcard" aria-labelledby="tv-apps-title">
      <h2 id="tv-apps-title">Apps</h2>
      <ul className="tv-apps">
        {state.apps.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              disabled={!ready || opening !== null}
              onClick={() => {
                setOpening(a.id);
                launchTvApp(a.id)
                  .catch(onError)
                  .finally(() => setOpening(null));
              }}
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The TV's own Source Choice, one button per source it really has (found out from the TV). */
function Sources({ onError, onAuthError }: { onError: (e: unknown) => void; onAuthError: () => void }) {
  const [sources, setSources] = useState<Array<{ id: string; label: string }> | null>(null);
  const [problem, setProblem] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getTvSources()
      .then((s) => alive && setSources(s))
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
        else if (alive) setProblem(e instanceof Error ? e.message : "Couldn't read the TV's sources");
      });
    return () => {
      alive = false;
    };
  }, [onAuthError]);
  if (!sources && !problem) return null;
  return (
    <section className="vcard" aria-labelledby="tv-sources-title">
      <h2 id="tv-sources-title">Sources</h2>
      {sources && (
        <ul className="tv-apps">
          {sources.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={switching !== null}
                onClick={() => {
                  setSwitching(s.id);
                  switchTvSource(s.id)
                    .catch(onError)
                    .finally(() => setSwitching(null));
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="pair-problem" role="alert">{problem}</p>}
      <p className="hint tv-keys-hint">The Input button opens the TV's own Source Choice list. Move in it with the arrows and OK.</p>
    </section>
  );
}

/** How often the list of running apps is refreshed. */
const RUNNING_POLL_MS = 5000;

/** What is open in the TV's memory (apps a person opened, and helpers like the Chromecast receiver), with a way to close it. */
function Running({ onError, onAuthError, onNotice }: { onError: (e: unknown) => void; onAuthError: () => void; onNotice: (text: string) => void }) {
  const [apps, setApps] = useState<TvRunningApp[] | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const load = useCallback(
    () =>
      getTvRunning()
        .then(setApps)
        .catch((e) => {
          if (e instanceof AuthError) onAuthError(); // other errors: keep what was shown, try again at the next round
        }),
    [onAuthError],
  );
  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const close = async (which: string[] | "all", id: string) => {
    setClosing(id);
    try {
      const closed = await closeTvApps(which);
      onNotice(closed.length === 0 ? "Nothing to close" : closed.length === 1 ? "Closed 1 app" : `Closed ${closed.length} apps`);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else onError(e);
    } finally {
      setClosing(null);
      void load();
    }
  };

  if (!apps) return null;
  return (
    <section className="vcard" aria-labelledby="tv-running-title">
      <div className="tv-running-head">
        <h2 id="tv-running-title">Running apps</h2>
        <button type="button" className="tv-close-all" disabled={apps.length === 0 || closing !== null} onClick={() => void close("all", "all")}>
          {closing === "all" ? "Closing…" : "Close all"}
        </button>
      </div>
      {apps.length === 0 ? (
        <p className="hint tv-keys-hint">Nothing extra is running.</p>
      ) : (
        <ul className="tv-running">
          {apps.map((a) => (
            <li key={a.package}>
              <div>
                <p>{a.label}</p>
                <p className="tv-running-meta">
                  {a.memoryMb} MB{a.helper ? ", background service" : ""}
                </p>
              </div>
              <button type="button" disabled={closing !== null} onClick={() => void close([a.package], a.package)} aria-label={`Close ${a.label}`}>
                {closing === a.package ? "Closing…" : "Close"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint tv-keys-hint">Closing stops the app, like Force stop in the settings. The launcher, the system and this remote are never closed.</p>
    </section>
  );
}

const NUMBERS: TvKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const COLOURS: Array<[TvKey, string]> = [["red", "Red"], ["green", "Green"], ["yellow", "Yellow"], ["blue", "Blue"]];
const OTHERS: Array<[TvKey, string]> = [["info", "Info"], ["menu", "Menu"], ["settings", "Settings"], ["search", "Search"], ["captions", "Subtitles"], ["tv", "Live TV"]];

function MoreKeys({ ready, press, adb }: { ready: boolean; press: (key: TvKey) => void; adb: boolean }) {
  const plain = (key: TvKey, label: string, className?: string) => (
    <Key key={key} k={key} label={label} press={press} disabled={!ready} className={className}>
      <span>{label}</span>
    </Key>
  );
  return (
    <section className="vcard tv-more">
      <details>
        <summary>More keys</summary>
        <div className="tv-more-body">
          {/* with ADB the Sources card does this properly; without it these keys are the only try, and many TVs ignore them */}
          {!adb && (
            <>
              <h3>Source keys (not every TV takes them)</h3>
              <div className="tv-row tv-row-4">{(["hdmi1", "hdmi2", "hdmi3", "hdmi4"] as TvKey[]).map((k, i) => plain(k, `HDMI ${i + 1}`))}</div>
            </>
          )}
          <h3>Numbers</h3>
          <div className="tv-numbers">{NUMBERS.map((k) => plain(k, k))}{plain("backspace", "Delete")}</div>
          <h3>Colour keys</h3>
          <div className="tv-row tv-row-4">{COLOURS.map(([k, label]) => plain(k, label, `tv-colour tv-${k}`))}</div>
          <h3>Others</h3>
          <div className="tv-others">{OTHERS.map(([k, label]) => plain(k, label))}</div>
        </div>
      </details>
    </section>
  );
}

// ---------- pairing ----------
function Pairing({ state, onChange, onError, onDone }: { state: TvState; onChange: () => void; onError: (e: unknown) => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const waiting = state.waitingForCode === true;
  useEffect(() => {
    if (waiting) input.current?.focus();
  }, [waiting]);

  const start = async () => {
    setBusy(true);
    setProblem("");
    try {
      await startTvPairing();
      onChange();
    } catch (e) {
      if (e instanceof AuthError) onError(e);
      else setProblem(e instanceof Error ? e.message : "Couldn't start pairing");
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setProblem("");
    try {
      await sendTvCode(code.trim());
      setCode("");
      onDone();
      onChange();
    } catch (e) {
      if (e instanceof AuthError) onError(e);
      else setProblem(e instanceof Error ? e.message : "Couldn't pair");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="vcard tv-pairing" aria-labelledby="pair-title">
      <h2 id="pair-title">Pair with the TV</h2>
      <ol className="pair-steps">
        <li>Turn the TV on.</li>
        <li>Press the button: the TV shows a code of six characters.</li>
        <li>Type the code here. This is needed once.</li>
      </ol>
      {!waiting ? (
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
          {busy ? "Asking the TV…" : "Show the code on the TV"}
        </button>
      ) : (
        <form
          className="pair-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="tv-code">Code on the TV screen</label>
          <input
            id="tv-code"
            ref={input}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 6))}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={6}
            aria-describedby={problem ? "pair-problem" : undefined}
            aria-invalid={problem ? true : undefined}
          />
          <p className="hint">Digits and the letters A to F.</p>
          <div className="pair-actions">
            <button type="submit" className="primary" disabled={busy || !CODE_PATTERN.test(code)}>
              {busy ? "Pairing…" : "Pair"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCode("");
                setProblem("");
                void cancelTvPairing().then(onChange, onError);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <p className="pair-problem" id="pair-problem" role="alert">
        {problem}
      </p>
    </section>
  );
}
