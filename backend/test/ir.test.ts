import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { broadlinkPacket, rcaTimings } from "../src/ir.js";

describe("infrared frame", () => {
  it("encodes the TV's standby wake key (address 0xF, command 0xD5) as header, 24 bits and a closing mark", () => {
    const t = rcaTimings(0xf, 0xd5);
    assert.equal(t.length, 2 + 48 + 1);
    assert.deepEqual(t.slice(0, 2), [4000, 4000]);
    const bits = [];
    for (let i = 2; i < 50; i += 2) bits.push(t[i + 1] === 2000 ? 1 : 0);
    // 1111 11010101 0000 00101010: address, command, their inverses
    assert.equal(bits.join(""), "111111010101000000101010");
    assert.equal(t.at(-1), 500);
  });

  it("refuses an address or command out of range", () => {
    assert.throws(() => rcaTimings(16, 0), /address/);
    assert.throws(() => rcaTimings(0, 256), /command/);
  });

  it("wraps durations in a Broadlink packet in whole 16-byte blocks", () => {
    const p = broadlinkPacket([4000, 4000, 500]);
    assert.equal(p[0], 0x26);
    assert.equal(p.length % 16, 0);
    // 4000 µs is 131 ticks, 500 µs is 16
    assert.deepEqual([...p.subarray(4, 9)], [131, 131, 16, 0x0d, 0x05]);
    assert.equal(p.readUInt16LE(2), 5);
  });

  it("writes a duration over 255 ticks as 0 and two bytes", () => {
    const p = broadlinkPacket([20000]);
    // 20000 µs is 657 ticks = 0x0291
    assert.deepEqual([...p.subarray(4, 7)], [0, 0x02, 0x91]);
  });
});
