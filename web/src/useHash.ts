import { useEffect, useState } from "react";

/** The part of the address after "#", kept in step with the back button. Lets a page have its own link without a router. */
export function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}
