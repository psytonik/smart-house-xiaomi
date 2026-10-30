/**
 * Xiaomi cloud helper for the vacuum map. Run from backend/:
 *   node_modules/.bin/tsx --env-file=.env ../tools/xiaomi-cloud.ts login
 *   node_modules/.bin/tsx --env-file=.env ../tools/xiaomi-cloud.ts map
 *
 * `login` asks for your Xiaomi account and password in the terminal (the password is not echoed and is never
 * saved). It stores only the session keys in backend/data/xiaomi-session.json (mode 600, git-ignored).
 * `map` reads the robot's map file name from the robot, downloads that file from the cloud and writes the raw file and a
 * picture (vacuum-map-live.png) next to the session file. Nothing here is printed except status lines.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { MiioDevice } from "../backend/src/miio.js";
import { CloudError, deviceData, downloadCloudBytes, downloadCloudFile, idsFromObjectName, listDevices, saveSession, sessionPath, userAgent, type CloudSession } from "../backend/src/xiaomiCloud.js";
import { Vacuum } from "../backend/src/vacuum.js";
import { decodeCloudMap, renderGridPng, renderMapPng, unpackFrame } from "../backend/src/vacuumMap.js";

const DATA_DIR = join(process.cwd(), "data");

const md5hex = (s: string) => createHash("md5").update(s).digest("hex");
const parseJson = (text: string) => JSON.parse(text.replace("&&&START&&&", ""));

// ---------- password prompt without echo ----------
async function ask(question: string, hidden = false): Promise<string> {
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

// ---------- login (cookie jar, optional 2FA by code) ----------
type Jar = Map<string, string>;

async function http(jar: Jar, url: string, init: { method?: string; headers?: Record<string, string>; body?: URLSearchParams; follow?: boolean } = {}): Promise<{ status: number; text: string; headers: Headers; url: string }> {
  let target = url;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; hop < 8; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(target, { method, body, redirect: "manual", headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const m = line.match(/^([^=;]+)=([^;]*)/);
      if (!m) continue;
      if (m[2] === "" || m[2] === "EXPIRED") jar.delete(m[1]!);
      else jar.set(m[1]!, m[2]!);
    }
    const next = res.headers.get("location");
    if (init.follow && next && res.status >= 300 && res.status < 400) {
      target = new URL(next, target).toString();
      method = "GET";
      body = undefined;
      continue;
    }
    return { status: res.status, text: await res.text(), headers: res.headers, url: target };
  }
  throw new Error("too many redirects");
}

const LOCALE = "en_US";

async function twoFactor(jar: Jar, headers: Record<string, string>, notificationUrl: string): Promise<boolean> {
  const verifyUrl = notificationUrl.startsWith("http") ? notificationUrl : `https://account.xiaomi.com${notificationUrl}`;
  const context = new URL(verifyUrl).searchParams.get("context") ?? "";
  if (!context) throw new Error("2FA link has no context");
  await http(jar, verifyUrl, { headers, follow: true });

  const list = await http(jar, `https://account.xiaomi.com/identity/list?${new URLSearchParams({ sid: "xiaomiio", context, _locale: LOCALE })}`, { headers });
  const options: number[] = parseJson(list.text).options ?? [];
  const flag = options.includes(4) ? 4 : options.includes(8) ? 8 : (parseJson(list.text).flag ?? 4);
  const kind = flag === 4 ? "Phone" : "Email";
  const q = (extra: Record<string, string> = {}) => new URLSearchParams({ sid: "xiaomiio", context, mask: "0", _locale: LOCALE, ...extra });

  const v = parseJson((await http(jar, `https://account.xiaomi.com/identity/auth/verify${kind}?${q({ _flag: String(flag), _json: "true" })}`, { headers })).text);
  if (v.code !== 0) {
    console.log(`Xiaomi refused to start the code check (${v.description ?? v.message ?? v.code}). Wait a few minutes and try again.`);
    return false;
  }
  const sent = parseJson(
    (
      await http(jar, `https://account.xiaomi.com/identity/auth/send${kind}Ticket?${q({ _dc: String(Date.now()) })}`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ retry: "0", icode: "", _json: "true", ick: jar.get("ick") ?? "" }),
      })
    ).text,
  );
  if (sent.code !== 0) {
    console.log(`Xiaomi could not send the code (${sent.description ?? sent.message ?? sent.code}). Wait a few minutes and try again.`);
    return false;
  }
  const code = await ask(`A code was sent to ${v.maskedPhone ?? v.maskedEmail ?? "you"} by Xiaomi. Enter it: `);
  if (!code) return false;

  const res = await http(jar, `https://account.xiaomi.com/identity/auth/verify${kind}?${q({ _flag: String(flag), _json: "true" })}`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ _flag: String(flag), ticket: code, trust: "false", _json: "true", ick: jar.get("ick") ?? "" }),
  });
  let location: string | undefined = res.headers.get("location") ?? undefined;
  try {
    const j = parseJson(res.text);
    if (j.code !== 0) {
      console.log(`The code was not accepted (${j.description ?? j.message ?? j.code}).`);
      return false;
    }
    location = j.location ?? location;
  } catch {
    /* a redirect without a body is fine */
  }
  if (!location) {
    console.log("Xiaomi accepted the code but gave no next step (location missing).");
    return false;
  }
  await http(jar, location, { headers, follow: true });
  return true;
}

