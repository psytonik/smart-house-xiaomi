import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { MiioDevice } from "../src/miio.js";
import { Vacuum } from "../src/vacuum.js";
import { loadSession, saveSession, sessionPath } from "../src/xiaomiCloud.js";
import { cloudFrame, cloudMapFile, startFakeCloud } from "./fakeCloud.js";
import { testConfig } from "./helpers.js";

const TOKEN_HEX = "00112233445566778899aabbccddeeff";
const token = Buffer.from(TOKEN_HEX, "hex");
const md5 = (...b: Buffer[]) => createHash("md5").update(Buffer.concat(b)).digest();
const key = md5(token);
const iv = md5(key, token);
const API = "t".repeat(24);
const auth = { authorization: `Bearer ${API}` };

/** A pretend vacuum: speaks the real miio framing and encryption. */
function fakeVacuum(handler: (method: string, params: any) => Record<string, unknown>, corrupt = false): Promise<{ sock: Socket; port: number }> {
  const sock = createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const head = Buffer.alloc(16);
    head.writeUInt16BE(0x2131, 0);
    head.writeUInt32BE(4242, 8);
    head.writeUInt32BE(1000, 12);
    if (msg.length === 32) {
      head.writeUInt16BE(32, 2);
      return void sock.send(Buffer.concat([head, Buffer.alloc(16, 0xff)]), rinfo.port, rinfo.address);
    }
    const body = msg.subarray(32);
    // the real device rejects a wrong checksum, so does this one
    if (!md5(msg.subarray(0, 16), token, body).equals(msg.subarray(16, 32))) return;
    const d = createDecipheriv("aes-128-cbc", key, iv);
    const req = JSON.parse(Buffer.concat([d.update(body), d.final()]).toString());
    const c = createCipheriv("aes-128-cbc", key, iv);
    const out = Buffer.concat([c.update(JSON.stringify({ id: req.id, ...handler(req.method, req.params) })), c.final()]);
    head.writeUInt16BE(32 + out.length, 2);
    const sum = md5(head, token, out);
    if (corrupt) sum.writeUInt8(sum.readUInt8(0) ^ 0xff, 0); // a forged or damaged reply
    sock.send(Buffer.concat([head, sum, out]), rinfo.port, rinfo.address);
  });
  return new Promise((r) => sock.bind(0, "127.0.0.1", () => r({ sock, port: (sock.address() as AddressInfo).port })));
}

describe("miio client", () => {
  it("rejects a token that is not 32 hex characters", () => {
    assert.throws(() => new MiioDevice("127.0.0.1", "nope"), /32 hex/);
  });

  it("ignores a reply whose checksum doesn't match", async () => {
    const { sock, port } = await fakeVacuum(() => ({ result: ["forged"] }), true);
    const dev = new MiioDevice("127.0.0.1", TOKEN_HEX, port, 400);
    await assert.rejects(dev.call("hello", []), /did not answer/);
    sock.close();
  });

  it("talks to a device and passes errors on", async () => {
    const { sock, port } = await fakeVacuum((m) => (m === "bad" ? { error: { code: -1, message: "nope" } } : { result: ["ok", m] }));
    const dev = new MiioDevice("127.0.0.1", TOKEN_HEX, port, 1000);
    assert.deepEqual(await dev.call("hello", []), ["ok", "hello"]);
    await assert.rejects(dev.call("bad", []), /refused bad: nope/);
    const wrong = new MiioDevice("127.0.0.1", "ff".repeat(16), port, 400);
    await assert.rejects(wrong.call("hello", []), /did not answer|token/);
    sock.close();
  });
});

