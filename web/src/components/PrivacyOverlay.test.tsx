import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Zone } from "../api";
import { PrivacyOverlay } from "./PrivacyOverlay";

afterEach(cleanup);
const zone = (over: Partial<Zone>): Zone => ({ id: "z", mode: "privacy", x: 0.1, y: 0.2, w: 0.3, h: 0.4, ...over });

describe("PrivacyOverlay", () => {
  it("paints one black block per privacy zone, placed by percentages of the picture", () => {
    const { container } = render(<PrivacyOverlay zones={[zone({}), zone({ id: "b", x: 0.6, y: 0, w: 0.4, h: 0.12 })]} />);
    const blocks = container.querySelectorAll<HTMLElement>(".privacy-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.style.left).toBe("10%");
    expect(blocks[0]!.style.top).toBe("20%");
    expect(blocks[0]!.style.width).toBe("30%");
    expect(blocks[0]!.style.height).toBe("40%");
    expect(blocks[1]!.style.left).toBe("60%");
  });

  it("ignores motion zones: they are not about what may be seen", () => {
    const { container } = render(<PrivacyOverlay zones={[zone({ mode: "ignore" }), zone({ id: "w", mode: "watch" })]} />);
    expect(container.querySelector(".privacy-layer")).toBeNull();
  });

  it("renders nothing without zones, and stays out of the way of the picture", () => {
    expect(render(<PrivacyOverlay zones={[]} />).container.firstChild).toBeNull();
    cleanup();
    const { container } = render(<PrivacyOverlay zones={[zone({})]} />);
    expect(container.querySelector(".privacy-layer")!.getAttribute("aria-hidden")).toBe("true");
  });
});
