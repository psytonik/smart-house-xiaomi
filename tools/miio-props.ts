// Read-only: asks the vacuum for a range of MIoT properties and prints what it answers.
// Shows only code, a short value preview and its length. Changes nothing, never prints the token.
//   cd backend && node_modules/.bin/tsx --env-file=.env ../tools/miio-props.ts <siid> <piidFrom> <piidTo>
import { MiioDevice } from "../backend/src/miio.js";

const [siid, from, to] = process.argv.slice(2).map(Number);
if (!siid || !from || !to || to < from || to - from > 30) {
  console.error("usage: miio-props.ts <siid> <piidFrom> <piidTo>   (at most 31 properties)");
  process.exit(1);
}
const { VACUUM_IP, VACUUM_TOKEN } = process.env;
if (!VACUUM_IP || !VACUUM_TOKEN) {
  console.error("VACUUM_IP and VACUUM_TOKEN must be in backend/.env");
  process.exit(1);
}
void (async () => {
  const dev = new MiioDevice(VACUUM_IP, VACUUM_TOKEN);
  const params = Array.from({ length: to - from + 1 }, (_, i) => ({ did: "x", siid, piid: from + i }));
  let rows: Array<{ piid: number; code: number; value?: unknown }>;
  try {
    rows = (await dev.call("get_properties", params)) as typeof rows;
  } catch (e) {
    console.error(`${(e as Error).message}. Try fewer properties (a range of 8-10) or wake the vacuum first.`);
    process.exit(2);
  }
  for (const r of rows) {
    const text = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
    const preview = text === undefined ? "" : text.length > 60 ? `${text.slice(0, 60)}… (${text.length} chars)` : text;
    console.log(`siid ${siid} piid ${r.piid}: code ${r.code}  ${preview}`);
  }
})();
