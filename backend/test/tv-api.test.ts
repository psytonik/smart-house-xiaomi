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
      "  mCurrentFocus=Window{32292ae u0 top.rootu.prisma/com.brouken.player.PlayerActivity}",
    ].join("\n");
    writeFileSync(join(dir, "dump.txt"), dump);
    writeFileSync(join(dir, "ps.txt"), "USER PID RSS NAME\nu0_a104 1 50000 top.rootu.prisma\nu0_a56 2 38000 com.google.android.apps.mediashell\nu0_a102 3 40000 com.gathin.tvhome\n");
    writeFileSync(join(dir, "launchers.txt"), "  top.rootu.prisma/.ConnectActivity\n  com.gathin.tvhome/.MainActivity\n");
    const adb = join(dir, "adb");
    writeFileSync(adb, `#!/bin/sh\nif [ "$1" = "connect" ]; then echo "connected to $2"; exit 0; fi\nif [ "$4" = "dumpsys" ]; then cat "${dir}/dump.txt"; exit 0; fi\nif [ "$4" = "pm" ]; then exit 0; fi\nif [ "$4" = "ps" ]; then cat "${dir}/ps.txt"; exit 0; fi\nif [ "$4" = "cmd" ]; then cat "${dir}/launchers.txt"; exit 0; fi\necho "$@" >> "${log}"\n`);
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

  it("sends an arrow over ADB when asked (inside apps that ignore the remote protocol)", async () => {
    assert.equal((await post("/api/tv/key", { key: "right", adb: true })).statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell input keyevent 22");
  });

  it("types digits over ADB (the channel number in Prisma's IPTV player)", async () => {
    const ok = await post("/api/tv/keys", { keys: [{ key: "1" }, { key: "5" }] });
    assert.equal(ok.statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell input keyevent 8 0 0 12 0 0");
    assert.equal((await post("/api/tv/keys", { keys: [{ key: "10" }] })).statusCode, 400);
  });

  it("sends a run of keys in one adb command, and only known keys", async () => {
    const ok = await post("/api/tv/keys", { keys: [{ key: "down" }, { key: "right", times: 2 }, { key: "ok" }] });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().pressed, 4);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell input keyevent 20 0 0 0 0 0 0 0 0 22 0 0 22 0 0 0 0 0 0 23 0 0");
    assert.equal((await post("/api/tv/keys", { keys: [{ key: "power" }] })).statusCode, 400, "only arrows, OK and back");
    assert.equal((await post("/api/tv/keys", { keys: [{ key: "ok; reboot" }] })).statusCode, 400);
  });

  it("opens Prisma's search with a text by an intent, quoted for the TV's shell, and refuses anything that could break out of the quotes", async () => {
    const ok = await post("/api/tv/prisma/search", { query: "Брат 2" });
    assert.equal(ok.statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell am start -n top.rootu.prisma/.MainActivity --es query 'Брат 2'");
    for (const bad of ["a'; reboot; '", "$(reboot)", "a`b", "a\nb", "a&b", "a|b", "", "x".repeat(61)]) {
      assert.equal((await post("/api/tv/prisma/search", { query: bad })).statusCode, 400, JSON.stringify(bad));
    }
  });

  it("says which window is in front (so the assistant does not press keys into a player that has already started)", async () => {
    const res = await app.inject({ url: "/api/tv/foreground", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { window: "top.rootu.prisma/com.brouken.player.PlayerActivity" });
    assert.equal((await app.inject({ url: "/api/tv/foreground" })).statusCode, 401);
  });

  it("lists Prisma as an app and opens it over ADB", async () => {
    const apps = (await app.inject({ url: "/api/tv", headers: auth })).json().apps as Array<{ id: string; label: string }>;
    assert.deepEqual(apps.map((a) => a.id), ["youtube", "netflix", "prime", "disney", "twitch", "prisma", "ottplay"]);
    assert.equal(apps.find((a) => a.id === "prisma")!.label, "Prisma");
    assert.equal((await post("/api/tv/app", { app: "prisma" })).statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell am start -n top.rootu.prisma/.ConnectActivity");
    assert.equal((await post("/api/tv/app", { app: "ottplay" })).statusCode, 200);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell am start -n com.ott_play/com.ottplay.ott_play.MainActivity");
  });

  it("lists the running apps and closes them one by one or all together, never the launcher", async () => {
    const running = (await app.inject({ url: "/api/tv/running", headers: auth })).json().apps as Array<{ package: string; label: string; helper: boolean; memoryMb: number }>;
    assert.deepEqual(running.map((a) => [a.package, a.label, a.helper]), [["top.rootu.prisma", "Prisma", false], ["com.google.android.apps.mediashell", "Chromecast receiver", true]]);
    assert.equal((await app.inject({ url: "/api/tv/running" })).statusCode, 401);

    const one = await post("/api/tv/running/close", { packages: ["top.rootu.prisma", "com.gathin.tvhome"] });
    assert.deepEqual(one.json().closed, ["top.rootu.prisma"]);
    assert.equal(calls().at(-1), "-s 10.0.0.9:5555 shell am force-stop top.rootu.prisma");

    const all = await post("/api/tv/running/close", { all: true });
    assert.deepEqual(all.json().closed, ["top.rootu.prisma", "com.google.android.apps.mediashell"]);
    assert.ok(!calls().some((c) => c.includes("com.gathin.tvhome")), "the launcher was never touched");

    const before = calls().length;
    for (const bad of [{}, { packages: [] }, { packages: ["x; reboot"] }, { packages: "top.rootu.prisma;reboot" }, { all: "yes" }]) assert.equal((await post("/api/tv/running/close", bad)).statusCode, 400, JSON.stringify(bad));
    assert.equal(calls().length, before, "nothing was stopped for a bad request");
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
      assert.equal((await app.inject({ url: "/api/tv/running", headers: auth })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/tv/running/close", headers: auth, payload: { all: true } })).statusCode, 404);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      process.env = { ...saved };
    }
  });
});
