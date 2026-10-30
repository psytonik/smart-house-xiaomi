import { describe, expect, it } from "vitest";
import { CORNER_PRESETS, cornerZone, nextZoneId, rectFromDrag } from "./zones";

describe("rectFromDrag", () => {
  it("turns two corners into a rectangle, whichever way it was dragged", () => {
    const expected = { x: 0.2, y: 0.1, w: 0.3, h: 0.4 };
    expect(rectFromDrag({ x: 0.2, y: 0.1 }, { x: 0.5, y: 0.5 })).toEqual(expected);
    expect(rectFromDrag({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.1 })).toEqual(expected);
    expect(rectFromDrag({ x: 0.5, y: 0.1 }, { x: 0.2, y: 0.5 })).toEqual(expected);
  });

  it("clamps to the picture when the pointer leaves it", () => {
    expect(rectFromDrag({ x: 0.8, y: 0.8 }, { x: 1.4, y: 1.3 })).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(rectFromDrag({ x: 0.2, y: 0.2 }, { x: -0.5, y: -0.5 })).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
  });

  it("returns null for a click or a sliver that the server would refuse", () => {
    expect(rectFromDrag({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 })).toBeNull();
    expect(rectFromDrag({ x: 0.3, y: 0.3 }, { x: 0.305, y: 0.6 })).toBeNull();
  });

  it("rounds like the server does, so what is shown is what is saved", () => {
    expect(rectFromDrag({ x: 0.123456, y: 0.1 }, { x: 0.5, y: 0.5 })?.x).toBe(0.1235);
  });
});

describe("presets and ids", () => {
  it("each corner preset is a valid rectangle inside the picture", () => {
    for (const corner of CORNER_PRESETS) {
      const z = cornerZone(corner.id, "ignore", "z");
      expect(z.x).toBeGreaterThanOrEqual(0);
      expect(z.y).toBeGreaterThanOrEqual(0);
      expect(z.x + z.w).toBeLessThanOrEqual(1);
      expect(z.y + z.h).toBeLessThanOrEqual(1);
      expect(z.w).toBeGreaterThanOrEqual(0.01);
    }
  });

  it("the top right preset sits in the top right corner (where cameras print the time)", () => {
    const z = cornerZone("top-right", "ignore", "z");
    expect(z.x + z.w).toBe(1);
    expect(z.y).toBe(0);
  });

  it("makes ids that do not clash with existing zones", () => {
    expect(nextZoneId([])).toBe("zone-1");
    expect(nextZoneId([{ id: "zone-1" }, { id: "zone-3" }])).toBe("zone-4");
    expect(nextZoneId([{ id: "clock" }])).toBe("zone-1");
  });
});
