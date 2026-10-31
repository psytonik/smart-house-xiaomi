import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { apiBase, CloudError, deviceData, downloadCloudFile, idsFromObjectName, isFollowable, listDevices, loadSession, rc4, saveSession, sessionPath, type CloudSession } from "../src/xiaomiCloud.js";
import { startFakeCloud } from "./fakeCloud.js";

const session: CloudSession = {
  serviceToken: "service-token-for-tests",
  ssecurity: Buffer.alloc(16, 7).toString("base64"),
  userId: "123456",
  clientId: "abcdefghijklmnop",
};

describe("Xiaomi cloud client", () => {
  let dir: string;
  let cloud: Awaited<ReturnType<typeof startFakeCloud>>;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cloud-test-"));
    cloud = await startFakeCloud(session, { "1/2/9": '{"hello":"map"}' }, { "6.1": [{ time: 1700000100, value: '["AAAA"]' }, { time: 1700000000, value: "ignored: not json array but still a string" }, { time: 5 } as any] });
    env = { XIAOMI_CLOUD_BASE: cloud.base };
  });
  after(async () => {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rc4 undoes itself and hides the text", () => {
    const key = Buffer.from("0123456789abcdef");
    const secret = Buffer.from("map please");
    const scrambled = rc4(key, secret);
    assert.notDeepEqual(scrambled, secret);
    assert.deepEqual(rc4(key, scrambled), secret);
  });

  it("keeps the session in a file only the owner can read", () => {
    assert.equal(loadSession(dir), undefined);
    saveSession(dir, session);
    assert.equal(statSync(sessionPath(dir)).mode & 0o777, 0o600);
    assert.deepEqual(loadSession(dir), { ...session, region: undefined });
    writeFileSync(sessionPath(dir), "{not json");
    assert.equal(loadSession(dir), undefined, "a damaged file counts as no session");
    writeFileSync(sessionPath(dir), JSON.stringify({ serviceToken: 1 }));
    assert.equal(loadSession(dir), undefined, "so does one with missing keys");
  });

  it("asks for a sign-in when there is no session", async () => {
    rmSync(sessionPath(dir), { force: true });
    await assert.rejects(downloadCloudFile(dir, "1/2/9", env), (e: unknown) => e instanceof CloudError && e.needsLogin);
  });

  it("downloads a file with a signed request and remembers the region that worked", async () => {
    saveSession(dir, session);
    assert.equal(await downloadCloudFile(dir, "1/2/9", env), '{"hello":"map"}');
    assert.ok(cloud.calls.at(-1)?.includes("get_interim_file_url"));
    assert.equal(loadSession(dir)?.region, "de");
  });

  it("tries the next region when a region gives a link that leads nowhere, and keeps the one that worked", async () => {
    // any region answers with a link, also for a file it doesn't have: the link of the wrong one is a 404
    const wrongFirst = await startFakeCloud(session, { "1/2/9": '{"hello":"map"}' }, {}, [], { brokenLinks: 1 });
    try {
      saveSession(dir, { ...session, region: "cn" });
      assert.equal(await downloadCloudFile(dir, "1/2/9", { XIAOMI_CLOUD_BASE: wrongFirst.base }), '{"hello":"map"}');
      assert.equal(loadSession(dir)?.region, "de", "cn gave a dead link, de was next in line and worked");
    } finally {
      await wrongFirst.close();
    }
  });

  it("does not remember a region whose download failed", async () => {
    const allDead = await startFakeCloud(session, { "1/2/9": "x" }, {}, [], { brokenLinks: 99 });
    try {
      saveSession(dir, { ...session, region: "cn" });
      await assert.rejects(downloadCloudFile(dir, "1/2/9", { XIAOMI_CLOUD_BASE: allDead.base }), /download failed \(HTTP 404\)/);
      assert.equal(loadSession(dir)?.region, "cn", "a region that only gave dead links must not replace the saved one");
    } finally {
      await allDead.close();
    }
  });

  it("says so when the cloud rejects the session or does not know the file", async () => {
    saveSession(dir, { ...session, ssecurity: Buffer.alloc(16, 9).toString("base64") });
    await assert.rejects(downloadCloudFile(dir, "1/2/9", env), (e: unknown) => e instanceof CloudError && e.needsLogin);
    saveSession(dir, session);
    await assert.rejects(downloadCloudFile(dir, "9/9/9", env), CloudError);
  });

  it("reads what the robot last reported for a property, newest first", async () => {
    saveSession(dir, session);
    const rows = await deviceData(dir, { uid: "1", did: "2" }, "6.1", 20, env);
    assert.deepEqual(rows.map((r) => r.time), [1700000100, 1700000000], "a row without a value is left out");
    assert.deepEqual(await deviceData(dir, { uid: "1", did: "2" }, "9.9", 20, env), []);
    rmSync(sessionPath(dir), { force: true });
    await assert.rejects(deviceData(dir, { uid: "1", did: "2" }, "6.1", 20, env), (e: unknown) => e instanceof CloudError && e.needsLogin);
    saveSession(dir, session);
  });

  it("takes the account and device ids from a robot file name", () => {
    assert.deepEqual(idsFromObjectName("6674200535/447497076/9"), { uid: "6674200535", did: "447497076" });
    assert.equal(idsFromObjectName("nope"), undefined);
    assert.equal(idsFromObjectName("../../etc/9"), undefined);
  });

  it("only follows https download links (plain http only for the loopback test cloud)", () => {
    const real = "https://de.api.io.mi.com/app";
    assert.equal(isFollowable("https://cdn.example/map", real), true);
    assert.equal(isFollowable("http://203.0.113.9/map", real), false);
    assert.equal(isFollowable("file:///etc/passwd", real), false);
    assert.equal(isFollowable("http://127.0.0.1:5/files/x", "http://127.0.0.1:5/app"), true);
  });

  it("refuses a file that is far too big to be a map", async () => {
    saveSession(dir, session);
    const big = await startFakeCloud(session, { "1/2/9": "a".repeat(6 * 1024 * 1024) });
    try {
      await assert.rejects(downloadCloudFile(dir, "1/2/9", { XIAOMI_CLOUD_BASE: big.base }), /too big/);
    } finally {
      await big.close();
    }
  });

  it("only lets the test cloud address be a loopback one", () => {
    assert.equal(apiBase("de", { XIAOMI_CLOUD_BASE: "http://127.0.0.1:5/app/" }), "http://127.0.0.1:5/app");
    assert.equal(apiBase("de", { XIAOMI_CLOUD_BASE: "http://evil.example/app" }), "https://de.api.io.mi.com/app");
    assert.equal(apiBase("de", { XIAOMI_CLOUD_BASE: "https://127.0.0.1/app" }), "https://de.api.io.mi.com/app");
    assert.equal(apiBase("cn", {}), "https://api.io.mi.com/app");
  });
});

