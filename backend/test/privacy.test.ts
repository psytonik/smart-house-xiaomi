import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { blackout, privacyFilter, thumbnailFilter } from "../src/privacy.js";
import type { Zone } from "../src/zones.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const priv = (over: Partial<Zone> = {}): Zone => ({ id: "window", mode: "privacy", x: 0, y: 0, w: 0.5, h: 1, ...over });

/** A white 160x90 JPEG. */
function whiteJpeg(): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=white:s=160x90", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]);
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

/** Brightness (0..255) of the left and right half of a JPEG. */
function halves(jpeg: Buffer): { left: number; right: number } {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=2:1:flags=area,format=gray", "-f", "rawvideo", "pipe:1"], { input: jpeg });
  assert.equal(raw.status, 0, String(raw.stderr));
  return { left: raw.stdout[0]!, right: raw.stdout[1]! };
}

describe("privacyFilter", () => {
  it("is empty when there is no privacy zone: ignore and watch zones are only for motion", () => {
    assert.equal(privacyFilter([]), "");
    assert.equal(privacyFilter([priv({ mode: "ignore" }), priv({ id: "w", mode: "watch" })]), "");
  });

  it("draws one filled black box per privacy zone, sized as a share of the picture", () => {
    assert.equal(
      privacyFilter([priv({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), priv({ id: "b", x: 0.6, y: 0, w: 0.4, h: 0.12 })]),
      "drawbox=x=iw*0.1:y=ih*0.2:w=iw*0.3:h=ih*0.4:color=black:t=fill,drawbox=x=iw*0.6:y=ih*0:w=iw*0.4:h=ih*0.12:color=black:t=fill",
    );
  });

  it("thumbnails are scaled first, then blacked out", () => {
    assert.equal(thumbnailFilter([]), "scale=480:-2");
    assert.equal(thumbnailFilter([priv()]), `scale=480:-2,${privacyFilter([priv()])}`);
  });
});

describe("blackout", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  it("returns the picture untouched when nothing is private", async () => {
    const jpg = whiteJpeg();
    assert.equal(await blackout(jpg, [priv({ mode: "ignore" })], "ffmpeg"), jpg);
  });

  it("burns the private area into the picture and leaves the rest", async () => {
    const jpg = whiteJpeg();
    const before = halves(jpg);
    const after = halves(await blackout(jpg, [priv()], "ffmpeg"));
    assert.ok(before.left > 240 && before.right > 240);
    assert.ok(after.left < 20, `left half is black (${after.left})`);
    assert.ok(after.right > 240, `right half is untouched (${after.right})`);
  });

  it("fails instead of handing back the unhidden picture", async () => {
    await assert.rejects(blackout(whiteJpeg(), [priv()], "/nonexistent/ffmpeg"));
    await assert.rejects(blackout(Buffer.from("not a jpeg"), [priv()], "ffmpeg"));
  });
});

describe("snapshots with privacy zones", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const TOKEN = "privacy-api-test-token-0123456789";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let go2rtc: Server;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let serve: Buffer = Buffer.alloc(0);

  before(async () => {
    go2rtc = createServer((req, res) => {
      if (req.url?.startsWith("/api/frame.jpeg")) res.writeHead(200, { "content-type": "image/jpeg" }).end(serve);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => go2rtc.listen(0, "127.0.0.1", r));
    dir = mkdtempSync(join(tmpdir(), "cam-privacy-"));
    app = await buildApp(
      loadConfig({ API_TOKEN: TOKEN, DATA_DIR: dir, PUBLIC_DIR: join(dir, "none"), MOTION_ENABLED: "false", GO2RTC_URL: `http://127.0.0.1:${(go2rtc.address() as AddressInfo).port}` }),
    );
  });
  after(async () => {
    await app.close();
    await new Promise((r) => go2rtc.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const putZones = (zones: Zone[]) => app.inject({ method: "PUT", url: "/api/zones", headers: auth, payload: { zones } });

  it("accepts privacy zones", async () => {
    assert.equal((await putZones([priv()])).statusCode, 200);
    assert.equal((await putZones([])).statusCode, 200);
  });

  it("the live frame and a saved snapshot both come out with the area hidden", async () => {
    serve = whiteJpeg();
    assert.equal((await putZones([priv()])).statusCode, 200);

    const live = await app.inject({ url: "/api/snapshot", headers: auth });
    assert.equal(live.statusCode, 200);
    assert.ok(halves(live.rawPayload).left < 20 && halves(live.rawPayload).right > 240);

    const saved = await app.inject({ method: "POST", url: "/api/snapshots", headers: auth });
    assert.equal(saved.statusCode, 201);
    const file = await app.inject({ url: `/api/snapshots/${saved.json().name}`, headers: auth });
    assert.ok(halves(file.rawPayload).left < 20, "the saved file itself is redacted, not only the live view");
  });

  it("a frame that cannot be redacted is refused, never served raw", async () => {
    serve = Buffer.from("garbage");
    const res = await app.inject({ url: "/api/snapshot", headers: auth });
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /private/i);
  });

  it("without privacy zones the frame passes through as it is", async () => {
    serve = whiteJpeg();
    await putZones([]);
    const res = await app.inject({ url: "/api/snapshot", headers: auth });
    assert.ok(res.rawPayload.equals(serve));
  });
});
