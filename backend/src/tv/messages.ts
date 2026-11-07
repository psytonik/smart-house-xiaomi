import { bufOf, enc, fields, frame, intOf, strOf } from "./wire.js";

/**
 * The messages of the Android TV Remote protocol v2 (Google TV, Android TV), as far as a remote needs them. Field numbers and
 * the key codes are from the protocol's published schema (the Android KeyEvent codes); nothing here talks to a TV by itself.
 */

/** What can be pressed. The values are Android's KEYCODE_* numbers. */
export const KEYS = {
  power: 26,
  home: 3,
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  ok: 23,
  volumeUp: 24,
  volumeDown: 25,
  mute: 164,
  menu: 82,
  settings: 176,
  input: 178,
  channelUp: 166,
  channelDown: 167,
  playPause: 85,
  play: 126,
  pause: 127,
  stop: 86,
  next: 87,
  previous: 88,
  rewind: 89,
  fastForward: 90,
  info: 165,
  guide: 172,
  tv: 170,
  search: 84,
  captions: 175,
  enter: 66,
  backspace: 67,
  hdmi1: 243,
  hdmi2: 244,
  hdmi3: 245,
  hdmi4: 246,
  red: 183,
  green: 184,
  yellow: 185,
  blue: 186,
  "0": 7,
  "1": 8,
  "2": 9,
  "3": 10,
  "4": 11,
  "5": 12,
  "6": 13,
  "7": 14,
  "8": 15,
  "9": 16,
} as const;
export type TvKey = keyof typeof KEYS;
export const KEY_NAMES = Object.keys(KEYS) as TvKey[];

/**
 * Apps the remote can open. A fixed list: nothing free-form is ever sent to the TV. An app opens either by a link (over the remote
 * protocol: the TV opens the app, or the page of it) or, for an app that was installed by hand, by the component of its launcher
 * (over ADB, so it is offered only when ADB is set up).
 */
export const APPS: Record<string, { label: string; link?: string; component?: string }> = {
  youtube: { label: "YouTube", link: "https://www.youtube.com" },
  netflix: { label: "Netflix", link: "https://www.netflix.com/browse" },
  prime: { label: "Prime Video", link: "https://app.primevideo.com" },
  disney: { label: "Disney+", link: "https://www.disneyplus.com" },
  twitch: { label: "Twitch", link: "https://www.twitch.tv" },
  prisma: { label: "Prisma", component: "top.rootu.prisma/.ConnectActivity" },
  ottplay: { label: "OTT Player", component: "com.ott_play/com.ottplay.ott_play.MainActivity" },
};
export type TvApp = string;
export const APP_IDS = Object.keys(APPS);

// ---------- pairing (port 6467) ----------
const PROTOCOL = 2;
const STATUS_OK = 200;
const HEX = 3; // the code is typed as hexadecimal characters
const CODE_LENGTH = 6;
const ROLE_INPUT = 1;

const pairingMessage = (...payload: Buffer[]) => frame(Buffer.concat([enc.int(1, PROTOCOL), enc.int(2, STATUS_OK), ...payload]));
const encoding = () => [enc.int(1, HEX), enc.int(2, CODE_LENGTH)];

export const pairing = {
  request: (serviceName: string, clientName: string) => pairingMessage(enc.msg(10, enc.str(1, serviceName), enc.str(2, clientName))),
  option: () => pairingMessage(enc.msg(20, enc.msg(1, ...encoding()), enc.int(3, ROLE_INPUT))),
  configuration: () => pairingMessage(enc.msg(30, enc.msg(1, ...encoding()), enc.int(2, ROLE_INPUT))),
  secret: (secret: Buffer) => pairingMessage(enc.msg(40, enc.bytes(1, secret))),

  /** What the TV said. `status` is 200 when all is well. */
  parse(message: Buffer): { status: number; kind: "request-ack" | "option" | "configuration-ack" | "secret-ack" | "other"; secret?: Buffer } {
    const f = fields(message);
    const status = intOf(f, 2) ?? 0;
    if (bufOf(f, 11)) return { status, kind: "request-ack" };
    if (bufOf(f, 20)) return { status, kind: "option" };
    if (bufOf(f, 31)) return { status, kind: "configuration-ack" };
    const ack = bufOf(f, 41);
    if (ack) return { status, kind: "secret-ack", secret: bufOf(fields(ack), 1) };
    return { status, kind: "other" };
  },
};

// ---------- remote (port 6466) ----------
/** The feature flags both sides announce; the TV is told the same number it sent. */
const FEATURES = 622;
const SHORT = 3; // a key press and release

export const remote = {
  configure: (model: string, vendor: string, packageName: string, version: string) =>
    frame(enc.msg(1, enc.int(1, FEATURES), enc.msg(2, enc.str(1, model), enc.str(2, vendor), enc.int(3, 1), enc.str(4, "1"), enc.str(5, packageName), enc.str(6, version)))),
  setActive: () => frame(enc.msg(2, enc.int(1, FEATURES))),
  pong: (val: number) => frame(enc.msg(9, enc.int(1, val))),
  key: (code: number, direction = SHORT) => frame(enc.msg(10, enc.int(1, code), enc.int(2, direction))),
  appLink: (link: string) => frame(enc.msg(90, enc.str(1, link))),

  /** What the TV said, in the parts a remote cares about. */
  parse(message: Buffer):
    | { kind: "configure" }
    | { kind: "set-active" }
    | { kind: "ping"; value: number }
    | { kind: "power"; on: boolean }
    | { kind: "volume"; level: number; max: number; muted: boolean }
    | { kind: "app"; app: string }
    | { kind: "error" }
    | { kind: "other" } {
    const f = fields(message);
    const sub = (field: number) => {
      const b = bufOf(f, field);
      return b ? fields(b) : undefined;
    };
    if (bufOf(f, 1)) return { kind: "configure" };
    if (bufOf(f, 2)) return { kind: "set-active" };
    const ping = sub(8);
    if (ping) return { kind: "ping", value: intOf(ping, 1) ?? 0 };
    const start = sub(40);
    if (start) return { kind: "power", on: intOf(start, 1) === 1 };
    const volume = sub(50);
    if (volume) return { kind: "volume", level: intOf(volume, 7) ?? 0, max: intOf(volume, 6) ?? 100, muted: intOf(volume, 8) === 1 };
    const ime = sub(20);
    const info = ime && bufOf(ime, 1);
    const app = info && strOf(fields(info), 12);
    if (app) return { kind: "app", app };
    if (bufOf(f, 3)) return { kind: "error" };
    return { kind: "other" };
  },
};
