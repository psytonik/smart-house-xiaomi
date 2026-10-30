"""Read-only Bluetooth LE scan: lists nearby devices. It never connects and never sends anything.

Usage:
    python3 -m pip install bleak
    python3 tools/ble-scan.py          # strips of the BLEDOM / Lotus Lantern family
    python3 tools/ble-scan.py --all    # every device in range

Close the Lotus Lantern app on the phone first: the strip only talks to one device at a time,
and a connected strip may stop advertising.
"""
import asyncio
import sys

from bleak import BleakScanner

NAMES = ("BLEDOM", "BLEDOB", "ELK-", "ELK_", "LEDBLE", "MELK", "TRIONES", "LED")
SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"


async def main(show_all: bool) -> None:
    print("Scanning for 8 seconds...")
    found = await BleakScanner.discover(timeout=8.0, return_adv=True)
    rows = []
    for address, (device, adv) in found.items():
        name = device.name or adv.local_name or ""
        services = [s.lower() for s in (adv.service_uuids or [])]
        looks_like_strip = any(n in name.upper() for n in NAMES) or SERVICE in services
        if show_all or looks_like_strip:
            rows.append((adv.rssi if adv.rssi is not None else -999, name or "(no name)", address, services))
    rows.sort(reverse=True)
    if not rows:
        print("Nothing found. Is Bluetooth on, does the terminal have Bluetooth permission,")
        print("and is the Lotus Lantern app closed on the phone?")
        return
    for rssi, name, address, services in rows:
        print(f"{rssi:>5} dBm  {name:<24} {address}  {'fff0' if SERVICE in services else ''}")


asyncio.run(main("--all" in sys.argv))
