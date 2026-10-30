import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UrlSigner, isSignable } from "../src/signing.js";

const PATH = "/api/events/20261030T130000000Z/clip";

function parts(link: string) {
  const q = new URL(link, "http://x").searchParams;
  return { path: new URL(link, "http://x").pathname, exp: q.get("exp"), sig: q.get("sig") };
}

describe("UrlSigner", () => {
  let clock = Date.UTC(2026, 9, 30, 12, 0, 0);
  const signer = new UrlSigner("secret-token-0123456789", 3600, () => clock);

  it("verifies its own links", () => {
    const { path, exp, sig } = parts(signer.sign(PATH));
    assert.equal(signer.verify(path, exp, sig), true);
  });

  it("gives the same link within a window, so the browser cache and list polling stay stable", () => {
    const a = signer.sign(PATH);
    clock += 60_000;
    assert.equal(signer.sign(PATH), a);
  });

  it("a fresh link lives at least half of the TTL and at most all of it", () => {
    for (let offset = 0; offset < 3600; offset += 137) {
      const now = Date.UTC(2026, 9, 30, 12, 0, 0) + offset * 1000;
      const s = new UrlSigner("k".repeat(20), 3600, () => now);
      const left = Number(parts(s.sign(PATH)).exp) - now / 1000;
      assert.ok(left > 1800 && left <= 3600, `${left}s left at offset ${offset}`);
    }
  });

  it("rejects an expired link", () => {
    const { path, exp, sig } = parts(signer.sign(PATH));
    clock = Number(exp) * 1000;
    assert.equal(signer.verify(path, exp, sig), false);
  });

  it("rejects another path, another secret and malformed input", () => {
    clock = Date.UTC(2026, 9, 30, 12, 0, 0);
    const { path, exp, sig } = parts(signer.sign(PATH));
    assert.equal(signer.verify("/api/events/20261030T130000000Z/thumb", exp, sig), false);
    assert.equal(new UrlSigner("another-secret-0123456789", 3600, () => clock).verify(path, exp, sig), false);
    assert.equal(signer.verify(path, null, sig), false);
    assert.equal(signer.verify(path, exp, null), false);
    assert.equal(signer.verify(path, "12e9", sig), false);
    assert.equal(signer.verify(path, exp, "zz"), false);
    assert.equal(signer.verify(path, exp, sig?.toUpperCase()), false);
  });

  it("never verifies a path outside the media allowlist, even with a valid signature", () => {
    const status = "/api/status";
    const { exp, sig } = parts(signer.sign(status));
    assert.equal(signer.verify(status, exp, sig), false);
  });
});

describe("isSignable", () => {
  it("allows only clip, thumbnail and snapshot files", () => {
    assert.equal(isSignable("/api/events/20261030T130000000Z/clip"), true);
    assert.equal(isSignable("/api/events/20261030T130000000Z/thumb"), true);
    assert.equal(isSignable("/api/snapshots/20261030T130000000Z.jpg"), true);
    for (const p of [
      "/api/events",
      "/api/events/20261030T130000000Z",
      "/api/events/../clip",
      "/api/events/20261030T130000000Z/clip/",
      "/api/snapshots",
      "/api/ptz",
      "/api/stream.m3u8",
      "/api/webrtc",
    ]) {
      assert.equal(isSignable(p), false, p);
    }
  });
});
