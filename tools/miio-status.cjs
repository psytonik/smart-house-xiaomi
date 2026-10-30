#!/usr/bin/env node
// Read-only check of the robot vacuum over the local network (miio protocol, UDP 54321).
// Reads VACUUM_IP and VACUUM_TOKEN from backend/.env (or the environment). Never prints the token.
// Sends only: miIO.info and get_properties for battery and status. It cannot start or move anything.
//   node tools/miio-status.cjs
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const path = require("node:path");

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", "backend", ".env"), "utf8");
    const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
}

const ip = envValue("VACUUM_IP");
const tokenHex = envValue("VACUUM_TOKEN");
if (!ip || !/^[0-9a-fA-F]{32}$/.test(tokenHex)) {
  console.error("Set VACUUM_IP and VACUUM_TOKEN (32 hex characters) in backend/.env");
  process.exit(1);
}
const token = Buffer.from(tokenHex, "hex");
const md5 = (...b) => crypto.createHash("md5").update(Buffer.concat(b)).digest();
const key = md5(token);
const iv = md5(key, token);

const encrypt = (buf) => {
  const c = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([c.update(buf), c.final()]);
};
const decrypt = (buf) => {
  const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
};

function packet(deviceId, stamp, payload) {
  const body = payload ? encrypt(payload) : Buffer.alloc(0);
  const head = Buffer.alloc(16);
  head.writeUInt16BE(0x2131, 0);
  head.writeUInt16BE(32 + body.length, 2);
  head.writeUInt32BE(deviceId, 8);
  head.writeUInt32BE(stamp, 12);
  return Buffer.concat([head, md5(head, token, body), body]);
}

const sock = dgram.createSocket("udp4");
let deviceId = 0;
let stampAt = { stamp: 0, at: 0 };
let nextId = 1;
const waiting = new Map();

sock.on("message", (msg) => {
  if (msg.length < 32) return;
  deviceId = msg.readUInt32BE(8);
  stampAt = { stamp: msg.readUInt32BE(12), at: Date.now() };
  if (msg.length === 32) return waiting.get("hello")?.(msg);
  try {
    const reply = JSON.parse(decrypt(msg.subarray(32)).toString().replace(/\0+$/, ""));
    waiting.get(reply.id)?.(reply);
  } catch (e) {
    console.error("could not read a reply (wrong token?):", e.message);
  }
});

const once = (id, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => (waiting.delete(id), reject(new Error("no answer"))), ms);
    waiting.set(id, (m) => (clearTimeout(t), waiting.delete(id), resolve(m)));
  });

async function call(method, params) {
  const id = nextId++;
  const stamp = stampAt.stamp + Math.round((Date.now() - stampAt.at) / 1000);
  const wait = once(id);
  sock.send(packet(deviceId, stamp, Buffer.from(JSON.stringify({ id, method, params }))), 54321, ip);
  return wait;
}

(async () => {
  const hello = once("hello");
  sock.send(Buffer.from("21310020" + "ff".repeat(28), "hex"), 54321, ip);
  await hello.catch(() => {
    console.error(`${ip} did not answer. Is the vacuum awake and on the same network?`);
    process.exit(1);
  });
  const info = await call("miIO.info", []).catch(() => null);
  if (info?.result) {
    const r = info.result;
    console.log(`model: ${r.model}   firmware: ${r.fw_ver}   mac: ${r.mac}`);
  } else {
    console.log("miIO.info: no usable answer (token may be wrong)");
  }
  const props = await call("get_properties", [
    { did: "x", siid: 3, piid: 1 }, // battery
    { did: "x", siid: 2, piid: 1 }, // status
  ]).catch(() => null);
  console.log("get_properties:", JSON.stringify(props?.result ?? props?.error ?? "no answer"));
  sock.close();
})();
