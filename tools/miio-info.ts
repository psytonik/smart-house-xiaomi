// Read-only: asks the vacuum for miIO.info and prints its fields. Nothing is changed.
// Secrets and anything that identifies your network or device are hidden: only the NAMES of those fields are shown.
//   cd backend && node_modules/.bin/tsx --env-file=.env ../tools/miio-info.ts
import { MiioDevice } from "../backend/src/miio.js";

const { VACUUM_IP, VACUUM_TOKEN } = process.env;
if (!VACUUM_IP || !VACUUM_TOKEN) {
  console.error("VACUUM_IP and VACUUM_TOKEN must be in backend/.env");
  process.exit(1);
}
const HIDE = /token|key|mac|ssid|bssid|ip|uid|did|passwd|password|secret|sn|netif/i;

function show(prefix: string, value: unknown): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) show(prefix ? `${prefix}.${k}` : k, v);
    return;
  }
  const name = prefix.split(".").pop() ?? prefix;
  const text = HIDE.test(name) ? "(hidden)" : JSON.stringify(value);
  console.log(`${prefix}: ${text && text.length > 80 ? `${text.slice(0, 80)}… (${text.length})` : text}`);
}

void (async () => {
  try {
    show("", await new MiioDevice(VACUUM_IP, VACUUM_TOKEN).call("miIO.info", []));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
})();