async function login(): Promise<void> {
  const clientId = Array.from(randomBytes(16), (b) => String.fromCharCode(97 + (b % 26))).join("");
  const headers = { "User-Agent": userAgent(clientId), "Content-Type": "application/x-www-form-urlencoded" };
  const jar: Jar = new Map([["sdkVersion", "3.8.6"], ["deviceId", clientId]]);

  const user = await ask("Xiaomi account (email, phone or ID): ");
  const password = await ask("Password (not shown): ", true);
  if (!user || !password) throw new Error("account and password are required");

  const j1 = parseJson((await http(jar, "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true", { headers })).text);
  const body = new URLSearchParams({
    user,
    hash: md5hex(password).toUpperCase(),
    callback: "https://sts.api.io.mi.com/sts",
    sid: "xiaomiio",
    qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
    _sign: j1._sign ?? "",
  });
  const j2 = parseJson((await http(jar, "https://account.xiaomi.com/pass/serviceLoginAuth2?_json=true", { method: "POST", headers, body })).text);

  let location: string | undefined = j2.location;
  let ssecurity: string | undefined = j2.ssecurity;
  let userId: string | undefined = j2.userId !== undefined ? String(j2.userId) : undefined;

  if (!location) {
    if (j2.notificationUrl) {
      if (!(await twoFactor(jar, headers, String(j2.notificationUrl)))) {
        process.exitCode = 1;
        return;
      }
      // after the check the browser-style session is trusted: ask for the service location again
      const again = parseJson((await http(jar, "https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true", { headers })).text);
      location = again.location;
      ssecurity = again.ssecurity ?? ssecurity;
      userId = again.userId !== undefined ? String(again.userId) : userId;
      if (!location) {
        console.log("The code was accepted, but Xiaomi still did not return a login link. Tell Claude.");
        process.exitCode = 1;
        return;
      }
    } else if (j2.captchaUrl) {
      console.log("Xiaomi asks for a captcha. Log in once at https://account.xiaomi.com in your browser, then run login again.");
      process.exitCode = 1;
      return;
    } else {
      console.log(`Login failed (${j2.desc ?? j2.description ?? "wrong account or password"}).`);
      process.exitCode = 1;
      return;
    }
  }

  await http(jar, location, { headers });
  const serviceToken = jar.get("serviceToken");
  if (!serviceToken || !ssecurity || !userId) throw new Error("login worked but the session keys are incomplete");

  const session: CloudSession = { serviceToken, ssecurity, userId, clientId };
  saveSession(DATA_DIR, session);
  console.log(`Logged in. Session saved to ${sessionPath(DATA_DIR)} (mode 600). The password was not saved.`);
}