describe("Xiaomi cloud device list", () => {
  let dir: string;
  let cloud: Awaited<ReturnType<typeof startFakeCloud>>;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cloud-devices-"));
    cloud = await startFakeCloud(session, {}, {}, [
      { did: "11", name: "Vacuum", model: "dreame.vacuum.p2028a", localip: "10.0.0.7", token: "a".repeat(32), isOnline: true },
      { did: "12", name: "Lamp", model: "yeelink.light.color1", token: "b".repeat(32), isOnline: false },
      { did: "13", name: "Broken", model: "x.y.z" }, // no token: not usable, skipped
    ]);
    env = { XIAOMI_CLOUD_BASE: cloud.base };
  });
  after(async () => {
    await cloud.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks for a sign-in when there is no session", async () => {
    await assert.rejects(listDevices(dir, env), (e: unknown) => e instanceof CloudError && e.needsLogin);
  });

  it("lists the devices once each, with their keys, address and region", async () => {
    saveSession(dir, session);
    const list = await listDevices(dir, env);
    assert.deepEqual(list.map((d) => d.did), ["11", "12"], "the same device from every region is one entry; one without a token is dropped");
    assert.equal(list[0]!.model, "dreame.vacuum.p2028a");
    assert.equal(list[0]!.localip, "10.0.0.7");
    assert.equal(list[0]!.token, "a".repeat(32));
    assert.equal(list[0]!.isOnline, true);
    assert.equal(list[1]!.localip, undefined);
    assert.ok(list[0]!.region.length > 0);
  });

  it("says the session is no good when the cloud answers nothing at all", async () => {
    saveSession(dir, { ...session, ssecurity: Buffer.alloc(16, 9).toString("base64") });
    await assert.rejects(listDevices(dir, env), (e: unknown) => e instanceof CloudError && e.needsLogin);
  });
});
