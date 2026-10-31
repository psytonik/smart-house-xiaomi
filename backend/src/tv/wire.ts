/**
 * Just enough of Protocol Buffers for the Android TV Remote protocol: varints, strings, bytes and nested messages, and the
 * length-prefixed frames the TV speaks. No schema files and no library: the messages are small and fixed.
 */

export function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("varint must be a non-negative safe integer");
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

const tag = (field: number, wireType: number) => varint(field * 8 + wireType);

/** Field encoders. A message is the concatenation of its fields. */
export const enc = {
  int: (field: number, value: number) => Buffer.concat([tag(field, 0), varint(value)]),
  bool: (field: number, value: boolean) => enc.int(field, value ? 1 : 0),
  bytes: (field: number, value: Buffer) => Buffer.concat([tag(field, 2), varint(value.length), value]),
  str: (field: number, value: string) => enc.bytes(field, Buffer.from(value, "utf8")),
  msg: (field: number, ...parts: Buffer[]) => enc.bytes(field, Buffer.concat(parts)),
};

/** A message as the TV wants it on the wire: its length (a varint) first. */
export const frame = (message: Buffer): Buffer => Buffer.concat([varint(message.length), message]);

export type WireField = { field: number; value: number | Buffer };

/** The fields of one message, in order. Unknown wire types stop the reading: what was read so far is returned. */
export function fields(buf: Buffer): WireField[] {
  const out: WireField[] = [];
  let i = 0;
  const readVarint = (): number | undefined => {
    let result = 0;
    let scale = 1;
    for (let n = 0; n < 8; n++) {
      if (i >= buf.length) return undefined;
      const byte = buf[i++]!;
      result += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return result;
      scale *= 0x80;
    }
    return undefined;
  };
  while (i < buf.length) {
    const key = readVarint();
    if (key === undefined) break;
    const field = Math.floor(key / 8);
    const type = key % 8;
    if (type === 0) {
      const v = readVarint();
      if (v === undefined) break;
      out.push({ field, value: v });
    } else if (type === 2) {
      const len = readVarint();
      if (len === undefined || i + len > buf.length) break;
      out.push({ field, value: buf.subarray(i, i + len) });
      i += len;
    } else if (type === 1 || type === 5) {
      i += type === 1 ? 8 : 4; // fixed-size values are not used by this protocol: skipped
    } else {
      break;
    }
  }
  return out;
}

export const intOf = (list: WireField[], field: number): number | undefined => {
  const f = list.find((x) => x.field === field && typeof x.value === "number");
  return f ? (f.value as number) : undefined;
};
export const bufOf = (list: WireField[], field: number): Buffer | undefined => {
  const f = list.find((x) => x.field === field && Buffer.isBuffer(x.value));
  return f ? (f.value as Buffer) : undefined;
};
export const strOf = (list: WireField[], field: number): string | undefined => bufOf(list, field)?.toString("utf8");

/** Cuts a byte stream into frames (a varint length, then that many bytes). Keeps the incomplete rest for the next chunk. */
export class FrameReader {
  private rest: Buffer = Buffer.alloc(0);

  /** Frames larger than this are not from a TV: the connection is garbage. */
  constructor(private readonly maxBytes = 64 * 1024) {}

  push(chunk: Buffer): Buffer[] {
    this.rest = Buffer.concat([this.rest, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      let len = 0;
      let scale = 1;
      let i = 0;
      let done = false;
      while (i < this.rest.length && i < 5) {
        const byte = this.rest[i++]!;
        len += (byte & 0x7f) * scale;
        scale *= 0x80;
        if (!(byte & 0x80)) {
          done = true;
          break;
        }
      }
      if (!done) {
        if (i >= 5) throw new Error("not a frame: the length does not end");
        break;
      }
      if (len > this.maxBytes) throw new Error("not a frame: too long");
      if (this.rest.length < i + len) break;
      frames.push(this.rest.subarray(i, i + len));
      this.rest = this.rest.subarray(i + len);
    }
    return frames;
  }
}