// ---------- map ----------
async function map(): Promise<void> {
  if (!process.env.VACUUM_IP || !process.env.VACUUM_TOKEN) throw new Error("VACUUM_IP / VACUUM_TOKEN are not set in .env");
  const robot = new Vacuum(new MiioDevice(process.env.VACUUM_IP, process.env.VACUUM_TOKEN));
  const objectName = await robot.mapObjectName();
  console.log("Map file name read from the robot.");

  let text: string;
  try {
    text = await downloadCloudFile(DATA_DIR, objectName);
  } catch (e) {
    console.log(e instanceof CloudError ? e.message : `The download failed (${e instanceof Error ? e.message : String(e)}).`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "vacuum-map.raw"), text);
  console.log(`Downloaded ${text.length} bytes to data/vacuum-map.raw.`);

  try {
    const m = decodeCloudMap(text);
    writeFileSync(join(DATA_DIR, "vacuum-map-live.png"), renderMapPng(m));
    console.log(`Map "${m.name}": ${m.width}x${m.height} cells of ${m.gridMm / 10} cm, dock ${m.charger ? "found" : "not in the frame"}. Picture saved to data/vacuum-map-live.png.`);
  } catch (e) {
    console.log(`The file was downloaded but is not a map I can read (${e instanceof Error ? e.message : String(e)}). Keep data/vacuum-map.raw and tell Claude.`);
    process.exitCode = 1;
  }
}

