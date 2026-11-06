import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AuthError } from "../api";
import { afterWakeWord, askAssistant, assistantConfigured, homeFromGps, homePlace, piperVoices, recognitionCtor, rememberPhrase, russianVoices, speak, stopSpeaking, suggestions, teachPhrase, voiceChoice, wakeMode, type PiperVoice, type Recognition, type Suggestion, type Turn } from "../assistant";

type Phase = "idle" | "listening" | "thinking";

/** A microphone button on every page: say what you want, the assistant does it and answers out loud. */
export function Voice({ onAuthLost }: { onAuthLost: () => void }) {
  const [configured, setConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [teachable, setTeachable] = useState(false);
  const [taught, setTaught] = useState(false);
  const [ideas, setIdeas] = useState<Suggestion[]>([]);
  const lastPhrase = useRef("");
  const history = useRef<Turn[]>([]);
  const rec = useRef<Recognition | null>(null);
  const canListen = recognitionCtor() !== undefined;
  const [home, setHome] = useState("");
  const [always, setAlways] = useState(wakeMode.get);
  const [speaking, setSpeaking] = useState(false);
  const speechRun = useRef(0);
  /** Until when the next phrase is a command, after the wake word was said on its own. */
  const awaiting = useRef(0);
  const [voices, setVoices] = useState<string[]>([]);
  const [piper, setPiper] = useState<PiperVoice[]>([]);
  const [voice, setVoice] = useState(voiceChoice.get);
  const [rate, setRate] = useState(voiceChoice.rate);

  // The browser fills its voice list a moment after the page opens, and again when a voice is installed.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const read = () => setVoices(russianVoices().map((v) => v.name));
    read();
    window.speechSynthesis.addEventListener("voiceschanged", read);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", read);
  }, []);

  useEffect(() => {
    let live = true;
    void assistantConfigured().then((ok) => live && setConfigured(ok));
    void piperVoices().then((v) => live && setPiper(v));
    return () => {
      live = false;
    };
  }, []);

  // What the journal says the person meant, offered each time the panel opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void homePlace().then((h) => live && setHome(h.set ? (h.name ?? "по GPS") : ""));
    void suggestions().then((s) => live && setIdeas(s));
    return () => {
      live = false;
    };
  }, [open]);

  const ask = useCallback(
    async (text: string) => {
      setHeard(text);
      setReply("");
      setError("");
      setTeachable(false);
      setTaught(false);
      lastPhrase.current = text;
      setPhase("thinking");
      try {
        const answer = await askAssistant(text, history.current);
        history.current = [...history.current, { role: "user" as const, content: text }, { role: "assistant" as const, content: answer.reply }].slice(-8);
        setReply(answer.reply);
        setTeachable(answer.learnable === true);
        setTaught(answer.learned === true);
        const run = ++speechRun.current;
        setSpeaking(true);
        void speak(answer.reply).then(() => {
          if (run === speechRun.current) setSpeaking(false);
        });
      } catch (e) {
        if (e instanceof AuthError) return onAuthLost();
        setError(e instanceof Error ? e.message : "the assistant failed");
      } finally {
        setPhase("idle");
      }
    },
    [onAuthLost],
  );

  const listen = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    stopSpeaking();
    const r = new Ctor();
    r.lang = "ru-RU";
    r.interimResults = true;
    r.continuous = false;
    let final = "";
    r.onresult = (e) => {
      const parts = Array.from(e.results).map((x) => ({ text: x[0]?.transcript ?? "", final: x.isFinal }));
      final = parts.filter((p) => p.final).map((p) => p.text).join(" ").trim();
      setHeard(parts.map((p) => p.text).join(" ").trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("The browser has no access to the microphone. Allow it in the address bar.");
      else if (e.error !== "no-speech" && e.error !== "aborted") setError(`Speech recognition failed (${e.error}).`);
    };
    r.onend = () => {
      rec.current = null;
      if (final) void ask(final);
      else setPhase("idle");
    };
    rec.current = r;
    setHeard("");
    setReply("");
    setError("");
    setPhase("listening");
    r.start();
  }, [ask]);

  useEffect(() => () => rec.current?.stop(), []);

  const askRef = useRef(ask);
  askRef.current = ask;

  // "Always listening": the microphone stays open and only phrases that start with the wake word are acted on.
  // It pauses while a command is being understood and while the answer is spoken, so the house does not hear itself.
  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!always || !Ctor || !configured || phase !== "idle" || speaking) return;
    let stopped = false;
    let current: Recognition | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (stopped) return;
      const r = new Ctor();
      r.lang = "ru-RU";
      r.interimResults = false;
      r.continuous = true;
      let seen = 0;
      r.onresult = (e) => {
        const parts = Array.from(e.results).slice(seen);
        seen += parts.length;
        for (const part of parts) {
          const text = (part[0]?.transcript ?? "").trim();
          const command = afterWakeWord(text);
          if (command === null) {
            setHeard(`Слышу: «${text}» (без «Капара»)`);
            // Not for the house, unless the wake word was the whole previous phrase.
            if (Date.now() < awaiting.current && text) {
              awaiting.current = 0;
              setOpen(true);
              void askRef.current(text);
              return;
            }
            continue;
          }
          setOpen(true);
          if (command === "") {
            awaiting.current = Date.now() + 8000;
            setError("");
            setHeard("Слушаю команду…");
            continue;
          }
          awaiting.current = 0;
          void askRef.current(command);
          return;
        }
      };
      r.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setError("The browser has no access to the microphone. Allow it in the address bar.");
          stopped = true;
          wakeMode.set(false);
          setAlways(false);
        }
      };
      r.onend = () => {
        current = null;
        // The browser ends a continuous session now and then (silence, a network blip): open the next one.
        if (!stopped) timer = setTimeout(start, 400);
      };
      current = r;
      try {
        r.start();
      } catch {
        current = null;
        timer = setTimeout(start, 1000);
      }
    };
    start();

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (current) {
        current.onend = null;
        current.stop();
      }
    };
  }, [always, configured, phase, speaking]);

  if (!configured) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text || phase === "thinking") return;
    setTyped("");
    void ask(text);
  };

  return (
    <div className="voice">
      {open && (
        <div className="voice-panel" role="dialog" aria-label="Voice assistant">
          <p className="voice-heard" aria-live="polite">
            {heard || (phase === "listening" ? "Listening…" : canListen ? "Press the microphone and speak" : "This browser can't listen: type instead")}
          </p>
          {phase === "thinking" && <p className="voice-note">Thinking…</p>}
          {reply && <p className="voice-reply">{reply}</p>}
          {teachable && !taught && (
            <button
              type="button"
              className="voice-remember"
              onClick={() => {
                void rememberPhrase(lastPhrase.current).then(
                  () => setTaught(true),
                  (e: unknown) => setError(e instanceof Error ? e.message : "could not remember"),
                );
              }}
            >
              Remember this phrase
            </button>
          )}
          {taught && <p className="voice-note">Запомнил: в следующий раз выполню сразу. Скажите «нет, не то» сразу после, и я забуду.</p>}
          {ideas.length > 0 && phase === "idle" && (
            <div className="voice-ideas">
              <p className="voice-note">Did you mean it? Teach it once:</p>
              {ideas.map((i) => (
                <button
                  key={i.phrase}
                  type="button"
                  className="voice-remember"
                  onClick={() => {
                    void teachPhrase(i.phrase).then(
                      () => setIdeas((all) => all.filter((x) => x.phrase !== i.phrase)),
                      (e: unknown) => setError(e instanceof Error ? e.message : "could not teach"),
                    );
                  }}
                >
                  «{i.phrase}» = «{i.becameText}»
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className="voice-error" role="alert">
              {error}
            </p>
          )}
          <div className="voice-home">
            <button
              type="button"
              className="voice-remember"
              onClick={() => {
                setError("");
                void homeFromGps().then(
                  () => setHome("по GPS"),
                  (e: unknown) => setError(e instanceof Error ? e.message : "could not find the location"),
                );
              }}
            >
              Определить по GPS
            </button>
            <span className="voice-note">{home ? `Дом: ${home}` : "Место дома не задано (для погоды)"}</span>
          </div>
          {canListen && (
            <label className="voice-wake">
              <input
                type="checkbox"
                checked={always}
                onChange={(e) => {
                  setAlways(e.target.checked);
                  wakeMode.set(e.target.checked);
                }}
              />
              Always listening: start with «Капара»
            </label>
          )}
          {(voices.length > 0 || piper.length > 0) && (
            <div className="voice-settings">
              <label>
                Voice
                <select
                  value={voice || piper[0]?.value || voices[0]}
                  onChange={(e) => {
                    setVoice(e.target.value);
                    voiceChoice.set(e.target.value);
                    speak("Привет, я голос вашего дома.");
                  }}
                >
                  {piper.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  {voices.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Speed
                <input
                  type="range"
                  min="0.6"
                  max="1.6"
                  step="0.1"
                  value={rate}
                  onChange={(e) => {
                    setRate(Number(e.target.value));
                    voiceChoice.setRate(Number(e.target.value));
                  }}
                  onPointerUp={() => speak("Так звучит скорость.")}
                />
              </label>
            </div>
          )}
          <form className="voice-type" onSubmit={submit}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="or type a command" aria-label="Command" maxLength={500} />
            <button type="submit" disabled={phase === "thinking" || !typed.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className={`voice-button${phase === "listening" ? " on" : always ? " wake" : ""}`}
        aria-label={phase === "listening" ? "Stop listening" : "Talk to the house"}
        aria-pressed={phase === "listening"}
        onClick={() => {
          setOpen(true);
          if (phase === "listening") rec.current?.stop();
          else if (phase === "idle" && canListen) listen();
        }}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
    </div>
  );
}
