import { afterEach, describe, expect, it, vi } from "vitest";
import { sendVacuumVolume, sendVacuumSwitch } from "./api";

const reply = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

describe("error messages from the server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says the server is older than the page when it doesn't know a route, instead of just 'Not Found'", async () => {
    reply(404, { message: "Route POST:/api/vacuum/volume not found", error: "Not Found", statusCode: 404 });
    await expect(sendVacuumVolume(40)).rejects.toThrow(/older than this page.*restart/i);
  });

  it("still passes on the reason the server gives for a refusal", async () => {
    reply(502, { error: "the vacuum kept its old setting instead of volume 40" });
    await expect(sendVacuumVolume(40)).rejects.toThrow("the vacuum kept its old setting instead of volume 40");
    reply(404, { error: "vacuum is not configured (set VACUUM_IP and VACUUM_TOKEN)" });
    await expect(sendVacuumSwitch("childLock", true)).rejects.toThrow("vacuum is not configured");
  });
});