// ---------- frames (read-only look at what the robot reports while it moves) ----------
async function frames(): Promise<void> {
  if (!process.env.VACUUM_IP || !process.env.VACUUM_TOKEN) throw new Error("VACUUM_IP / VACUUM_TOKEN are not set in .env");
  const robot = new Vacuum(new MiioDevice(process.env.VACUUM_IP, process.env.VACUUM_TOKEN));
  const ids = idsFromObjectName(await robot.mapObjectName());
  if (!ids) throw new Error("could not read the account and device ids from the map file name");
  await robot.requestMap();
  console.log("Asked the robot to send its map. Waiting 4 seconds...");
  await new Promise((r) => setTimeout(r, 4000));

  let rows;
  try {
    rows = await deviceData(DATA_DIR, ids, "6.1", 10);
  } catch (e) {
    console.log(e instanceof CloudError ? e.message : `The request failed (${e instanceof Error ? e.message : String(e)}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`${rows.length} frames from the cloud (newest first).`);
  for (const row of rows) {
    const when = new Date(row.time * 1000).toISOString();
    try {
      const parsed = JSON.parse(row.value);
      const packed = String(Array.isArray(parsed) ? parsed[0] : row.value);
      if (packed.includes(",")) {
        console.log(`${when}: encrypted frame (needs the model key), skipped`);
        continue;
      }
      const raw = unpackFrame(packed);
      const w = raw.readUInt16LE(19);
      const h = raw.readUInt16LE(21);
      let tail: string[] = [];
      try {
        tail = Object.keys(JSON.parse(raw.subarray(27 + w * h).toString("utf8")));
      } catch {
        /* no JSON tail */
      }
      console.log(`${when} type ${String.fromCharCode(raw.readUInt8(4))} map ${raw.readUInt16LE(0)} frame ${raw.readUInt16LE(2)} ${w}x${h} robot(${raw.readInt16LE(5)},${raw.readInt16LE(7)}) dock(${raw.readInt16LE(11)},${raw.readInt16LE(13)}) tail:[${tail.join(",")}]`);
    } catch (e) {
      console.log(`${when}: could not read (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

// ---------- explore: where does the app's detailed map come from? (read-only, prints summaries only) ----------
const histogram = (cells: Uint8Array | Buffer) => {
  const h: Record<string, number> = {};
  for (const v of cells) h[v] = (h[v] ?? 0) + 1;
  return Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([v, n]) => `${v}:${n}`).join(" ");
};

function describeFrame(packed: string): string {
  const raw = unpackFrame(packed);
  const w = raw.readUInt16LE(19);
  const h = raw.readUInt16LE(21);
  const cells = raw.subarray(27, 27 + w * h);
  return `type ${String.fromCharCode(raw.readUInt8(4))} map ${raw.readUInt16LE(0)} ${w}x${h} grid ${raw.readUInt16LE(17)} left/top ${raw.readInt16LE(23)},${raw.readInt16LE(25)} cells {${histogram(cells)}}`;
}

async function explore(): Promise<void> {
  if (!process.env.VACUUM_IP || !process.env.VACUUM_TOKEN) throw new Error("VACUUM_IP / VACUUM_TOKEN are not set in .env");
  const device = new MiioDevice(process.env.VACUUM_IP, process.env.VACUUM_TOKEN);
  const robot = new Vacuum(device);

  // 1. the file names the robot reports for its maps (6/8 and 6/9); only the last part (the slot) is printed
  const names = new Map<string, string>();
  for (const piid of [8, 9]) {
    try {
      const rows = (await device.call("get_properties", [{ did: "x", siid: 6, piid }])) as Array<{ code?: number; value?: unknown }>;
      const parsed = JSON.parse(String(rows?.[0]?.value)) as { object_name?: string };
      const full = String(parsed.object_name ?? "");
      const [path, key] = full.split(",");
      console.log(`6/${piid}: slot ${path?.split("/").pop() ?? "?"}${key ? ", has a key (encrypted)" : ""}; other fields: ${Object.keys(parsed).filter((k) => k !== "object_name").join(",") || "none"}`);
      if (path && !key) names.set(`6/${piid}`, path);
    } catch (e) {
      console.log(`6/${piid}: unreadable (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 2. download each distinct file and say what is in it
  mkdirSync(DATA_DIR, { recursive: true });
  const seen = new Set<string>();
  for (const [label, name] of names) {
    if (seen.has(name)) {
      console.log(`${label}: same file as above`);
      continue;
    }
    seen.add(name);
    try {
      const text = await downloadCloudFile(DATA_DIR, name);
      writeFileSync(join(DATA_DIR, `explore-${label.replace("/", "-")}.raw`), text);
      console.log(`${label}: ${text.length} bytes, saved to data/explore-${label.replace("/", "-")}.raw`);
      const outer = JSON.parse(text) as { mapstr?: Array<{ id?: number; name?: string; map?: string }>; curr_id?: number } & Record<string, unknown>;
      console.log(`  top-level keys: ${Object.keys(outer).join(",")}; curr_id ${outer.curr_id}`);
      for (const m of outer.mapstr ?? []) console.log(`  slot id ${m.id} "${m.name}": ${m.map ? describeFrame(m.map) : "no map"}`);
    } catch (e) {
      console.log(`${label}: could not read (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 3. what the robot has reported to the cloud under 6.x keys
  const ids = idsFromObjectName([...names.values()][0] ?? "");
  if (!ids) return;
  await robot.requestMap().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  for (const key of ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9"]) {
    try {
      const rows = await deviceData(DATA_DIR, ids, key, key === "6.1" ? 300 : 3);
      console.log(`cloud ${key}: ${rows.length} rows`);
      if (key !== "6.1") {
        for (const r of rows.slice(0, 1)) console.log(`  newest ${new Date(r.time * 1000).toISOString()} length ${r.value.length} starts ${JSON.stringify(r.value.slice(0, 40))}`);
        continue;
      }
      const kinds = new Map<string, number>();
      let biggest = { cells: 0, text: "" };
      for (const r of rows) {
        let list: unknown;
        try {
          list = JSON.parse(r.value);
        } catch {
          continue;
        }
        for (const item of Array.isArray(list) ? list : [list]) {
          const packed = String(item);
          if (packed.includes(",")) {
            kinds.set("encrypted", (kinds.get("encrypted") ?? 0) + 1);
            continue;
          }
          try {
            const raw = unpackFrame(packed);
            const w = raw.readUInt16LE(19);
            const h = raw.readUInt16LE(21);
            const k = `${String.fromCharCode(raw.readUInt8(4))} map ${raw.readUInt16LE(0)}`;
            kinds.set(k, (kinds.get(k) ?? 0) + 1);
            if (w * h > biggest.cells) biggest = { cells: w * h, text: describeFrame(packed) };
          } catch {
            kinds.set("unreadable", (kinds.get("unreadable") ?? 0) + 1);
          }
        }
      }
      console.log(`  kinds: ${[...kinds].map(([k, n]) => `${k} x${n}`).join("; ")}`);
      console.log(`  biggest: ${biggest.text}`);
    } catch (e) {
      console.log(`cloud ${key}: ${e instanceof CloudError ? e.message : String(e)}`);
    }
  }
}

/** Downloads the map backup the robot listed in 6/9 (an archive of the saved map) to data/explore-backup.bin. Prints only size and file type. */
async function backup(): Promise<void> {
  const list = JSON.parse(readFileSync(join(DATA_DIR, "explore-6-9.raw"), "utf8")) as Array<{ id?: number; info?: Array<{ objname?: string; time?: number }> }>;
  const wanted = list.flatMap((e) => e.info ?? []).map((i) => i.objname).filter((n): n is string => typeof n === "string");
  if (!wanted.length) throw new Error("no backup listed in data/explore-6-9.raw: run `explore` first");
  for (const [i, name] of wanted.entries()) {
    let bytes: Buffer;
    try {
      bytes = await downloadCloudBytes(DATA_DIR, name);
    } catch (e) {
      console.log(`backup ${i}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    writeFileSync(join(DATA_DIR, `explore-backup-${i}.bin`), bytes);
    console.log(`backup ${i}: ${bytes.length} bytes, starts ${bytes.subarray(0, 4).toString("hex")} (${bytes.subarray(0, 3).toString("ascii").replace(/[^\x20-\x7e]/g, "?")}), saved to data/explore-backup-${i}.bin`);
  }
}

/** Puts the map pieces the robot sent while cleaning (6.1 frames) together into one picture and says which cell values occur. */
async function assemble(): Promise<void> {
  if (!process.env.VACUUM_IP || !process.env.VACUUM_TOKEN) throw new Error("VACUUM_IP / VACUUM_TOKEN are not set in .env");
  const robot = new Vacuum(new MiioDevice(process.env.VACUUM_IP, process.env.VACUUM_TOKEN));
  const ids = idsFromObjectName(await robot.mapObjectName());
  if (!ids) throw new Error("could not read the account and device ids from the map file name");
  await robot.requestMap().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  const rows = await deviceData(DATA_DIR, ids, "6.1", 1000);

  type Piece = { mapId: number; type: string; grid: number; left: number; top: number; w: number; h: number; cells: Buffer };
  const pieces: Piece[] = [];
  for (const row of [...rows].reverse()) {
    let list: unknown;
    try {
      list = JSON.parse(row.value);
    } catch {
      continue;
    }
    for (const item of Array.isArray(list) ? list : [list]) {
      const packed = String(item);
      if (packed.includes(",")) continue;
      try {
        const raw = unpackFrame(packed);
        const w = raw.readUInt16LE(19);
        const h = raw.readUInt16LE(21);
        if (!w || !h || raw.length < 27 + w * h) continue;
        pieces.push({ mapId: raw.readUInt16LE(0), type: String.fromCharCode(raw.readUInt8(4)), grid: raw.readUInt16LE(17), left: raw.readInt16LE(23), top: raw.readInt16LE(25), w, h, cells: raw.subarray(27, 27 + w * h) });
      } catch {
        /* skip damaged frames */
      }
    }
  }
  const counts = new Map<number, number>();
  for (const p of pieces) counts.set(p.mapId, (counts.get(p.mapId) ?? 0) + 1);
  const mapId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  console.log(`${rows.length} rows, ${pieces.length} frames; maps: ${[...counts].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  const use = pieces.filter((p) => p.mapId === mapId && p.grid > 0);
  if (!use.length) {
    console.log("nothing to put together");
    return;
  }
  const grid = use[0]!.grid;
  const left = Math.min(...use.map((p) => p.left));
  const top = Math.min(...use.map((p) => p.top));
  const right = Math.max(...use.map((p) => p.left + p.w * grid));
  const bottom = Math.max(...use.map((p) => p.top + p.h * grid));
  const width = Math.round((right - left) / grid);
  const height = Math.round((bottom - top) / grid);
  if (width * height > 4_000_000) throw new Error(`the assembled map would be too large (${width}x${height})`);
  const canvas = new Uint8Array(width * height);
  for (const p of use) {
    const ox = Math.round((p.left - left) / grid);
    const oy = Math.round((p.top - top) / grid);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const v = p.cells[y * p.w + x]!;
      if (v !== 0) canvas[(oy + y) * width + ox + x] = v; // later pieces overwrite earlier ones
    }
  }
  console.log(`map ${mapId}: ${use.length} frames put together into ${width}x${height} cells of ${grid} mm, left/top ${left},${top}. Values: ${histogram(canvas)}`);
  const palette = (v: number): [number, number, number, number] | undefined => {
    if (v === 0) return undefined;
    const hue = (v * 47) % 360;
    const c = (n: number) => Math.round(120 + 110 * Math.cos(((hue + n) * Math.PI) / 180));
    return [c(0), c(120), c(240), 255];
  };
  // the same pieces drawn over the saved floor plan, one colour per value: 4 green, 8 yellow, 248 orange, 252 pink
  try {
    const base = decodeCloudMap(readFileSync(join(DATA_DIR, "vacuum-map.raw"), "utf8"));
    const merged = Uint8Array.from(base.cells);
    const dx = Math.round((left - base.leftMm) / base.gridMm);
    const dy = Math.round((top - base.topMm) / base.gridMm);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = canvas[y * width + x]!;
      const mx = x + dx;
      const my = y + dy;
      if (v && mx >= 0 && my >= 0 && mx < base.width && my < base.height) merged[my * base.width + mx] = v;
    }
    const colors: Record<number, [number, number, number, number]> = { 1: [54, 70, 98, 255], 129: [170, 190, 225, 255], 4: [80, 220, 120, 255], 8: [250, 230, 80, 255], 248: [255, 150, 40, 255], 252: [255, 70, 190, 255] };
    writeFileSync(join(DATA_DIR, "live-combined.png"), renderGridPng(base.width, base.height, merged, (v) => colors[v], 6));
    console.log("Also saved data/live-combined.png (the floor plan with these values on top: 4 green, 8 yellow, 248 orange, 252 pink).");
  } catch (e) {
    console.log(`Could not draw the combined picture (${e instanceof Error ? e.message : String(e)}).`);
  }
  writeFileSync(join(DATA_DIR, "live-assembled.png"), renderGridPng(width, height, canvas, palette, 6));
  writeFileSync(join(DATA_DIR, "live-assembled.bin"), canvas);
  console.log("Picture saved to data/live-assembled.png (each cell value has its own colour).");
}

/**
 * Finds the robot in the Xiaomi account and puts its current token into backend/.env. Needed after the robot was added again
 * (a new app, another region, a Wi-Fi reset): the token changes and the old one is silently ignored by the robot.
 * Each token the cloud offers is tried on the live robot first, and nothing is printed that could be used as a key.
 */
async function token(): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  const envText = readFileSync(envPath, "utf8");
  const read = (key: string) => envText.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  const ip = read("VACUUM_IP");
  const current = read("VACUUM_TOKEN");
  if (!ip) throw new Error("VACUUM_IP is not set in backend/.env");

  let devices;
  try {
    devices = await listDevices(DATA_DIR);
  } catch (e) {
    console.log(e instanceof CloudError ? e.message : `The request failed (${e instanceof Error ? e.message : String(e)}).`);
    process.exitCode = 1;
    return;
  }
  const robots = devices.filter((d) => d.model.startsWith("dreame.vacuum") || d.localip === ip);
  console.log(`${devices.length} devices in the account, ${robots.length} look like the robot:`);
  for (const d of robots) console.log(`  "${d.name}" ${d.model}, region ${d.region}, ${d.isOnline ? "online" : "offline"}, address ${d.localip ?? "unknown"}, ${d.token === current ? "same key as in .env" : "different key from .env"}`);
  if (!robots.length) {
    console.log("No robot in this account. Is it added under the same Xiaomi account and region you logged in with?");
    process.exitCode = 1;
    return;
  }

  // the robot at the address we know first, online first
  const ordered = [...robots].sort((a, b) => Number(b.localip === ip) - Number(a.localip === ip) || Number(b.isOnline) - Number(a.isOnline));
  for (const d of ordered) {
    for (const address of new Set([ip, d.localip].filter((a): a is string => !!a))) {
      try {
        await new MiioDevice(address, d.token, 54321, 4000).call("get_properties", [{ did: "x", siid: 2, piid: 1 }]);
      } catch {
        continue;
      }
      let next = envText.replace(/^VACUUM_TOKEN=.*$/m, `VACUUM_TOKEN=${d.token}`);
      if (address !== ip) next = next.replace(/^VACUUM_IP=.*$/m, `VACUUM_IP=${address}`);
      if (d.token === current && address === ip) {
        console.log("The robot answers with the key already in .env: nothing to change. The problem is somewhere else.");
        return;
      }
      writeFileSync(envPath, next);
      console.log(`The robot answered at ${address}. backend/.env updated (${d.token !== current ? "new key" : "same key"}${address !== ip ? `, new address ${address}` : ""}). Restart the server: ./camera.sh stop && ./camera.sh`);
      return;
    }
  }
  console.log("None of the keys from the cloud works on the robot at its known address. Is it awake and on Wi-Fi (put it on the dock)? If the address changed, set VACUUM_IP in backend/.env and run this again.");
  process.exitCode = 1;
}

/**
 * history: does the cloud keep anything per cleaning? Asks for stored properties and events under many keys and prints only
 * counts and the shape of the newest row (cleaning data, no secrets). Read-only.
 */
async function history(): Promise<void> {
  if (!process.env.VACUUM_IP || !process.env.VACUUM_TOKEN) throw new Error("VACUUM_IP / VACUUM_TOKEN are not set in .env");
  const ids = idsFromObjectName(await new Vacuum(new MiioDevice(process.env.VACUUM_IP, process.env.VACUUM_TOKEN)).mapObjectName());
  if (!ids) throw new Error("could not read the account and device ids from the robot's map name");
  const [showType, showKey] = [process.argv[3], process.argv[4]];
  if (showType && showKey) {
    // history <prop|event> <siid.piid>: the newest rows in full, with long strings shortened (they can hold file names)
    for (const r of await deviceData(DATA_DIR, ids, showKey, 30, process.env, showType)) {
      const shown = r.value.replace(/"([^"]{40,})"/g, (_m, t: string) => `"${t.slice(0, 12)}…(${t.length})"`);
      console.log(`${new Date(r.time * 1000).toISOString()} ${shown}`);
    }
    return;
  }
  const keys: Array<[string, string]> = [];
  for (const piid of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]) keys.push(["prop", `4.${piid}`]);
  for (const siid of [2, 3, 4, 5, 6, 7, 8, 12]) for (const eiid of [1, 2, 3, 4]) keys.push(["event", `${siid}.${eiid}`]);
  keys.push(["prop", "12.2"], ["prop", "12.3"], ["prop", "12.4"], ["prop", "2.1"], ["prop", "3.1"]);
  for (const [type, key] of keys) {
    try {
      const rows = await deviceData(DATA_DIR, ids, key, 5, process.env, type);
      if (!rows.length) continue;
      const r = rows[0]!;
      console.log(`${type} ${key}: ${rows.length} rows, newest ${new Date(r.time * 1000).toISOString()} length ${r.value.length} starts ${JSON.stringify(r.value.slice(0, 80))}`);
    } catch (e) {
      console.log(`${type} ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("done");
}

const command = process.argv[2];
(async () => {
  if (command === "login") await login();
  else if (command === "map") await map();
  else if (command === "frames") await frames();
  else if (command === "explore") await explore();
  else if (command === "backup") await backup();
  else if (command === "assemble") await assemble();
  else if (command === "token") await token();
  else if (command === "history") await history();
  else console.log("usage: xiaomi-cloud.ts login | map | frames | explore | backup | assemble | token | history [prop|event key]");
})().catch((e) => {
  console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