describe("map request", () => {
  it("asks the robot for a full map frame, and reports a refusal", async () => {
    const seen: any[] = [];
    let code = 0;
    const { sock, port } = await fakeVacuum((method, params) => {
      seen.push({ method, params });
      return { result: { code, out: [] } };
    });
    const robot = new Vacuum(new MiioDevice("127.0.0.1", TOKEN_HEX, port, 1000));
    await robot.requestMap();
    assert.deepEqual(seen[0], { method: "action", params: { did: "x", siid: 6, aiid: 1, in: [{ piid: 2, value: '{"frame_type":"I"}' }] } });
    code = -1;
    await assert.rejects(robot.requestMap(), /would not send its map/);
    sock.close();
  });
});

describe("vacuum API (mock device)", () => {
  let fake: { sock: Socket; port: number };
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const actions: any[] = [];
  let status = 6;
  let fail = false;
  let extras = true;
  let cleaning = 2;
  let suction = 1;
  let water = 2;
  let dust = 0; // dock: 1 while it empties the bin
  let station = true;
  let fault = 0; // MIoT 2/2
  // what the robot keeps for its settings; the pretend one answers and changes these like the real one (booleans come as 1/0, "do not disturb" as true/false)
  const store: Record<string, number | boolean | string> = { "4/11": 1, "4/12": 1, "4/21": 1, "4/26": 1, "4/27": 0, "4/28": 3, "5/1": true, "5/2": "22:00", "5/3": "08:00", "7/1": 100, "15/2": 2, "16/1": 58, "16/2": 17 };
  let settingsAnswered = true;
  let keepsOldSetting = false;
  let ready: boolean | 2 = true; // dock: the robot sits on it and it can empty the bin
  let keepsOldLevels = false; // like a robot with Customized Cleaning on: says yes, keeps its value
  let mapName: string | undefined = "1/2/9";
  let cloud: Awaited<ReturnType<typeof startFakeCloud>>;
  const liveRows: Array<{ time: number; value: string }> = [];
  const eventRows: Array<{ time: number; value: string }> = [];
  const cloudSession = { serviceToken: "tok", ssecurity: Buffer.alloc(16, 3).toString("base64"), userId: "1", clientId: "abcdefghijklmnop" };
  const sets: any[] = [];
  const saved = { ...process.env };

  before(async () => {
    fake = await fakeVacuum((method, params) => {
      if (method === "get_properties") {
        const values: Record<string, number | string> = { ...(mapName ? { "6/8": JSON.stringify({ object_name: mapName, md5: "x" }) } : {}), "3/1": 78, "2/1": status, "2/2": fault, ...(extras ? { "9/1": 241, "9/2": 80, "10/1": 141, "10/2": 70, "11/1": 61, "11/2": 91, "12/1": 1705943812, "12/2": 2789, "12/3": 158, "12/4": 1420 } : {}), ...(extras ? { "4/2": 4, "4/3": 5, "4/23": cleaning, "4/4": suction, "4/5": water } : {}), ...(settingsAnswered ? store : {}), ...(station ? { "15/1": 1, "15/3": ready === 2 ? 2 : ready ? 1 : 0, "15/5": dust } : {}) };
        return { result: params.map((q: { siid: number; piid: number }) => (values[`${q.siid}/${q.piid}`] === undefined ? { ...q, code: -1 } : { ...q, code: 0, value: values[`${q.siid}/${q.piid}`] })) };
      }
      if (method === "miIO.info") return { result: { model: "dreame.vacuum.p2028a", fw_ver: "4.1.8_1156", mac: "AA:BB:CC:DD:EE:FF" } };
      if (method === "set_properties") {
        sets.push(params);
        if (fail) return { result: params.map((q: object) => ({ ...q, code: -1 })) };
        const k = `${params[0].siid}/${params[0].piid}`;
        if (k in store) {
          if (!keepsOldSetting) store[k] = params[0].value;
        } else if (params[0].piid === 23) cleaning = params[0].value;
        else if (!keepsOldLevels && params[0].piid === 4) suction = params[0].value;
        else if (!keepsOldLevels && params[0].piid === 5) water = params[0].value;
        return { result: params.map((q: object) => ({ ...q, code: 0 })) };
      }
      if (method === "action") {
        actions.push(params);
        return { result: { code: fail ? -1 : 0, out: [] } };
      }
      return { error: { code: -1, message: "unknown" } };
    });
    process.env.VACUUM_IP = "127.0.0.1";
    process.env.VACUUM_TOKEN = TOKEN_HEX;
    process.env.VACUUM_PORT = String(fake.port);
    process.env.VACUUM_MAP_POKE_MS = "200";
    process.env.VACUUM_LEVELS_DELAY_MS = "30";
    dir = mkdtempSync(join(tmpdir(), "vacuum-test-"));
    cloud = await startFakeCloud(cloudSession, { "1/2/9": cloudMapFile({ width: 6, height: 5, cells: [0, 0, 0, 0, 0, 0, 0, 129, 129, 129, 129, 0, 0, 129, 1, 1, 129, 0, 0, 129, 129, 129, 129, 0, 0, 0, 0, 0, 0, 0], name: "Test home" }) }, { "6.1": liveRows, "4.1": eventRows });
    process.env.XIAOMI_CLOUD_BASE = cloud.base;
    app = await buildApp(testConfig({ dataDir: dir, apiToken: API }));
  });

  after(async () => {
    await app.close();
    await cloud.close();
    delete process.env.XIAOMI_CLOUD_BASE;
    fake.sock.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ["VACUUM_IP", "VACUUM_TOKEN", "VACUUM_PORT", "VACUUM_MAP_POKE_MS", "VACUUM_LEVELS_DELAY_MS"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reports brush and filter wear and the lifetime totals", async () => {
    const res = await app.inject({ url: "/api/vacuum/care", headers: { authorization: `Bearer ${API}` } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      mainBrush: { percent: 80, hoursLeft: 241 },
      sideBrush: { percent: 70, hoursLeft: 141 },
      filter: { percent: 61, hoursLeft: 91 },
      sensor: { percent: 58, hoursLeft: 17 },
      totals: { firstCleanAt: "2024-01-22T17:16:52.000Z", minutes: 2789, cleanings: 158, areaM2: 1420 },
    });
    assert.equal((await app.inject({ url: "/api/vacuum/care" })).statusCode, 401);
  });

  it("lists the cleanings the cloud remembers, newest first, without empty attempts or damaged records", async () => {
    assert.equal((await app.inject({ url: "/api/vacuum/history" })).statusCode, 401);
    saveSession(dir, cloudSession);
    const rec = (start: number, minutes: number, area: number) => JSON.stringify([{ piid: 1, value: 2 }, { piid: 2, value: minutes }, { piid: 3, value: area }, { piid: 8, value: start }]);
    eventRows.splice(0, eventRows.length,
      { time: 300, value: rec(1793393081, 0, 0) },
      { time: 200, value: rec(1793392596, 7, 8) },
      { time: 100, value: "not json" },
      { time: 50, value: rec(1793390497, 25, 9) },
    );
    const res = await app.inject({ url: "/api/vacuum/history", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      cleanings: [
        { startedAt: "2026-10-30T20:36:36.000Z", minutes: 7, areaM2: 8 },
        { startedAt: "2026-10-30T20:01:37.000Z", minutes: 25, areaM2: 9 },
      ],
    });
    eventRows.splice(0, eventRows.length);
    rmSync(sessionPath(dir), { force: true }); // other tests expect to start signed out
  });

  it("needs the API token", async () => {
    assert.equal((await app.inject({ url: "/api/vacuum" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/vacuum", payload: { action: "start" } })).statusCode, 401);
  });

  it("reports battery and a readable state", async () => {
    const res = await app.inject({ url: "/api/vacuum", headers: auth });
    assert.deepEqual(res.json(), { configured: true, reachable: true, battery: 78, mode: "charging", statusCode: 6, areaM2: 5, minutes: 4, cleaningMode: "both", suction: "standard", water: "medium", dustStation: { autoEmpty: true, ready: true, emptying: false, limited: false }, model: "dreame.vacuum.p2028a", firmware: "4.1.8_1156" });
    status = 13;
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().mode, "charged");
    status = 99;
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().mode, "unknown");
  });

  it("still reports battery and state when the robot doesn't answer for the cleaning details", async () => {
    extras = false;
    status = 6;
    const body = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    extras = true;
    assert.equal(body.battery, 78);
    assert.equal(body.mode, "charging");
    assert.ok(!("areaM2" in body) && !("minutes" in body) && !("cleaningMode" in body));
  });

  it("starts, pauses, sends the robot home and makes it call out", async () => {
    for (const action of ["start", "pause", "dock", "find"]) {
      const res = await app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload: { action } });
      assert.equal(res.statusCode, 200, action);
    }
    assert.deepEqual(actions.map((a) => [a.siid, a.aiid]), [[2, 1], [2, 2], [3, 1], [7, 1]]);
  });

  it("empties the bin only when the robot is on a dock that can do it", async () => {
    const empty = () => app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload: { action: "empty" } });
    const before = actions.length;
    ready = false; // away from the dock
    assert.equal((await empty()).statusCode, 409);
    ready = true;
    dust = 1; // already emptying
    assert.equal((await empty()).statusCode, 409);
    dust = 0;
    station = false; // a robot that reports no dock
    assert.equal((await empty()).statusCode, 409);
    station = true;
    assert.equal(actions.length, before, "nothing was sent to the robot");
    assert.equal((await empty()).statusCode, 200);
    assert.deepEqual([actions.at(-1).siid, actions.at(-1).aiid], [15, 1]);
    dust = 1;
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().dustStation.emptying, true);
    dust = 0;
  });

  it("explains a fault and knows the dock's own states", async () => {
    status = 4;
    fault = 12;
    let body = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    assert.equal(body.mode, "error");
    assert.deepEqual(body.fault, { code: 12, title: "Main brush is tangled", hint: "Take the main brush out and clear its bristles and bearings." });
    fault = 9999; // a code we have no text for is still reported
    body = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    assert.equal(body.fault.title, "Error 9999");
    fault = 0;
    status = 22;
    body = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    assert.equal(body.mode, "emptying");
    assert.ok(!("fault" in body));
    status = 14;
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().mode, "updating");
    status = 6;
    ready = 2;
    body = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    ready = true;
    assert.deepEqual(body.dustStation, { autoEmpty: true, ready: false, emptying: false, limited: true });
  });

  it("resets a part's wear counter after it was changed", async () => {
    const before = actions.length;
    for (const part of ["mainBrush", "sideBrush", "filter"]) {
      const res = await app.inject({ method: "POST", url: "/api/vacuum/reset", headers: auth, payload: { part } });
      assert.equal(res.statusCode, 200, part);
    }
    assert.deepEqual(actions.slice(before).map((a) => [a.siid, a.aiid]), [[9, 1], [10, 1], [11, 1]]);
    for (const payload of [{}, { part: "mop" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/reset", headers: auth, payload })).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(actions.length, before + 3, "nothing else was sent");
  });

  it("reports the robot's settings", async () => {
    const res = await app.inject({ url: "/api/vacuum/settings", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      resumeCleaning: true,
      carpetBoost: true,
      obstacleAvoidance: true,
      childLock: false,
      customizedCleaning: true,
      carpetSensitivity: "high",
      dnd: { enabled: true, from: "22:00", to: "08:00" },
      volume: 100,
      autoEmptyFrequency: 2,
    });
    settingsAnswered = false;
    const none = await app.inject({ url: "/api/vacuum/settings", headers: auth });
    settingsAnswered = true;
    assert.equal(none.statusCode, 502, "a robot that answers for none of them is an error, not an empty page");
  });

  it("switches a setting and reads it back", async () => {
    const set = (name: string, on: boolean) => app.inject({ method: "POST", url: "/api/vacuum/setting", headers: auth, payload: { name, on } });
    assert.equal((await set("childLock", true)).statusCode, 200);
    assert.deepEqual(sets.at(-1), [{ did: "x", siid: 4, piid: 27, value: 1 }]);
    assert.equal((await app.inject({ url: "/api/vacuum/settings", headers: auth })).json().childLock, true);
    assert.equal((await set("dnd", false)).statusCode, 200);
    assert.deepEqual(sets.at(-1), [{ did: "x", siid: 5, piid: 1, value: false }], "do not disturb is a real boolean, the others are 1 and 0");
    assert.equal((await app.inject({ url: "/api/vacuum/settings", headers: auth })).json().dnd.enabled, false);
    await set("childLock", false);
    await set("dnd", true);
    keepsOldSetting = true;
    const refused = await set("carpetBoost", false);
    keepsOldSetting = false;
    assert.equal(refused.statusCode, 502, "the robot said yes and kept its value");
    assert.match(refused.json().error, /kept its old setting/);
    for (const payload of [{}, { name: "volume", on: true }, { name: "childLock" }, { name: "childLock", on: "yes" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/setting", headers: auth, payload })).statusCode, 400, JSON.stringify(payload));
    }
  });

  it("reports how dirty the sensors are, and resets that after cleaning them", async () => {
    const care = (await app.inject({ url: "/api/vacuum/care", headers: auth })).json();
    assert.deepEqual(care.sensor, { percent: 58, hoursLeft: 17 });
    const before = actions.length;
    assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/reset", headers: auth, payload: { part: "sensor" } })).statusCode, 200);
    assert.deepEqual([actions.at(-1).siid, actions.at(-1).aiid], [16, 1]);
    assert.equal(actions.length, before + 1);
  });

  it("refuses anything that is not a known action", async () => {
    for (const payload of [{}, { action: "empty-bin" }, { action: 3 }]) {
      const res = await app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });

  it("switches the cleaning mode and then reports it", async () => {
    const res = await app.inject({ method: "POST", url: "/api/vacuum/mode", headers: auth, payload: { mode: "mopping" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sets.at(-1), [{ did: "x", siid: 4, piid: 23, value: 1 }]);
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().cleaningMode, "mopping");
    await app.inject({ method: "POST", url: "/api/vacuum/mode", headers: auth, payload: { mode: "both" } });
    assert.equal((await app.inject({ url: "/api/vacuum", headers: auth })).json().cleaningMode, "both");
  });

  it("reports suction and water, and changes them", async () => {
    const first = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    assert.equal(first.suction, "standard");
    assert.equal(first.water, "medium");
    let res = await app.inject({ method: "POST", url: "/api/vacuum/suction", headers: auth, payload: { level: "turbo" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sets.at(-1), [{ did: "x", siid: 4, piid: 4, value: 3 }]);
    res = await app.inject({ method: "POST", url: "/api/vacuum/water", headers: auth, payload: { level: "low" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sets.at(-1), [{ did: "x", siid: 4, piid: 5, value: 1 }]);
    const now = (await app.inject({ url: "/api/vacuum", headers: auth })).json();
    assert.equal(now.suction, "turbo");
    assert.equal(now.water, "low");
  });

  it("puts the chosen suction back after a start, because the robot resets it to the maximum", async () => {
    await app.inject({ method: "POST", url: "/api/vacuum/suction", headers: auth, payload: { level: "quiet" } });
    suction = 3; // what the robot does when a cleaning starts
    const before = sets.length;
    const res = await app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload: { action: "start" } });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(sets.slice(before), [[{ did: "x", siid: 4, piid: 4, value: 0 }]]);
    assert.equal(suction, 0);
  });

  it("says so when the robot keeps its old suction, as it does with Customized Cleaning on", async () => {
    keepsOldLevels = true;
    try {
      const res = await app.inject({ method: "POST", url: "/api/vacuum/suction", headers: auth, payload: { level: "turbo" } }); // the robot is at quiet after the previous test
      assert.equal(res.statusCode, 502);
      assert.match(res.json().error, /Customized Cleaning/);
    } finally {
      keepsOldLevels = false;
    }
  });

  it("needs the token and known levels for suction and water", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/suction", payload: { level: "turbo" } })).statusCode, 401);
    for (const [url, payload] of [["suction", { level: "max" }], ["suction", {}], ["water", { level: "turbo" }], ["water", { level: 3 }]] as const) {
      const res = await app.inject({ method: "POST", url: `/api/vacuum/${url}`, headers: auth, payload });
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
    }
  });

  it("needs the token and a known mode for the cleaning mode", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/mode", payload: { mode: "both" } })).statusCode, 401);
    const before = sets.length;
    for (const payload of [{}, { mode: "turbo" }, { mode: 1 }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/mode", headers: auth, payload })).statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(sets.length, before, "nothing reached the robot");
  });

  it("answers 502 when the robot refuses the cleaning mode", async () => {
    fail = true;
    const res = await app.inject({ method: "POST", url: "/api/vacuum/mode", headers: auth, payload: { mode: "sweeping" } });
    fail = false;
    assert.equal(res.statusCode, 502);
  });

  it("drops fields it doesn't know and runs only the action", async () => {
    // Fastify strips extra fields instead of answering 400; nothing but the action reaches the robot.
    const before = actions.length;
    const res = await app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload: { action: "pause", speed: 9 } });
    assert.equal(res.statusCode, 200);
    assert.equal(actions.length, before + 1);
    assert.deepEqual(actions.at(-1), { did: "x", siid: 2, aiid: 2, in: [] });
  });

  it("answers 502 when the robot refuses", async () => {
    fail = true;
    const res = await app.inject({ method: "POST", url: "/api/vacuum", headers: auth, payload: { action: "start" } });
    fail = false;
    assert.equal(res.statusCode, 502);
  });

  it("serves the floor plan only with the token, and 404 when there is none", async () => {
    assert.equal((await app.inject({ url: "/api/vacuum/map" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/vacuum/map", headers: auth })).statusCode, 404);
    writeFileSync(join(dir, "vacuum-map.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const res = await app.inject({ url: "/api/vacuum/map", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.rawPayload.length, 8);
  });

  it("prefers the picture drawn from the robot's own map over the static one", async () => {
    writeFileSync(join(dir, "vacuum-map-live.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
    const res = await app.inject({ url: "/api/vacuum/map", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawPayload.length, 10);
  });

  it("redraws the floor plan from the robot's map, and only with the token", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/map/refresh" })).statusCode, 401);
    // no Xiaomi sign-in yet: the user has to run the login tool
    const noLogin = await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    assert.equal(noLogin.statusCode, 409);
    assert.match(noLogin.json().error, /login/);

    saveSession(dir, cloudSession);
    const res = await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    assert.equal(res.statusCode, 200);
    const png = await app.inject({ url: "/api/vacuum/map", headers: auth });
    assert.equal(png.rawPayload.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png.rawPayload.readUInt32BE(16), 6 * 5, "6 cells wide at 5 pixels per cell");
    assert.equal(loadSession(dir)?.region, "de");
  });

  it("draws wall edges, objects and the route from the robot's recent map pieces when it has them", async () => {
    saveSession(dir, cloudSession);
    const now = Math.round(Date.now() / 1000);
    // the saved map is 6x5 with origin (-100,-200) mm: one object on cell (2,2), and a short trip along picture row 4
    const object = cloudFrame({ piece: { width: 1, height: 1, leftMm: 0, topMm: -100, cells: [8] }, frameId: 3 });
    const trip = cloudFrame({ trail: "M-50,-150L100,0", frameId: 4 });
    liveRows.splice(0, liveRows.length, { time: now - 1, value: JSON.stringify([trip]) }, { time: now - 3, value: JSON.stringify([object]) }, { time: now - 5, value: "not even json" });
    try {
      assert.equal((await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth })).statusCode, 200);
      const png = (await app.inject({ url: "/api/vacuum/map", headers: auth })).rawPayload;
      const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
      const w = png.readUInt32BE(16);
      const at = (x: number, y: number) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)];
      // file cell (2,2) is picture cell (2,2) in a 5-row map; at 5 pixels per cell its corner is pixel (10,10)
      assert.deepEqual(at(14, 14), [136, 148, 176, 255], "the object is grey");
      assert.deepEqual(at(8, 20), [225, 232, 255, 255], "the route is drawn (it runs along picture row 4, from pixel 5 to 15)");
    } finally {
      liveRows.splice(0, liveRows.length);
    }
  });

  it("asks the robot to send its map pieces itself, but not over and over", async () => {
    saveSession(dir, cloudSession);
    const asked = () => actions.filter((a) => (a as { siid?: number }).siid === 6 && (a as { aiid?: number }).aiid === 1).length;
    // the ask goes out without the redraw waiting for it, so give the pretend robot a moment to receive it
    const until = async (n: number) => {
      for (let i = 0; i < 50 && asked() < n; i++) await new Promise((r) => setTimeout(r, 20));
      return asked();
    };
    await new Promise((r) => setTimeout(r, 250)); // earlier tests may have just asked
    const before = asked();
    await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    assert.equal(await until(before + 1), before + 1, "a redraw asks the robot for its map");
    await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(asked(), before + 1, "a second redraw right after does not ask again");
    await new Promise((r) => setTimeout(r, 250));
    await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    assert.equal(await until(before + 2), before + 2, "later it asks again");
  });

  it("answers 502 when the robot does not say where its map is", async () => {
    mapName = undefined;
    const res = await app.inject({ method: "POST", url: "/api/vacuum/map/refresh", headers: auth });
    mapName = "1/2/9";
    assert.equal(res.statusCode, 502);
  });

  it("says where the robot is and the trail it just drove, in map cells", async () => {
    assert.equal((await app.inject({ url: "/api/vacuum/live" })).statusCode, 401);
    const now = Math.round(Date.now() / 1000);
    // newest first, as the cloud returns them; the map's origin is (-100, -200) mm with 5 cm cells
    liveRows.splice(0, liveRows.length,
      { time: now - 1, value: JSON.stringify([cloudFrame({ robotMm: [0, 100], trail: "L50,0", frameId: 2 })]) },
      { time: now - 3, value: JSON.stringify([cloudFrame({ robotMm: [-50, 100], trail: "M-100,-200L50,0", frameId: 1 })]) },
      { time: now - 5, value: "not even json" },
    );
    const res = await app.inject({ url: "/api/vacuum/live", headers: auth });
    assert.equal(res.statusCode, 200);
    const live = res.json();
    assert.deepEqual(live.map, { width: 6, height: 5 });
    assert.deepEqual(live.robot, { x: 2, y: -1 }, "the newest frame wins");
    assert.equal(live.live, true);
    assert.ok(live.ageSeconds <= 3);
    // oldest frame first: M-100,-200 -> cell (0,0), then a step of 50 mm -> cell (1,0); then the next frame's step
    assert.deepEqual(live.trail[0], { x: 0, y: 5 });
    assert.deepEqual(live.trail[1], { x: 1, y: 5 });
    assert.equal(live.trail.length, 3);
  });

  it("says the robot is not moving when its last frame is old", async () => {
    await new Promise((r) => setTimeout(r, 2100)); // the answer is shared for two seconds
    liveRows.splice(0, liveRows.length, { time: Math.round(Date.now() / 1000) - 600, value: JSON.stringify([cloudFrame({ robotMm: [0, 100] })]) });
    const live = (await app.inject({ url: "/api/vacuum/live", headers: auth })).json();
    assert.equal(live.live, false);
    assert.ok(live.ageSeconds >= 600);
  });

  it("never exposes the token or the hardware address", async () => {
    const text = (await app.inject({ url: "/api/vacuum", headers: auth })).body;
    assert.ok(!text.includes(TOKEN_HEX));
    assert.ok(!text.includes("AA:BB:CC"));
  });
});
