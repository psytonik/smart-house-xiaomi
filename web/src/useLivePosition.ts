import { useEffect, useState } from "react";
import { AuthError, getVacuumLive, type VacuumLive } from "./api";

/** The robot's position and recent trail, refreshed every few seconds while `active` (the robot is moving). */
export function useLivePosition(active: boolean, onAuthError: () => void): VacuumLive | null {
  const [live, setLive] = useState<VacuumLive | null>(null);

  useEffect(() => {
    if (!active) {
      setLive(null);
      return;
    }
    let stopped = false;
    const load = () =>
      getVacuumLive()
        .then((v) => !stopped && setLive(v))
        .catch((e) => e instanceof AuthError && onAuthError()); // any other failure just means: no overlay this time
    load();
    const timer = setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, onAuthError]);

  return live;
}
