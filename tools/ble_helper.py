"""Small local service that controls an ELK-BLEDOM (Lotus Lantern) strip over Bluetooth LE.

Why it exists: macOS only lets an app with a Bluetooth usage description talk to Bluetooth, and a
background backend can't get that. Start this from Terminal.app and the backend calls it over HTTP.

Run (Terminal.app, project folder):
    export BLE_HELPER_TOKEN=$(openssl rand -hex 16)      # the backend needs the same value
    ./venv/bin/python tools/ble_helper.py

It listens on 127.0.0.1:3200 only. Every request needs  Authorization: Bearer <BLE_HELPER_TOKEN>.
    GET  /state                          what was last sent (the strip can't report its state)
    POST /light  {"on":true,"color":"ff8800","brightness":40}     any of the three

The strip accepts one connection at a time, so the helper connects when it's used and lets go
after IDLE_SECONDS of silence; the Lotus Lantern phone app can connect again after that.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import sys
import time

WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"
NAMES = ("BLEDOM", "BLEDOB", "ELK-", "ELK_", "LEDBLE", "MELK")
HEX = re.compile(r"^#?[0-9a-fA-F]{6}$")
MAX_BODY = 4096


# ---------------------------------------------------------------- protocol (see tools/bledom.py)
def frame(*data: int) -> bytes:
    return bytes((0x7E, *data, 0xEF))


def pkt_power(on: bool) -> bytes:
    v = 1 if on else 0
    return frame(0x04, 0x04, v, 0x00, v, 0xFF, 0x00)


def pkt_color(r: int, g: int, b: int) -> bytes:
    return frame(0x07, 0x05, 0x03, r, g, b, 0x10)


def pkt_brightness(level: int) -> bytes:
    return frame(0x04, 0x01, max(0, min(100, level)), 0xFF, 0xFF, 0xFF, 0x00)


class BadRequest(Exception):
    pass


def parse_patch(body: object) -> dict:
    """Validates a request body; returns only the known, checked fields."""
    if not isinstance(body, dict) or not body:
        raise BadRequest("send a JSON object with on, color or brightness")
    unknown = set(body) - {"on", "color", "brightness"}
    if unknown:
        raise BadRequest(f"unknown field: {sorted(unknown)[0]}")
    out: dict = {}
    if "on" in body:
        if not isinstance(body["on"], bool):
            raise BadRequest("on must be true or false")
        out["on"] = body["on"]
    if "color" in body:
        c = body["color"]
        if not isinstance(c, str) or not HEX.match(c):
            raise BadRequest("color must be a hex value like ff8800")
        out["color"] = c.lstrip("#").lower()
    if "brightness" in body:
        b = body["brightness"]
        if isinstance(b, bool) or not isinstance(b, int) or not 0 <= b <= 100:
            raise BadRequest("brightness must be a whole number 0..100")
        out["brightness"] = b
    return out


def packets_for(patch: dict) -> list[bytes]:
    packets: list[bytes] = []
    if "color" in patch:
        h = patch["color"]
        packets.append(pkt_color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    if "brightness" in patch:
        packets.append(pkt_brightness(patch["brightness"]))
    if "on" in patch:
        packets.append(pkt_power(patch["on"]))
    return packets


# ---------------------------------------------------------------- the strip
class Strip:
    """One strip, connected on demand. Commands never overlap."""

    def __init__(self, address: str | None = None, idle_seconds: float = 20.0):
        self.address = address
        self.idle_seconds = idle_seconds
        self.last: dict = {}
        self.connected = False
        self._client = None
        self._lock = asyncio.Lock()
        self._last_used = 0.0

    async def _find(self) -> str:
        from bleak import BleakScanner

        found = await BleakScanner.discover(timeout=6.0, return_adv=True)
        strips = []
        for addr, (device, adv) in found.items():
            name = (device.name or adv.local_name or "").upper()
            if any(n in name for n in NAMES) or SERVICE in [s.lower() for s in adv.service_uuids or []]:
                strips.append((adv.rssi if adv.rssi is not None else -999, addr))
        if not strips:
            raise RuntimeError("strip not found: is it powered, and is Lotus Lantern closed on the phone?")
        return max(strips)[1]

    async def _ensure(self) -> None:
        if self._client is not None and self._client.is_connected:
            return
        from bleak import BleakClient

        for attempt in range(2):
            if self.address is None:
                self.address = await self._find()
            try:
                client = BleakClient(self.address, timeout=15.0)
                await client.connect()
                self._client, self.connected = client, True
                return
            except Exception as exc:  # noqa: BLE001
                self.address = None  # the cached id may be stale: scan again
                if attempt == 1:
                    raise RuntimeError(f"couldn't connect to the strip: {exc}") from exc

    async def send(self, patch: dict) -> None:
        async with self._lock:
            await self._ensure()
            for pkt in packets_for(patch):
                await self._client.write_gatt_char(WRITE, pkt, response=False)
                await asyncio.sleep(0.1)
            self.last.update(patch)
            self._last_used = time.monotonic()

    async def release_when_idle(self) -> None:
        while True:
            await asyncio.sleep(2)
            if self.connected and time.monotonic() - self._last_used > self.idle_seconds:
                async with self._lock:
                    await self.close()

    async def close(self) -> None:
        client, self._client, self.connected = self._client, None, False
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------- tiny HTTP server (no dependencies)
async def respond(writer: asyncio.StreamWriter, status: int, payload: object) -> None:
    body = json.dumps(payload).encode()
    reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 502: "Bad Gateway"}[status]
    writer.write(
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n"
        f"Cache-Control: no-store\r\nConnection: close\r\n\r\n".encode() + body
    )
    await writer.drain()


def make_handler(strip: Strip, token: str):
    expected = token.encode()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = head.decode("latin-1").split("\r\n")
            method, path, _ = lines[0].split(" ", 2)
            headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
            supplied = headers.get("authorization", "").removeprefix("Bearer ").strip().encode()
            if not hmac.compare_digest(supplied, expected):
                return await respond(writer, 401, {"error": "unauthorized"})
            length = int(headers.get("content-length", "0") or 0)
            if length > MAX_BODY:
                return await respond(writer, 400, {"error": "body too large"})
            body = await asyncio.wait_for(reader.readexactly(length), 5) if length else b""

            if method == "GET" and path == "/state":
                return await respond(writer, 200, {"connected": strip.connected, "last": strip.last})
            if method == "POST" and path == "/light":
                try:
                    patch = parse_patch(json.loads(body or b"null"))
                except (BadRequest, ValueError) as e:
                    return await respond(writer, 400, {"error": str(e)})
                try:
                    await strip.send(patch)
                except Exception as e:  # noqa: BLE001
                    return await respond(writer, 502, {"error": str(e)})
                return await respond(writer, 200, {"connected": strip.connected, "last": strip.last})
            await respond(writer, 404, {"error": "not found"})
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError):
            pass  # a broken or slow client: just drop it
        finally:
            writer.close()

    return handle


async def serve(strip: Strip, token: str, host: str = "127.0.0.1", port: int = 3200):
    server = await asyncio.start_server(make_handler(strip, token), host, port)
    asyncio.create_task(strip.release_when_idle())
    return server


async def main() -> None:
    token = os.environ.get("BLE_HELPER_TOKEN", "")
    if len(token) < 16:
        sys.exit("Set BLE_HELPER_TOKEN first (16+ characters), for example:\n  export BLE_HELPER_TOKEN=$(openssl rand -hex 16)")
    port = int(os.environ.get("BLE_HELPER_PORT", "3200"))
    server = await serve(Strip(os.environ.get("BLE_ADDRESS") or None), token, port=port)
    print(f"BLE helper on http://127.0.0.1:{port}  (Ctrl+C to stop)")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
