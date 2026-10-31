import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPS, APP_IDS, KEYS, KEY_NAMES, pairing, remote } from "../src/tv/messages.js";
import { FrameReader, enc, fields, frame, intOf, strOf, varint } from "../src/tv/wire.js";

const hex = (b: Buffer) => b.toString("hex");

describe("protobuf wire helpers", () => {
  it("writes varints the way protobuf does", () => {
    assert.equal(hex(varint(0)), "00");
    assert.equal(hex(varint(127)), "7f");
    assert.equal(hex(varint(128)), "8001");
    assert.equal(hex(varint(200)), "c801");
    assert.equal(hex(varint(300)), "ac02");
    assert.throws(() => varint(-1), RangeError);
    assert.throws(() => varint(1.5), RangeError);
  });

  it("reads back what it wrote, nested messages and strings included", () => {
    const m = Buffer.concat([enc.int(1, 622), enc.str(2, "héllo"), enc.msg(3, enc.int(1, 7), enc.bool(2, true)), enc.int(4, 2 ** 40)]);
    const f = fields(m);
    assert.equal(intOf(f, 1), 622);
    assert.equal(strOf(f, 2), "héllo");
    assert.deepEqual(fields(f.find((x) => x.field === 3)!.value as Buffer), [{ field: 1, value: 7 }, { field: 2, value: 1 }]);
    assert.equal(intOf(f, 4), 2 ** 40);
  });

  it("stops at a damaged message instead of reading past it", () => {
    assert.deepEqual(fields(Buffer.from("0a05ab", "hex")), [], "a length that runs past the end");
    assert.deepEqual(fields(Buffer.from("08", "hex")), [], "a field without its value");
    assert.deepEqual(fields(Buffer.from("0807ff", "hex")), [{ field: 1, value: 7 }], "what was read before the damage is kept");
  });

  it("cuts a stream into frames, whatever the size of the chunks", () => {
    const a = frame(Buffer.from("aabb", "hex"));
    const b = frame(Buffer.alloc(200, 1)); // a two-byte length
    const stream = Buffer.concat([a, b, a]);
    for (const size of [1, 2, 3, 7, stream.length]) {
      const reader = new FrameReader();
      const got: Buffer[] = [];
      for (let i = 0; i < stream.length; i += size) got.push(...reader.push(stream.subarray(i, i + size)));
      assert.deepEqual(got.map((x) => x.length), [2, 200, 2], `chunks of ${size}`);
    }
  });

  it("refuses a stream that is not frames", () => {
    assert.throws(() => new FrameReader().push(Buffer.from("ffffffffff", "hex")), /not a frame/);
    assert.throws(() => new FrameReader(10).push(Buffer.from("20", "hex")), /too long/);
  });
});

