import { useCallback, useEffect, useState } from "react";
import { AuthError, getVacuum, sendCleaningMode, sendSuction, sendVacuum, sendWater, type CleaningMode, type SuctionLevel, type VacuumAction, type VacuumState, type WaterLevel } from "./api";

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

  /** Suction or water. The answer says why when the robot didn't take it (Customized Cleaning), and the page shows what the robot really has. */
  const setLevel = useCallback(
    async (kind: "suction" | "water", level: SuctionLevel | WaterLevel) => {
      setBusy(true);
      try {
        await (kind === "suction" ? sendSuction(level as SuctionLevel) : sendWater(level as WaterLevel));
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else onError(e);
      } finally {
        setBusy(false);
        load();
      }
    },
    [load, onAuthError, onError],
  );

  return { state, busy, act, setMode, setLevel, reload: load };
}
