// Read-only: saves what the vacuum reports for services 2, 4 and 5, and shows what changed between two saves.
// Use it to learn which property the Dreame app changes for a setting: save, change the setting IN THE APP, save again, diff.
// Nothing is written to the robot. The token is never printed; saves go to backend/data (git-ignored).
//   cd backend && node_modules/.bin/tsx --env-file=.env ../tools/miio-snap.ts save <name>
//   cd backend && node_modules/.bin/tsx --env-file=.env ../tools/miio-snap.ts diff <nameA> <nameB>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MiioDevice } from "../backend/src/miio.js";

const DATA_DIR = join(process.cwd(), "data"); // run from backend/
const RANGES: Array<[number, number]> = [[2, 12], [4, 30], [5, 12]]; // [siid, last piid]
const CHUNK = 8;

const [command, a, b] = process.argv.slice(2);
const file = (name: string) => join(DATA_DIR, `snap-${name.replace(/[^\w-]/g, "")}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const preview = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 80)}… (${t.length})` : t;
};

async function save(name: string): Promise<void> {
  const { VACUUM_IP, VACUUM_TOKEN } = process.env;
  if (!VACUUM_IP || !VACUUM_TOKEN) throw new Error("VACUUM_IP and VACUUM_TOKEN must be in backend/.env");
  const dev = new MiioDevice(VACUUM_IP, VACUUM_TOKEN);
  const out: Record<string, string> = {};
  for (const [siid, last] of RANGES) {
    for (let from = 1; from <= last; from += CHUNK) {
      const params = Array.from({ length: Math.min(CHUNK, last - from + 1) }, (_, i) => ({ did: "x", siid, piid: from + i }));
      let rows: Array<{ piid: number; code: number; value?: unknown }> | undefined;
      for (let attempt = 0; attempt < 3 && !rows; attempt++) {
        try {
          rows = (await dev.call("get_properties", params)) as typeof rows;
        } catch {
          await sleep(1000);
        }
      }
      if (!rows) {
        console.log(`siid ${siid} piid ${from}-${from + params.length - 1}: no answer, skipped`);
        continue;
      }
      for (const r of rows) if (r.code === 0) out[`${siid}/${r.piid}`] = preview(r.value);
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file(name), JSON.stringify(out, null, 1));
  console.log(`saved ${Object.keys(out).length} properties as "${name}"`);
}

function diff(x: string, y: string): void {
  const A = JSON.parse(readFileSync(file(x), "utf8")) as Record<string, string>;
  const B = JSON.parse(readFileSync(file(y), "utf8")) as Record<string, string>;
  let changed = 0;
  for (const key of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort((p, q) => p.localeCompare(q, undefined, { numeric: true }))) {
    if (A[key] !== B[key]) {
      changed++;
      console.log(`${key}: ${A[key] ?? "(none)"}  ->  ${B[key] ?? "(none)"}`);
    }
  }
  console.log(changed ? `${changed} property(ies) changed` : "nothing changed");
}

void (async () => {
  try {
    if (command === "save" && a) await save(a);
    else if (command === "diff" && a && b) diff(a, b);
    else {
      console.error("usage: miio-snap.ts save <name> | diff <nameA> <nameB>");
      process.exit(1);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
})();