describe("Android TV Remote messages", () => {
  it("builds a key press exactly as the protocol has it", () => {
    // RemoteMessage { remote_key_inject (10) { key_code (1) = 19, direction (2) = 3 } }, framed
    assert.equal(hex(remote.key(KEYS.up)), "0652040813" + "1003");
    assert.equal(hex(remote.key(KEYS.power, 3)), "065204081a1003");
  });

  it("builds the answers a TV waits for", () => {
    // remote_set_active (2) { active (1) = 622 }: 622 is the varint ee 04
    assert.equal(hex(remote.setActive()), "051203" + "08ee04");
    // remote_ping_response (9) { val1 (1) = 5 }
    assert.equal(hex(remote.pong(5)), "044a0208" + "05");
    assert.deepEqual(remote.parse(frameBody(remote.setActive())), { kind: "set-active" });
    assert.deepEqual(remote.parse(frameBody(remote.configure("m", "v", "p", "1"))), { kind: "configure" });
    // remote_app_link_launch_request (90) { app_link (1) }
    const launch = fields(frameBody(remote.appLink("https://www.youtube.com")));
    assert.equal(launch[0]!.field, 90);
    assert.equal(strOf(fields(launch[0]!.value as Buffer), 1), "https://www.youtube.com");
  });

  it("understands what the TV tells", () => {
    const ping = frameBody(frame(enc.msg(8, enc.int(1, 9), enc.int(2, 1))));
    assert.deepEqual(remote.parse(ping), { kind: "ping", value: 9 });
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(40, enc.bool(1, true))))), { kind: "power", on: true });
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(40)))), { kind: "power", on: false }, "a false boolean is left out on the wire");
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(50, enc.int(6, 100), enc.int(7, 35), enc.bool(8, true))))), { kind: "volume", level: 35, max: 100, muted: true });
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(20, enc.msg(1, enc.str(12, "com.google.android.youtube.tv")))))), { kind: "app", app: "com.google.android.youtube.tv" });
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(3, enc.bool(1, true))))), { kind: "error" });
    assert.deepEqual(remote.parse(frameBody(frame(enc.msg(21, enc.int(1, 1))))), { kind: "other" });
  });

  it("builds the pairing messages and reads the TV's answers", () => {
    assert.deepEqual(pairing.parse(frameBody(frame(Buffer.concat([enc.int(1, 2), enc.int(2, 200), enc.msg(11, enc.str(1, "TV"))])))), { status: 200, kind: "request-ack" });
    assert.deepEqual(pairing.parse(frameBody(frame(Buffer.concat([enc.int(1, 2), enc.int(2, 200), enc.msg(31)])))), { status: 200, kind: "configuration-ack" });
    const ack = pairing.parse(frameBody(frame(Buffer.concat([enc.int(1, 2), enc.int(2, 200), enc.msg(41, enc.bytes(1, Buffer.from("abcd", "hex")))]))));
    assert.equal(ack.kind, "secret-ack");
    assert.equal(ack.secret?.toString("hex"), "abcd");
    assert.equal(pairing.parse(frameBody(frame(Buffer.concat([enc.int(1, 2), enc.int(2, 402)])))).status, 402);
    // what we send: version 2, status 200, then the part
    const request = fields(frameBody(pairing.request("svc", "me")));
    assert.equal(intOf(request, 1), 2);
    assert.equal(intOf(request, 2), 200);
    const inner = fields(request.find((x) => x.field === 10)!.value as Buffer);
    assert.equal(strOf(inner, 1), "svc");
    assert.equal(strOf(inner, 2), "me");
    const option = fields(fields(frameBody(pairing.option())).find((x) => x.field === 20)!.value as Buffer);
    assert.equal(intOf(option, 3), 1, "we are the one who types the code");
    const encoding = fields(option.find((x) => x.field === 1)!.value as Buffer);
    assert.deepEqual([intOf(encoding, 1), intOf(encoding, 2)], [3, 6], "hexadecimal, six symbols");
    const secret = fields(fields(frameBody(pairing.secret(Buffer.from("0102", "hex")))).find((x) => x.field === 40)!.value as Buffer);
    assert.equal(hex(secret[0]!.value as Buffer), "0102");
  });

  it("has a key for everything the remote shows, and only known apps", () => {
    for (const k of ["power", "home", "back", "up", "down", "left", "right", "ok", "volumeUp", "volumeDown", "mute", "playPause", "input", "hdmi1", "0", "9"]) assert.ok(k in KEYS, k);
    assert.equal(new Set(Object.values(KEYS)).size, KEY_NAMES.length, "no two keys share a code");
    // an app opens either by a link (the remote protocol) or by the component of its launcher (ADB), never by anything free-form
    for (const id of APP_IDS) {
      const a = APPS[id] as { link?: string; component?: string };
      assert.ok(a.link?.startsWith("https://") || /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(a.component ?? ""), id);
    }
    assert.ok(APP_IDS.includes("prisma"));
  });
});

/** The message inside a frame (the length in front taken off). */
function frameBody(framed: Buffer): Buffer {
  const reader = new FrameReader();
  const [body] = reader.push(framed);
  assert.ok(body, "one whole frame");
  return body;
}
