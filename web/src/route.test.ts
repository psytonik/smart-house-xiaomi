import { describe, expect, it } from "vitest";
import { parseRoute } from "./route";

describe("parseRoute", () => {
  it("gives each device its own page", () => {
    expect(parseRoute("/vacuum")).toBe("vacuum");
    expect(parseRoute("/lights")).toBe("lights");
  });
  it("falls back to the camera", () => {
    expect(parseRoute("")).toBe("camera");
    expect(parseRoute("/")).toBe("camera");
    expect(parseRoute("/nope")).toBe("camera");
  });
});
