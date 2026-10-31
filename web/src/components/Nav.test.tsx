import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Nav } from "./Nav";

afterEach(cleanup);

describe("Nav", () => {
  it("links to every page and marks the current one", () => {
    render(<Nav current="lights" />);
    expect(screen.getByRole("link", { name: "Camera" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Vacuum" }).getAttribute("href")).toBe("/vacuum");
    expect(screen.getByRole("link", { name: "TV" }).getAttribute("href")).toBe("/tv");
    expect(screen.getByRole("link", { name: "Lights" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Camera" }).getAttribute("aria-current")).toBeNull();
  });

  it("switches page without reloading", () => {
    render(<Nav current="camera" />);
    fireEvent.click(screen.getByRole("link", { name: "Lights" }));
    expect(window.location.pathname).toBe("/lights");
  });
});
