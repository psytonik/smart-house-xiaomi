import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "zones-api-test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const stamp = { id: "stamp", mode: "ignore", x: 0.6, y: 0, w: 0.4, h: 0.12 };

describe("zones API", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const make = () =>
    buildApp(loadConfig({ API_TOKEN: TOKEN, DATA_DIR: dir, PUBLIC_DIR: join(dir, "none"), MOTION_ENABLED: "false", GO2RTC_URL: "http://127.0.0.1:1" }));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cam-zonesapi-"));
    app = await make();
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (payload: unknown, headers: Record<string, string> = auth) => app.inject({ method: "PUT", url: "/api/zones", headers, payload: payload as object });

  it("needs the API token", async () => {
    assert.equal((await app.inject("/api/zones")).statusCode, 401);
    assert.equal((await put({ zones: [] }, {})).statusCode, 401);
  });

  it("starts without zones", async () => {
    assert.deepEqual((await app.inject({ url: "/api/zones", headers: auth })).json(), { zones: [] });
  });

  it("replaces the whole list, normalises it and keeps it on disk", async () => {
    const res = await put({ zones: [{ ...stamp, x: 0.600001, extra: 1 }] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { zones: [stamp] });
    assert.deepEqual((await app.inject({ url: "/api/zones", headers: auth })).json(), { zones: [stamp] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "zones.json"), "utf8")), { zones: [stamp] });
  });

  it("survives a restart", async () => {
    await app.close();
    app = await make();
    assert.deepEqual((await app.inject({ url: "/api/zones", headers: auth })).json(), { zones: [stamp] });
  });

  it("rejects bad zones with a reason and keeps the old ones", async () => {
    for (const body of [{}, { zones: "no" }, { zones: [{ ...stamp, w: 2 }] }, { zones: [{ ...stamp, mode: "hide" }] }, { zones: [stamp, stamp] }]) {
      const res = await put(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.ok(res.json().error);
    }
    assert.deepEqual((await app.inject({ url: "/api/zones", headers: auth })).json(), { zones: [stamp] });
  });

  it("an empty list clears the zones", async () => {
    assert.equal((await put({ zones: [] })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: "/api/zones", headers: auth })).json(), { zones: [] });
  });

  it("the motion status carries the threshold for the live level bar", async () => {
    const body = (await app.inject({ url: "/api/motion", headers: auth })).json();
    assert.equal(body.threshold, 1.2);
  });
});
