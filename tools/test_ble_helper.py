"""Run:  python3 tools/test_ble_helper.py   (no Bluetooth or bleak needed: the strip is faked)"""
import asyncio
import json
import os
import sys
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import ble_helper as h  # noqa: E402

TOKEN = "t" * 20


class FakeStrip(h.Strip):
    def __init__(self):
        super().__init__()
        self.sent: list[bytes] = []
        self.fail = False

    async def send(self, patch):
        if self.fail:
            raise RuntimeError("strip not found")
        self.sent += h.packets_for(patch)
        self.last.update(patch)
        self.connected = True


class Protocol(unittest.TestCase):
    def test_packets(self):
        self.assertEqual(h.pkt_power(True).hex(" "), "7e 04 04 01 00 01 ff 00 ef")
        self.assertEqual(h.pkt_power(False).hex(" "), "7e 04 04 00 00 00 ff 00 ef")
        self.assertEqual(h.pkt_color(255, 136, 0).hex(" "), "7e 07 05 03 ff 88 00 10 ef")
        self.assertEqual(h.pkt_brightness(30).hex(" "), "7e 04 01 1e ff ff ff 00 ef")

    def test_patch_validation(self):
        self.assertEqual(h.parse_patch({"color": "#FF8800", "brightness": 5}), {"color": "ff8800", "brightness": 5})
        for bad in [None, {}, [], {"nope": 1}, {"on": 1}, {"color": "red"}, {"color": 5}, {"brightness": 101},
                    {"brightness": -1}, {"brightness": True}, {"brightness": 1.5}]:
            with self.assertRaises(h.BadRequest, msg=repr(bad)):
                h.parse_patch(bad)

    def test_order_colour_before_power(self):
        pk = h.packets_for({"on": True, "color": "ff0000", "brightness": 50})
        self.assertEqual([p[2] for p in pk], [0x05, 0x01, 0x04])  # colour, brightness, power


class Http(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.strip = FakeStrip()
        self.server = await h.serve(self.strip, TOKEN, port=0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def call(self, method, path, body=None, token=TOKEN):
        def go():
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                         data=json.dumps(body).encode() if body is not None else None)
            if token:
                req.add_header("Authorization", f"Bearer {token}")
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        return await asyncio.get_running_loop().run_in_executor(None, go)

    async def test_needs_token(self):
        self.assertEqual((await self.call("GET", "/state", token=None))[0], 401)
        self.assertEqual((await self.call("GET", "/state", token="wrong"))[0], 401)

    async def test_set_and_read(self):
        status, body = await self.call("POST", "/light", {"on": True, "color": "00ff00", "brightness": 20})
        self.assertEqual(status, 200)
        self.assertEqual(body["last"], {"on": True, "color": "00ff00", "brightness": 20})
        self.assertEqual(len(self.strip.sent), 3)
        self.assertEqual((await self.call("GET", "/state"))[1]["last"]["color"], "00ff00")

    async def test_rejects_bad_input(self):
        for bad in [{}, {"brightness": 500}, {"color": "zz"}, {"x": 1}]:
            self.assertEqual((await self.call("POST", "/light", bad))[0], 400, bad)
        self.assertEqual(self.strip.sent, [])

    async def test_strip_failure_is_502(self):
        self.strip.fail = True
        status, body = await self.call("POST", "/light", {"on": True})
        self.assertEqual(status, 502)
        self.assertIn("not found", body["error"])

    async def test_unknown_route(self):
        self.assertEqual((await self.call("GET", "/nope"))[0], 404)


if __name__ == "__main__":
    unittest.main()
