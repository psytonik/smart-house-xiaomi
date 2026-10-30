import { describe, expect, it } from "vitest";
import { TALK_MAX_MS, talkBlockedReason } from "./talk";

describe("talkBlockedReason", () => {
  it("lets you talk on a secure page with a microphone API", () => {
    expect(talkBlockedReason({ secure: true, hasMic: true })).toBeNull();
  });

  it("explains that browsers only give the microphone to HTTPS pages or localhost", () => {
    expect(talkBlockedReason({ secure: false, hasMic: false })).toMatch(/HTTPS|localhost/);
    expect(talkBlockedReason({ secure: false, hasMic: true })).toMatch(/HTTPS|localhost/);
  });

  it("says so when the browser has no microphone API at all", () => {
    expect(talkBlockedReason({ secure: true, hasMic: false })).toMatch(/microphone/i);
  });
});

describe("TALK_MAX_MS", () => {
  it("closes the microphone by itself after a minute at most", () => {
    expect(TALK_MAX_MS).toBeGreaterThan(0);
    expect(TALK_MAX_MS).toBeLessThanOrEqual(60_000);
  });
});
