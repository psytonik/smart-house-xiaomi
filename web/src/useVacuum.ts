import { useCallback, useEffect, useState } from "react";
import { AuthError, getVacuum, sendCleaningMode, sendVacuum, type CleaningMode, type VacuumAction, type VacuumState } from "./api";

/** The vacuum's state (refreshed every 10 s) and a way to send it a command. Shared by the card and the page. */
export function useVacuum(onAuthError: () => void, onError: (e: unknown) => void) {
  const [state, setState] = useState<VacuumState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getVacuum()
      .then(setState)
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
        else setState({ configured: true, reachable: false });
      });
  }, [onAuthError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (action: VacuumAction) => {
      setBusy(true);
      try {
        await sendVacuum(action);
        window.setTimeout(load, 1500); // the robot takes a moment to change its status
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else onError(e);
      } finally {
        setBusy(false);
      }
    },
    [load, onAuthError, onError],
  );

  const setMode = useCallback(
    async (mode: CleaningMode) => {
      setBusy(true);
      try {
        await sendCleaningMode(mode);
        load();
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else onError(e);
      } finally {
        setBusy(false);
      }
    },
    [load, onAuthError, onError],
  );

  return { state, busy, act, setMode, reload: load };
}
