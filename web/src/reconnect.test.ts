import { describe, expect, it } from "vitest";
import { MAX_AUTO_RECONNECTS, reconnectDelay } from "./reconnect";

describe("reconnectDelay", () => {
  it("backs off exponentially from one second and caps at fifteen", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it("gives up after a few automatic attempts so the user sees the error and the manual retry", () => {
    expect(MAX_AUTO_RECONNECTS).toBeGreaterThanOrEqual(3);
    expect(MAX_AUTO_RECONNECTS).toBeLessThanOrEqual(8);
  });
});
