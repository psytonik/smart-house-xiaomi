import { useEffect, useState, type MouseEvent } from "react";

export type Route = "camera" | "vacuum" | "lights" | "tv" | "devices";

export const ROUTES: Array<{ id: Route; label: string; href: string }> = [
  { id: "camera", label: "Camera", href: "/" },
  { id: "vacuum", label: "Vacuum", href: "/vacuum" },
  { id: "lights", label: "Lights", href: "/lights" },
  { id: "tv", label: "TV", href: "/tv" },
  { id: "devices", label: "Devices", href: "/devices" },
];

/** Which page an address belongs to. Anything unknown falls back to the camera. */
export function parseRoute(path: string): Route {
  if (path === "/vacuum") return "vacuum";
  if (path === "/lights") return "lights";
  if (path === "/tv") return "tv";
  if (path === "/devices") return "devices";
  return "camera";
}

/** Click handler for in-app links: a plain click changes page without a reload; new-tab clicks keep working. */
export function followLink(e: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(href);
}

const CHANGED = "routechange";

/** Go to another page without reloading, keeping the back button working. */
export function navigate(href: string): void {
  if (href === window.location.pathname) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(CHANGED));
}

/** The page for the current address, kept in step with links and the back button. */
export function useRoute(): Route {
  const [path, setPath] = useState(() => {
    // Old bookmarks looked like /#/vacuum.
    const old = window.location.hash.replace(/^#/, "");
    if (old === "/vacuum" || old === "/lights" || old === "/tv" || old === "/devices") window.history.replaceState(null, "", old);
    return window.location.pathname;
  });
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    window.addEventListener(CHANGED, on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener(CHANGED, on);
    };
  }, []);
  return parseRoute(path);
}
