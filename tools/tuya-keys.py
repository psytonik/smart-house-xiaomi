#!/usr/bin/env python3
"""Fetch the local keys of your Smart Life / Tuya devices without a developer account on iot.tuya.com.

Usage (one time per new bulb):
    python3 -m venv /tmp/tt && /tmp/tt/bin/pip install tuya-device-sharing-sdk "qrcode[pil]" tinytuya
    /tmp/tt/bin/python tools/tuya-keys.py <User Code> <out-dir>

User Code: Smart Life app > Me > settings (gear) > Account and Security > User Code.
It shows a QR code (qr.png in out-dir): scan it in Smart Life (Me > scanner icon) and confirm.
It then writes out-dir/devices.json (id, name, local_key) and prints the id, name and LAN address of each device (keys are not printed).
Copy the entries you want into backend/data/tuya-lights.json (see docs/tuya-lights.md). Delete out-dir afterwards: it holds keys and a login token.
"""
import json, os, sys, time

import qrcode
from tuya_sharing import LoginControl, Manager, SharingTokenListener

CLIENT_ID, SCHEMA = "HA_3y9q4ak7g4ephrvke", "haauthorize"  # the app id Home Assistant uses for this login


class Listener(SharingTokenListener):
    def update_token(self, token_info):
        pass


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    code, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    lc = LoginControl()
    r = lc.qr_code(CLIENT_ID, SCHEMA, code)
    if not r.get("success"):
        sys.exit("login failed: %s" % r.get("msg"))
    token = r["result"]["qrcode"]
    qrcode.make("tuyaSmart--qrLogin?token=" + token).save(os.path.join(out, "qr.png"))
    print("Scan %s in Smart Life and confirm" % os.path.join(out, "qr.png"), flush=True)
    for _ in range(60):
        ok, info = lc.login_result(token, CLIENT_ID, code)
        if ok:
            break
        time.sleep(3)
    else:
        sys.exit("timed out waiting for the scan")
    m = Manager(CLIENT_ID, code, info["terminal_id"], info["endpoint"], info, Listener())
    m.update_device_cache()
    devices = [{"id": d.id, "name": d.name, "local_key": d.local_key} for d in m.device_map.values()]
    with open(os.path.join(out, "devices.json"), "w") as f:
        json.dump(devices, f)
    os.chmod(os.path.join(out, "devices.json"), 0o600)
    try:
        import tinytuya
        found = tinytuya.deviceScan(False, 12)
    except Exception:
        found = {}
    ips = {v.get("gwId"): ip for ip, v in found.items()}
    for d in devices:
        print(d["id"], d["name"], ips.get(d["id"], "address not found"))


main()
