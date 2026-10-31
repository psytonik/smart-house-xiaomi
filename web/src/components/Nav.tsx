import { ROUTES, followLink, type Route } from "../route";

const ICONS: Record<Route, string> = {
  camera: "M15 10.5 21 7v10l-6-3.5M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z",
  vacuum: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 3v3",
  tv: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM8 21h8M12 17v4",
  lights: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
};

/** The pages: tabs in the top bar on a wide screen, a tab bar along the bottom on a phone. */
export function Nav({ current }: { current: Route }) {
  return (
    <nav className="nav" aria-label="Pages">
      {ROUTES.map((r) => (
        <a key={r.id} href={r.href} aria-current={r.id === current ? "page" : undefined} onClick={(e) => followLink(e, r.href)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICONS[r.id]} />
          </svg>
          <span>{r.label}</span>
        </a>
      ))}
    </nav>
  );
}
