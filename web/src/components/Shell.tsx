import type { ReactNode } from "react";
import { followLink, type Route } from "../route";
import { Nav } from "./Nav";

/** The frame every page shares: brand, page tabs and sign out stay in the same place on every page. */
export function Shell({ current, onLogout, live = false, children }: { current: Route; onLogout: () => void; live?: boolean; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => followLink(e, "/")}>
          <span className={`tally${live ? " on" : ""}`} aria-hidden="true" />
          psytonik base
        </a>
        <Nav current={current} />
        <button type="button" className="quiet" onClick={onLogout}>
          Sign out
        </button>
      </header>
      {children}
    </div>
  );
}
