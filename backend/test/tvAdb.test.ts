import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TvError } from "../src/tv.js";
import { findAdb, parseSources, TvAdb } from "../src/tvAdb.js";

/** The part of a real `adb shell dumpsys tv_input` of a TCL Google TV that says what inputs there are. */
const DUMPSYS = `
  inputMap: inputId -> TvInputState
    com.tcl.tvinput/.TDTVInputService/HW1413742848: info: TvInputInfo{id=com.tcl.tvinput/.TDTVInputService/HW1413742848, pkg=com.tcl.tvinput}; state: 0
    com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413743104: info: TvInputInfo{id=com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413743104}; state: 0
  1413742848: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413742848, type=2, audio_type=-2147467264, audio_addr=1, cable_connection_status=0}, mInfo: null }
  1413743104: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413743104, type=3, audio_type=-2147450880, audio_addr=11, cable_connection_status=0}, mInfo: null }
  1413743616: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413743616, type=7, audio_type=-2147450880, audio_addr=51, cable_connection_status=0}, mInfo: null }
  1413744128: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413744128, type=9, audio_type=-2147483616, audio_addr=1, hdmi_port=1, cable_connection_status=0}, mInfo: null }
  1413744384: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413744384, type=9, audio_type=-2147483616, audio_addr=2, hdmi_port=2, cable_connection_status=0}, mInfo: null }
  1413744640: Connection{ mHardwareInfo: TvInputHardwareInfo {id=1413744640, type=9, audio_type=-2147483616, audio_addr=3, hdmi_port=3, cable_connection_status=0}, mInfo: null }
  mHardwareInputIdMap: deviceId -> inputId
    1413742848: com.tcl.tvinput/.TDTVInputService/HW1413742848
    1413743104: com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413743104
    1413744128: com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413744128
    1413744384: com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413744384
  mHdmiInputIdMap: id -> inputId
`;

describe("sources of the TV", () => {
  it("lists what the TV has, in the order of its own Source Choice", () => {
    const list = parseSources(DUMPSYS, true);
    assert.deepEqual(list.map((s) => [s.id, s.label]), [["home", "Home"], ["tv", "TV"], ["hdmi1", "HDMI 1"], ["hdmi2", "HDMI 2"], ["av", "AV"], ["media", "Media Player"]]);
    assert.equal(list.find((s) => s.id === "hdmi2")?.inputId, "com.tcl.tvinput/.passthroughinput.TvPassThroughService/HW1413744384");
  });

  it("leaves out what isn't there: a port without an input, no media player", () => {
    const ids = parseSources(DUMPSYS, false).map((s) => s.id);
    assert.ok(!ids.includes("hdmi3"), "HDMI 3 has hardware but no input on this TV");
    assert.ok(!ids.includes("media"));
    assert.deepEqual(parseSources("nothing useful", false).map((s) => s.id), ["home"]);
  });
});

describe("TV over ADB (a pretend adb)", () => {
  let dir: string;
  let adb: string;
  let log: string;
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adb-test-"));
    adb = join(dir, "adb");
    log = join(dir, "calls.log");
    writeFileSync(join(dir, "dumpsys.txt"), DUMPSYS);
    // a stand-in for adb: connect works, dumpsys and pm answer, everything else is just written down
    writeFileSync(
      adb,
      `#!/bin/sh
if [ "$1" = "connect" ]; then echo "connected to $2"; exit 0; fi
if [ -f "${dir}/fail-once" ]; then rm "${dir}/fail-once"; echo "error: device '$2' not found" >&2; exit 1; fi
if [ "$4" = "dumpsys" ]; then cat "${dir}/dumpsys.txt"; exit 0; fi
if [ "$4" = "pm" ]; then echo "package:com.tcl.ui_mediaCenter"; exit 0; fi
echo "$@" >> "${log}"
`,
    );
    chmodSync(adb, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("opens the TV's Source Choice menu with the INPUT key", async () => {
    await new TvAdb("10.0.0.9:5555", adb).openSourceMenu();
    assert.deepEqual(calls(), ["-s 10.0.0.9:5555 shell input keyevent 178"]);
  });

  it("switches to each kind of source the way it works on the TV", async () => {
    const tv = new TvAdb("10.0.0.9:5555", adb);
    assert.deepEqual((await tv.sources()).map((s) => s.id), ["home", "tv", "hdmi1", "hdmi2", "av", "media"]);
    for (const id of ["home", "tv", "hdmi2", "av", "media"]) await tv.switchTo(id);
    assert.deepEqual(calls(), [
      "-s 10.0.0.9:5555 shell input keyevent 3",
      "-s 10.0.0.9:5555 shell input keyevent 170",
      "-s 10.0.0.9:5555 shell am start -a android.intent.action.VIEW -d content://android.media.tv/passthrough/com.tcl.tvinput%2F.passthroughinput.TvPassThroughService%2FHW1413744384",
      "-s 10.0.0.9:5555 shell am start -a android.intent.action.VIEW -d content://android.media.tv/passthrough/com.tcl.tvinput%2F.passthroughinput.TvPassThroughService%2FHW1413743104",
      "-s 10.0.0.9:5555 shell am start -n com.tcl.ui_mediaCenter/.main.MainActivity",
    ]);
  });

  it("refuses a source the TV doesn't have, and sends nothing", async () => {
    const tv = new TvAdb("10.0.0.9:5555", adb);
    for (const bad of ["hdmi3", "hdmi9", "reboot", "; reboot", ""]) await assert.rejects(tv.switchTo(bad), (e: unknown) => e instanceof TvError && e.status === 400, bad);
    assert.deepEqual(calls(), []);
  });

  it("asks the TV what it has once, not on every request", async () => {
    const tv = new TvAdb("10.0.0.9:5555", adb);
    await tv.sources();
    rmSync(join(dir, "dumpsys.txt"));
    assert.equal((await tv.sources()).length, 6, "from memory: the dump file is gone");
  });

  it("connects again when the TV was not connected, and tries the command once more", async () => {
    writeFileSync(join(dir, "fail-once"), "");
    await new TvAdb("10.0.0.9:5555", adb).openSourceMenu();
    assert.deepEqual(calls(), ["-s 10.0.0.9:5555 shell input keyevent 178"]);
    assert.ok(!existsSync(join(dir, "fail-once")));
  });

  it("says so when adb can't be run or the TV doesn't answer", async () => {
    await assert.rejects(new TvAdb("10.0.0.9:5555", join(dir, "no-such-adb")).openSourceMenu(), (e: unknown) => e instanceof TvError && e.status === 503 && /over ADB/.test(e.message));
    writeFileSync(adb, '#!/bin/sh\nif [ "$1" = "connect" ]; then echo "failed to connect to $2"; exit 0; fi\n');
    await assert.rejects(new TvAdb("10.0.0.9:5555", adb).openSourceMenu(), (e: unknown) => e instanceof TvError && e.status === 503);
  });

  it("only takes an address as the target", () => {
    for (const bad of ["", "10.0.0.9 -x", "10.0.0.9:5555; rm", "$(id)", "a b"]) assert.throws(() => new TvAdb(bad, adb), /address/, bad);
    assert.doesNotThrow(() => new TvAdb("tv.local:5555", adb));
  });

  it("finds adb where a Mac keeps it, or where it is told to", () => {
    assert.equal(findAdb({ TV_ADB_PATH: adb }), adb);
    assert.equal(findAdb({ TV_ADB_PATH: join(dir, "missing") }), undefined);
  });
});
