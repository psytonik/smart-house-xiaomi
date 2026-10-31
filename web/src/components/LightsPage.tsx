import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError } from "../api";
import { Lights } from "./Lights";
import { Shell } from "./Shell";

/** A page of its own for the lamps, reached at /lights. */
export function LightsPage({ onLogout }: { onLogout: () => void }) {
  const [toast, setToast] = useState("");
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onLogout();
      setToast(e instanceof Error ? e.message : "Something went wrong");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(""), 4000);
    },
    [onLogout],
  );

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const prev = document.title;
    document.title = "Lights";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <Shell current="lights" onLogout={onLogout}>
      <main className="vpage-main">
        <h1 className="page-title" ref={heading} tabIndex={-1}>
          Lights
        </h1>
        <Lights onAuthError={onLogout} onError={fail} />
      </main>
      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </Shell>
  );
}
