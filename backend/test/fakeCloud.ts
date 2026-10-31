import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";
import { encSignature, rc4, signedNonce, type CloudSession } from "../src/xiaomiCloud.js";

/** The text of a cloud map file for a small test map. Cells: 0 outside, 1 floor, 129 wall. */
export function cloudMapFile(opts: { width: number; height: number; cells: number[]; chargerMm?: [number, number]; robotMm?: [number, number]; name?: string; segInf?: object }): string {
  const { width, height, cells } = opts;
  const header = Buffer.alloc(27);
  header.writeUInt16LE(95, 0); // map id
  header.writeUInt8(73, 4); // "I" frame
  const [rx, ry] = opts.robotMm ?? [0, 0];
  const [cx, cy] = opts.chargerMm ?? [0, 0];
  header.writeInt16LE(rx, 5);
  header.writeInt16LE(ry, 7);
  header.writeInt16LE(cx, 11);
  header.writeInt16LE(cy, 13);
  header.writeUInt16LE(50, 17); // 5 cm cells
  header.writeUInt16LE(width, 19);
  header.writeUInt16LE(height, 21);
  header.writeInt16LE(-100, 23);
  header.writeInt16LE(-200, 25);
  const tail = Buffer.from(JSON.stringify({ vw: { line: [], rect: [], mop: [] }, seg_inf: opts.segInf ?? { "1": { nei_id: [] } } }));
  const packed = deflateSync(Buffer.concat([header, Buffer.from(cells), tail])).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return JSON.stringify({ mapstr: [{ id: 0, name: opts.name ?? "Home", angle: "0", map: packed }], curr_id: 95 });
}

/**
 * A pretend Xiaomi cloud on a loopback port. It checks the signature and the cookie the way the real one does,
 * answers file-url requests for the object names in `files`, and serves those files.
 */
export function startFakeCloud(session: CloudSession, files: Record<string, string>, rows: Record<string, Array<{ time: number; value: string }>> = {}, devices: Array<Record<string, unknown>> = []): Promise<{ base: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname.startsWith("/files/")) {
        const file = files[decodeURIComponent(url.pathname.slice(7))];
        res.statusCode = file === undefined ? 404 : 200;
        return void res.end(file ?? "");
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/app/")) return void res.writeHead(404).end();

      const apiPath = url.pathname.slice(5);
      calls.push(apiPath);
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      const nonce = params.get("_nonce") ?? "";
      const signature = params.get("signature");
      params.delete("signature");
      params.delete("ssecurity");
      params.delete("_nonce");
      const signed = signedNonce(session.ssecurity, nonce);
      const cookie = req.headers.cookie ?? "";
      if (signature !== encSignature("POST", apiPath, signed, Object.fromEntries(params)) || !cookie.includes(`serviceToken=${session.serviceToken}`)) {
        return void res.writeHead(403).end();
      }
      const key = Buffer.from(signed, "base64");
      const request = JSON.parse(rc4(key, Buffer.from(params.get("data") ?? "", "base64")).toString("utf8"));
      if (apiPath === "user/get_user_device_data") {
        const reply = request.uid && request.did ? { code: 0, result: rows[request.key] ?? [] } : { code: -1 };
        return void res.end(rc4(key, Buffer.from(JSON.stringify(reply))).toString("base64"));
      }
      if (apiPath === "home/device_list") {
        const reply = { code: 0, result: { list: devices } };
        return void res.end(rc4(key, Buffer.from(JSON.stringify(reply))).toString("base64"));
      }
      const answer = apiPath.includes("get_interim_file_url") && files[request.obj_name] !== undefined
        ? { code: 0, result: { url: `${origin}/files/${encodeURIComponent(request.obj_name)}` } }
        : { code: -1, message: "no such file" };
      res.end(rc4(key, Buffer.from(JSON.stringify(answer))).toString("base64"));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    ),
  );
}

/** One live "P" frame as the robot reports it: no cells, a position in the header and a bit of trail in the JSON tail. */
export function cloudFrame(opts: { robotMm?: [number, number]; trail?: string; frameId?: number; piece?: { width: number; height: number; leftMm: number; topMm: number; cells: number[] } }): string {
  const header = Buffer.alloc(27);
  header.writeUInt16LE(5, 0);
  header.writeUInt16LE(opts.frameId ?? 1, 2);
  header.writeUInt8(80, 4); // "P" frame
  const [rx, ry] = opts.robotMm ?? [0, 0];
  header.writeInt16LE(rx, 5);
  header.writeInt16LE(ry, 7);
  header.writeUInt16LE(50, 17);
  if (opts.piece) {
    header.writeUInt16LE(opts.piece.width, 19);
    header.writeUInt16LE(opts.piece.height, 21);
    header.writeInt16LE(opts.piece.leftMm, 23);
    header.writeInt16LE(opts.piece.topMm, 25);
  }
  const tail = Buffer.from(JSON.stringify({ timestamp_ms: 1, tr: opts.trail ?? "" }));
  return deflateSync(Buffer.concat([header, Buffer.from(opts.piece?.cells ?? []), tail])).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

