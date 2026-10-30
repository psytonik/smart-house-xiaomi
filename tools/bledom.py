"""Control an ELK-BLEDOM (Lotus Lantern) LED strip over Bluetooth LE.

Usage (from Terminal.app, inside the project's venv):
    ./venv/bin/python tools/bledom.py on
    ./venv/bin/python tools/bledom.py off
    ./venv/bin/python tools/bledom.py color ff8800        # hex RGB
    ./venv/bin/python tools/bledom.py brightness 40       # 0..100

The strip is write-only: it can't report its state, so these commands only send.
It accepts one connection at a time: close Lotus Lantern on the phone first.
Add --address <id> to pick one strip when several are in range (ids come from ble-scan.py).
"""
import argparse
import asyncio
import sys

from bleak import BleakClient, BleakScanner

SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"
WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
NAMES = ("BLEDOM", "BLEDOB", "ELK-", "ELK_", "LEDBLE", "MELK")


def frame(*data: int) -> bytes:
    return bytes((0x7E, *data, 0xEF))


def power(on: bool) -> bytes:
    v = 1 if on else 0
    return frame(0x04, 0x04, v, 0x00, v, 0xFF, 0x00)


def color(r: int, g: int, b: int) -> bytes:
    return frame(0x07, 0x05, 0x03, r, g, b, 0x10)


def brightness(level: int) -> bytes:
    return frame(0x04, 0x01, max(0, min(100, level)), 0xFF, 0xFF, 0xFF, 0x00)


async def find(address: str | None):
    if address:
        return address
    found = await BleakScanner.discover(timeout=6.0, return_adv=True)
    strips = []
    for addr, (device, adv) in found.items():
        name = (device.name or adv.local_name or "").upper()
        if any(n in name for n in NAMES) or SERVICE in [s.lower() for s in adv.service_uuids or []]:
            strips.append((adv.rssi if adv.rssi is not None else -999, addr, name))
    if not strips:
        sys.exit("No strip found. Is it powered, and is Lotus Lantern closed on the phone?")
    strips.sort(reverse=True)
    if len(strips) > 1:
        print("Several strips in range; using the strongest. Use --address to choose:")
        for rssi, addr, name in strips:
            print(f"  {rssi} dBm  {name}  {addr}")
    return strips[0][1]


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["on", "off", "color", "brightness"])
    p.add_argument("value", nargs="?")
    p.add_argument("--address")
    a = p.parse_args()

    if a.command == "on":
        packets = [power(True)]
    elif a.command == "off":
        packets = [power(False)]
    elif a.command == "color":
        if not a.value or len(a.value.lstrip("#")) != 6:
            sys.exit("color needs a hex value like ff8800")
        h = a.value.lstrip("#")
        packets = [color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))]
    else:
        if a.value is None or not a.value.isdigit():
            sys.exit("brightness needs a number 0..100")
        packets = [brightness(int(a.value))]

    target = await find(a.address)
    async with BleakClient(target, timeout=15.0) as client:
        for pkt in packets:
            await client.write_gatt_char(WRITE, pkt, response=False)
            print("sent", pkt.hex(" "))
            await asyncio.sleep(0.15)


asyncio.run(main())
