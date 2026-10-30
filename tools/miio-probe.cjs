#!/usr/bin/env node
// Read-only miio discovery: sends the public "hello" packet to UDP 54321 and prints who answers.
// It controls nothing and never prints a token.
//   node tools/miio-probe.cjs            broadcast on the local network
//   node tools/miio-probe.cjs 10.0.0.42  one device
const dgram = require("node:dgram");

const target = process.argv[2] || "255.255.255.255";
const hello = Buffer.from("21310020" + "ff".repeat(28), "hex");
const sock = dgram.createSocket("udp4");
const seen = new Set();

sock.on("message", (msg, rinfo) => {
  if (msg.length < 32 || msg.readUInt16BE(0) !== 0x2131 || seen.has(rinfo.address)) return;
  seen.add(rinfo.address);
  const deviceId = msg.readUInt32BE(8);
  const stamp = msg.readUInt32BE(12);
  const tokenField = msg.subarray(16, 32);
  const leaked = tokenField.some((b) => b !== 0 && b !== 0xff); // a few devices send the token here
  console.log(`${rinfo.address}\tdevice id ${deviceId}\tuptime stamp ${stamp}s\ttoken in hello: ${leaked ? "YES (visible to anyone on the network)" : "no"}`);
});
sock.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});
sock.bind(0, () => {
  sock.setBroadcast(true);
  for (let i = 0; i < 3; i++) setTimeout(() => sock.send(hello, 54321, target), i * 700);
  setTimeout(() => {
    sock.close();
    if (seen.size === 0) console.log("Nobody answered. The device may be asleep, on another network, or have local control off.");
  }, 3500);
});
