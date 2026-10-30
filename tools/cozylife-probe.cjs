// Read-only probe for CozyLife devices on the local network.
// Usage: node tools/cozylife-probe.cjs [lamp-ip]
// Finds lamps by UDP broadcast (port 6095), then asks each one for its state over TCP (port 5555).
// It never sends a "set" command, so nothing changes on the lamp.
const dgram = require("node:dgram");
const net = require("node:net");

const sn = () => String(Date.now());
const frame = (cmd, msg) => JSON.stringify({ cmd, pv: 0, sn: sn(), msg }) + "\r\n";

function discover(ms = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = dgram.createSocket("udp4");
    s.on("message", (buf, rinfo) => {
      try {
        const r = JSON.parse(buf.toString());
        if (r.cmd === 0 && r.msg?.did) found.set(rinfo.address, r.msg);
      } catch {}
    });
    s.bind(() => {
      s.setBroadcast(true);
      const probe = Buffer.from(JSON.stringify({ cmd: 0, pv: 0, sn: sn(), msg: {} }));
      for (let i = 0; i < 3; i++) setTimeout(() => s.send(probe, 6095, "255.255.255.255"), i * 100);
    });
    setTimeout(() => (s.close(), resolve(found)), ms);
  });
}

function query(ip, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(5555, ip);
    let buf = "";
    const t = setTimeout(() => (c.destroy(), reject(new Error("timeout"))), timeout);
    c.on("connect", () => c.write(frame(2, { attr: [0] })));
    c.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\r\n")) {
        try {
          const r = JSON.parse(line);
          if (r.cmd === 2) return clearTimeout(t), c.destroy(), resolve(r);
        } catch {}
      }
    });
    c.on("error", (e) => (clearTimeout(t), reject(e)));
  });
}

(async () => {
  const arg = process.argv[2];
  const found = arg ? new Map([[arg, null]]) : await discover();
  if (!found.size) return console.log("No CozyLife devices answered. Is this Mac on the same Wi-Fi as the lamp?");
  for (const [ip, info] of found) {
    console.log(`\n== ${ip}`);
    if (info) console.log("info :", JSON.stringify(info));
    try {
      const r = await query(ip);
      console.log("state:", JSON.stringify(r.msg));
    } catch (e) {
      console.log("query failed:", e.message);
    }
  }
})();
