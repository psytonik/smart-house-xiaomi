import { describe, expect, it } from "vitest";
import { STREAM_NAME, regionLabel, streamName } from "./cameras";

describe("streamName", () => {
  it("makes a go2rtc-safe name out of the camera's name", () => {
    expect(streamName("Living room", [])).toBe("living-room");
    expect(streamName("  Kid's  Room (2K)! ", [])).toBe("kid-s-room-2k");
  });

  it("falls back when nothing usable is left, e.g. a name written in Cyrillic", () => {
    expect(streamName("Гостиная", [])).toBe("camera");
    expect(streamName("!!!", [])).toBe("camera");
  });

  it("never returns a taken name: a number is added", () => {
    expect(streamName("Living room", ["living-room"])).toBe("living-room-2");
    expect(streamName("Living room", ["living-room", "living-room-2"])).toBe("living-room-3");
  });

  it("every result passes the backend's rule, also for very long names", () => {
    for (const n of ["Living room", "Гостиная", "x".repeat(100), "a-".repeat(50), "9 lives"]) {
      expect(STREAM_NAME.test(streamName(n, []))).toBe(true);
    }
    expect(streamName("x".repeat(100), ["x".repeat(36)]).length).toBeLessThanOrEqual(40);
  });
});

describe("regionLabel", () => {
  it("names the regions people know and keeps an unknown code as it is", () => {
    expect(regionLabel("de")).toBe("Europe");
    expect(regionLabel("zz")).toBe("zz");
  });
});
