import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { KEYS } from "../src/tv/messages.js";
import { startFakeTv } from "./fakeTv.js";
import { testConfig } from "./helpers.js";

const API = "t".repeat(24);
const auth = { authorization: `Bearer ${API}` };
const until = async (what: string, test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("TV API (pretend TV)", () => {
  let tv: Awaited<ReturnType<typeof startFakeTv>>;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const saved = { ...process.env };
  const get = async () => (await app.inject({ url: "/api/tv", headers: auth })).json();
  const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers: auth, payload });

  before(async () => {
    tv = await startFakeTv();
    dir = mkdtempSync(join(tmpdir(), "tv-api-"));
    process.env.TV_IP = "127.0.0.1";
    process.env.TV_REMOTE_PORT = String(tv.remotePort);
    process.env.TV_PAIRING_PORT = String(tv.pairingPort);
    app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
  });
  after(async () => {
    await app.close();
    await tv.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ["TV_IP", "TV_REMOTE_PORT", "TV_PAIRING_PORT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("needs the API token like everything else", async () => {
    assert.equal((await app.inject({ url: "/api/tv" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/tv/key", payload: { key: "up" } })).statusCode, 401);
  });

  it("starts unpaired and offers the apps it can open", async () => {
    const s = await get();
    assert.equal(s.configured, true);
    assert.equal(s.paired, false);
    assert.equal(s.link, "offline");
    assert.deepEqual(s.apps.map((a: { id: string }) => a.id), ["youtube", "netflix", "prime", "disney", "twitch"], "an app that needs ADB is not offered without it");
    assert.equal((await post("/api/tv/key", { key: "up" })).statusCode, 503, "not paired: the TV is not answering");
    assert.equal((await post("/api/tv/pair/code", { code: "123456" })).statusCode, 409, "pairing was not started");
  });

  it("pairs through the API, then keys and apps reach the TV", async () => {
    assert.equal((await post("/api/tv/pair")).statusCode, 200);
    assert.equal((await get()).waitingForCode, true);
    await until("the TV to show a code", () => tv.state.code !== undefined);
    assert.equal((await post("/api/tv/pair/code", { code: "000000" })).statusCode, 400, "a wrong code");
    assert.equal((await post("/api/tv/pair/code", { code: "12" })).statusCode, 400);
    assert.equal((await post("/api/tv/pair/code", { code: ` ${tv.state.code} ` })).statusCode, 200, "spaces around it are fine");

    await until("the remote to connect", () => tv.state.remoteConnections > 0);
    let s = await get();
    for (let i = 0; i < 100 && s.link !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 30));
      s = await get();
    }
    assert.equal(s.paired, true);
    assert.equal(s.link, "ready");
    assert.equal(s.powered, true);

    assert.equal((await post("/api/tv/key", { key: "volumeUp" })).statusCode, 200);
    assert.equal((await post("/api/tv/app", { app: "netflix" })).statusCode, 200);
    await until("the TV to get them", () => tv.state.keys.length === 1 && tv.state.links.length === 1);
    assert.deepEqual(tv.state.keys[0], { code: KEYS.volumeUp, direction: 3 });
    assert.deepEqual(tv.state.links, ["https://www.netflix.com/browse"]);
  });

  it("refuses keys and apps it doesn't know", async () => {
    for (const payload of [{}, { key: "format" }, { key: "" }, { key: "UP" }]) {
      assert.equal((await post("/api/tv/key", payload)).statusCode, 400, JSON.stringify(payload));
    }
    for (const payload of [{}, { app: "https://evil.example" }, { app: "" }]) {
      assert.equal((await post("/api/tv/app", payload)).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(tv.state.links.length, 1, "nothing else was sent to the TV");
  });
});

describe("TV API without a TV", () => {
  it("says it is not configured, and the commands answer 404", async () => {
    const saved = process.env.TV_IP;
    delete process.env.TV_IP;
    const dir = mkdtempSync(join(tmpdir(), "tv-none-"));
    const app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
    try {
      assert.deepEqual((await app.inject({ url: "/api/tv", headers: auth })).json(), { configured: false });
      assert.equal((await app.inject({ method: "POST", url: "/api/tv/key", headers: auth, payload: { key: "up" } })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/tv/pair", headers: auth, payload: {} })).statusCode, 404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      if (saved !== undefined) process.env.TV_IP = saved;
    }
  });

  it("is switched off, not broken, by a setting that makes no sense", async () => {
    const saved = process.env.TV_IP;
    process.env.TV_IP = "not an address!";
    const dir = mkdtempSync(join(tmpdir(), "tv-bad-"));
    const app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
    try {
      assert.deepEqual((await app.inject({ url: "/api/tv", headers: auth })).json(), { configured: false });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.TV_IP;
      else process.env.TV_IP = saved;
    }
  });
});

describe("TV API with ADB (pretend TV and adb)", () => {
  let tv: Awaited<ReturnType<typeof startFakeTv>>;
  let dir: string;
  let log: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const saved = { ...process.env };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers: auth, payload });

  before(async () => {
    tv = await startFakeTv();
    dir = mkdtempSync(join(tmpdir(), "tv-adb-api-"));
    log = join(dir, "calls.log");
    const dump = [
      "    1413742848: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413742848, type=2, audio_addr=1}",
      "    1413744128: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413744128, type=9, audio_addr=1, hdmi_port=1}",
      "  mHardwareInputIdMap: deviceId -> inputId",
      "    1413742848: com.tcl.tvinput/.TDTVInputService/HW1413742848",
      "    1413744128: com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413744128",
    ].join("\n");
    writeFileSync(join(dir, "dump.txt"), dump);
    const adb = join(dir, "adb");
    writeFileSync(adb, `#!/bin/sh\nif [ "$1" = "connect" ]; then echo "connected to $2"; exit 0; fi\nif [ "$4" = "dumpsys" ]; then cat "${dir}/dump.txt"; exit 0; fi\nif [ "$4" = "pm" ]; then exit 0; fi\necho "$@" >> "${log}"\n`);
    chmodSync(adb, 0o755);
    process.env.TV_IP = "127.0.0.1";
    process.env.TV_REMOTE_PORT = String(tv.remotePort);
    process.env.TV_PAIRING_PORT = String(tv.pairingPort);
    process.env.TV_ADB = "10.0.0.9:5555";
    process.env.TV_ADB_PATH = adb;
    app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
  });
  after(async () => {
    await app.close();
    await tv.close();
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("says ADB is available, and what sources the TV has", async () => {
    assert.equal((await app.inject({ url: "/api/tv", headers: auth })).json().adb, true);
    const res = await app.inject({ url: "/api/tv/sources", headers: auth });
    assert.deepEqual(res.json().sources, [{ id: "home", label: "Home" }, { id: "tv", label: "TV" }, { id: "hdmi1", label: "HDMI 1" }]);
    assert.equal((await app.inject({ url: "/api/tv/sources" })).statusCode, 401);
  });

  it("opens Source Choice from the Input key, even when the remote link is not up", async () => {
    assert.equal((await post("/api/tv/key", { key: "input" })).statusCode, 200);
    assert.deepEqual(calls(), ["-s 10.0.0.9:5555 shell input keyevent 178"]);
    assert.equal((await post("/api/tv/key", { key: "up" })).statusCode, 503, "other keys still go over the remote protocol, which is not paired here");
  });

  it("lists Prisma as an app and opens it over ADB", async () => {
    const apps = (await app.inject({ url: "/api/tv", headers: auth })).json().apps as Array<{ id: string; label: string }>;
    assert.deepEqual(apps.map((a) => a.id), ["youtube", "netflix", "prime", "disney", "twitch", "prisma"]);
    assert.equal(apps.at(-1)!.label, "Prisma");
    assert.equal((await post("/api/tv/app", { app: "prisma" })).statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell am start -n top.rootu.prisma/.ConnectActivity");
  });

  it("switches to a source, and refuses one that doesn't exist", async () => {
    assert.equal((await post("/api/tv/source", { source: "hdmi1" })).statusCode, 200);
    assert.ok(calls().at(-1)!.includes("passthrough/com.tcl.tvinput%2F.passthroughinput.TvPassThroughService%2FHW1413744128"));
    const before = calls().length;
    assert.equal((await post("/api/tv/source", { source: "hdmi4" })).statusCode, 400);
    for (const bad of [{}, { source: "" }, { source: "HDMI1" }, { source: "a b" }, { source: "x;reboot" }]) assert.equal((await post("/api/tv/source", bad)).statusCode, 400, JSON.stringify(bad));
    assert.equal(calls().length, before, "nothing was sent for a bad source");
  });
});

describe("TV API with ADB set but unusable", () => {
  it("leaves ADB off and the Input key as it was", async () => {
    const saved = { ...process.env };
    process.env.TV_IP = "127.0.0.1";
    process.env.TV_ADB = "10.0.0.9:5555";
    process.env.TV_ADB_PATH = "/no/such/adb";
    const dir = mkdtempSync(join(tmpdir(), "tv-adb-off-"));
    const app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
    try {
      assert.equal((await app.inject({ url: "/api/tv", headers: auth })).json().adb, false);
      assert.equal((await app.inject({ url: "/api/tv/sources", headers: auth })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/tv/source", headers: auth, payload: { source: "tv" } })).statusCode, 404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      process.env = { ...saved };
    }
  });
});
