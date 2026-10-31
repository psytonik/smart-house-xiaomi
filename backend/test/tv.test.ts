import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TvError, TvRemote, type TvStatus } from "../src/tv.js";
import { KEYS } from "../src/tv/messages.js";
import { startFakeTv } from "./fakeTv.js";

const until = async (what: string, test: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("TV remote", () => {
  let dir: string;
  let tv: Awaited<ReturnType<typeof startFakeTv>>;
  const remotes: TvRemote[] = [];
  const make = (extra: { pairingPort?: number; remotePort?: number } = {}) => {
    const r = new TvRemote({ host: "127.0.0.1", dataDir: dir, pairingPort: tv.pairingPort, remotePort: tv.remotePort, ...extra });
    remotes.push(r);
    return r;
  };
  /** Pairs a remote with the pretend TV the way a person would. */
  const pair = async (r: TvRemote) => {
    await r.beginPairing();
    await until("the TV to show a code", () => tv.state.code !== undefined);
    await r.finishPairing(tv.state.code!);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tv-test-"));
    tv = await startFakeTv();
  });
  afterEach(async () => {
    for (const r of remotes.splice(0)) r.stop();
    await tv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not paired at first, and says so", () => {
    const r = make();
    assert.deepEqual(r.status(), { paired: false, link: "offline", waitingForCode: false });
    assert.throws(() => r.press("up"), (e: unknown) => e instanceof TvError && e.status === 503);
  });

  it("pairs with the code the TV shows, then follows the TV", async () => {
    const r = make();
    r.start();
    await r.beginPairing();
    assert.equal(r.status().waitingForCode, true);
    await until("the TV to show a code", () => tv.state.code !== undefined);
    assert.match(tv.state.code!, /^[0-9A-F]{6}$/);
    await r.finishPairing(tv.state.code!.toLowerCase()); // letters in any case

    assert.equal(r.status().paired, true);
    assert.equal(r.status().waitingForCode, false);
    await until("the remote connection to be ready", () => r.status().link === "ready");
    await until("the TV to say what it is doing", () => r.status().app !== undefined && r.status().volume !== undefined);
    const s: TvStatus = r.status();
    assert.equal(s.powered, true);
    assert.deepEqual(s.volume, { level: 35, max: 100, muted: false });
    assert.equal(s.app, "com.example.player");

    // the key made for this app stays in the data directory, private
    assert.ok(existsSync(join(dir, "tv-client.key")));
    assert.equal(statSync(join(dir, "tv-client.key")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(dir, "tv.json"), "utf8")).host, "127.0.0.1");
  });

  it("does not take a wrong code, and lets the person try again", async () => {
    const r = make();
    await r.beginPairing();
    await until("the TV to show a code", () => tv.state.code !== undefined);
    const code = tv.state.code!;
    const wrong = ((parseInt(code.slice(0, 2), 16) + 1) % 256).toString(16).padStart(2, "0") + code.slice(2); // wrong check byte
    await assert.rejects(r.finishPairing(wrong), (e: unknown) => e instanceof TvError && e.status === 400 && /not the code/.test(e.message));
    await assert.rejects(r.finishPairing("12"), (e: unknown) => e instanceof TvError && e.status === 400);
    await assert.rejects(r.finishPairing("12345G"), (e: unknown) => e instanceof TvError && e.status === 400);
    assert.equal(r.status().paired, false);
    assert.equal(r.status().waitingForCode, true, "still waiting: the right code is accepted next");
    await r.finishPairing(code);
    assert.equal(r.status().paired, true);
  });

  it("wants pairing to start before a code is entered", async () => {
    await assert.rejects(make().finishPairing("123456"), (e: unknown) => e instanceof TvError && e.status === 409);
  });

  it("sends keys and app links to the TV", async () => {
    const r = make();
    r.start();
    await pair(r);
    await until("ready", () => r.status().link === "ready");
    r.press("up");
    r.press("volumeDown");
    r.press("7");
    r.launch("youtube");
    await until("the TV to get them", () => tv.state.keys.length === 3 && tv.state.links.length === 1);
    assert.deepEqual(tv.state.keys, [{ code: KEYS.up, direction: 3 }, { code: KEYS.volumeDown, direction: 3 }, { code: KEYS["7"], direction: 3 }]);
    assert.deepEqual(tv.state.links, ["https://www.youtube.com"]);
  });

  it("answers the TV's pings, or the TV drops it", async () => {
    const r = make();
    r.start();
    await pair(r);
    await until("ready", () => r.status().link === "ready");
    tv.ping(41);
    tv.ping(42);
    await until("the answers", () => tv.state.pongs.length === 2);
    assert.deepEqual(tv.state.pongs, [41, 42]);
  });

  it("reconnects by itself when the TV hangs up, and doesn't claim to know the screen state meanwhile", async () => {
    const r = make();
    r.start();
    await pair(r);
    await until("ready", () => r.status().link === "ready");
    const before = tv.state.remoteConnections;
    tv.hangUp();
    await until("to notice", () => r.status().link !== "ready");
    assert.equal(r.status().powered, undefined);
    assert.throws(() => r.press("home"), (e: unknown) => e instanceof TvError && e.status === 503);
    await until("to reconnect", () => r.status().link === "ready", 6000);
    assert.equal(tv.state.remoteConnections, before + 1);
    assert.equal(r.status().powered, true);
  });

  it("stays paired after a restart of the app", async () => {
    const first = make();
    first.start();
    await pair(first);
    first.stop();
    const again = make();
    assert.equal(again.status().paired, true);
    again.start();
    await until("ready again, without pairing", () => again.status().link === "ready");
  });

  it("is not paired with a different TV address than the one it was paired with", async () => {
    const first = make();
    await pair(first);
    first.stop();
    const other = new TvRemote({ host: "10.1.2.3", dataDir: dir });
    assert.equal(other.status().paired, false);
  });

  it("says why when the TV refuses to pair, or can't be reached", async () => {
    tv.state.refusePairing = true;
    await assert.rejects(make().beginPairing(), (e: unknown) => e instanceof TvError && /refused pairing \(status 400\)/.test(e.message));
    tv.state.refusePairing = false;
    const closed = make({ pairingPort: 1 }); // nothing listens there
    await assert.rejects(closed.beginPairing(), (e: unknown) => e instanceof TvError && e.status === 503);
  });
});
