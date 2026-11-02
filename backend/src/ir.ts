/** RCA infrared frame: a 4-bit address and an 8-bit command, each followed by its inverse (24 bits). Timings in microseconds. */
const RCA = { header: [4000, 4000], mark: 500, one: 2000, zero: 1000 };

/**
 * The frame as alternating mark/space durations, starting with a mark.
 * The TV's firmware (ir_config.ini, section PM51) wakes from standby on protocol 0x07 (RCA), header 0x000f, key 0xD5.
 */
export function rcaTimings(address: number, command: number): number[] {
  if (!Number.isInteger(address) || address < 0 || address > 0xf) throw new Error(`RCA address must be 0..15, got ${address}`);
  if (!Number.isInteger(command) || command < 0 || command > 0xff) throw new Error(`RCA command must be 0..255, got ${command}`);
  const word = (address << 20) | (command << 12) | ((~address & 0xf) << 8) | (~command & 0xff);
  const t = [...RCA.header];
  for (let bit = 23; bit >= 0; bit--) t.push(RCA.mark, (word >> bit) & 1 ? RCA.one : RCA.zero);
  t.push(RCA.mark); // the closing mark; the gap that follows is the end of the packet
  return t;
}

/** A Broadlink IR packet (the payload of a send-data command): 0x26, repeat count, length, durations in 32.84 µs ticks, and the end marker. */
export function broadlinkPacket(timings: number[], repeat = 0): Buffer {
  const data: number[] = [];
  for (const us of timings) {
    const ticks = Math.round((us * 269) / 8192);
    if (ticks > 0xff) data.push(0, ticks >> 8, ticks & 0xff);
    else data.push(ticks);
  }
  data.push(0x0d, 0x05);
  const packet = Buffer.from([0x26, repeat, data.length & 0xff, data.length >> 8, ...data]);
  // the device wants whole 16-byte blocks
  return Buffer.concat([packet, Buffer.alloc((16 - (packet.length % 16)) % 16)]);
}
