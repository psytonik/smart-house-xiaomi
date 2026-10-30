import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { FailureLimiter } from "../src/authLimiter.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "security-test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const wrong = { authorization: "Bearer nope" };

describe("FailureLimiter", () => {
  let clock = 1_000_000;
  const make = () => new FailureLimiter(3, 60_000, () => clock);

  it("locks an address after max wrong tokens and reports the wait", () => {
    const l = make();
    for (let i = 0; i < 3; i++) {
      assert.equal(l.retryAfterSec("a"), 0);
      l.fail("a");
    }
    assert.equal(l.retryAfterSec("a"), 60);
    clock += 20_000;
    assert.equal(l.retryAfterSec("a"), 40);
  });

  it("unlocks when the oldest failure leaves the window", () => {
    const l = make();
    l.fail("a");
    clock += 30_000;
    l.fail("a");
    l.fail("a");
    assert.equal(l.retryAfterSec("a"), 30);
    clock += 30_000;
    assert.equal(l.retryAfterSec("a"), 0);
  });

  it("tracks addresses separately and forgets them after a correct token", () => {
    const l = make();
    for (let i = 0; i < 3; i++) l.fail("a");
    assert.equal(l.retryAfterSec("b"), 0);
    l.succeed("a");
    assert.equal(l.retryAfterSec("a"), 0);
  });

  it("caps the number of tracked addresses", () => {
    const l = new FailureLimiter(1, 60_000, () => clock, 3);
    for (const ip of ["a", "b", "c", "d"]) l.fail(ip);
    assert.equal(l.retryAfterSec("a"), 0, "the oldest address was dropped");
    assert.ok(l.retryAfterSec("d") > 0);
  });
});

describe("auth lockout and security headers", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cam-sec-"));
    const cfg = loadConfig({
      API_TOKEN: TOKEN,
      DATA_DIR: dir,
      PUBLIC_DIR: join(dir, "none"),
      MOTION_ENABLED: "false",
      AUTH_MAX_FAILURES: "3",
      AUTH_WINDOW_SEC: "60",
      GO2RTC_URL: "http://127.0.0.1:1",
    });
    app = await buildApp(cfg);
  });

  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const from = (remoteAddress: string, headers: Record<string, string> = {}) =>
    app.inject({ url: "/api/motion", headers, remoteAddress });

  it("locks an address after repeated wrong tokens, even for the right one", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await from("10.0.0.1", wrong)).statusCode, 401);

    const blocked = await from("10.0.0.1", wrong);
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.equal((await from("10.0.0.1", auth)).statusCode, 429, "a lockout is a lockout");
  });

  it("does not affect other addresses", async () => {
    assert.equal((await from("10.0.0.2", auth)).statusCode, 200);
  });

  it("does not count requests without credentials (expired signed links, logged-out tabs)", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await from("10.0.0.3")).statusCode, 401);
    assert.equal((await from("10.0.0.3", auth)).statusCode, 200);
  });

  it("a correct token resets the counter", async () => {
    await from("10.0.0.4", wrong);
    await from("10.0.0.4", wrong);
    assert.equal((await from("10.0.0.4", auth)).statusCode, 200);
    await from("10.0.0.4", wrong);
    await from("10.0.0.4", wrong);
    assert.equal((await from("10.0.0.4", auth)).statusCode, 200, "2 + 2 wrong tokens with a reset between");
  });

  it("sends security headers that fit a plain-HTTP LAN app", async () => {
    const res = await app.inject("/health");
    const csp = String(res.headers["content-security-policy"]);
    for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "media-src 'self' blob:"]) {
      assert.ok(csp.includes(part), `CSP lacks ${part}: ${csp}`);
    }
    assert.ok(!csp.includes("upgrade-insecure-requests"), "would break http://<ip>:3100");
    assert.ok(!csp.includes("unsafe-inline"));
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["strict-transport-security"], undefined, "HSTS is meaningless without TLS");
  });
});

// The CSP forbids inline code. This guards against a web build that would silently stop working.
const built = join(import.meta.dirname, "..", "public", "index.html");
describe("built web app against the CSP", { skip: !existsSync(built) && "web app is not built" }, () => {
  it("has no inline scripts, styles or event handlers", () => {
    const html = readFileSync(built, "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "inline <script>");
    assert.ok(!/<style[\s>]/i.test(html), "inline <style>");
    assert.ok(!/\sstyle\s*=/i.test(html), "style attribute");
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline event handler");
  });
});
