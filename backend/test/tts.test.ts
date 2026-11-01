import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { PiperTts } from "../src/tts.js";
import { testConfig } from "./helpers.js";

const auth = { authorization: `Bearer ${"t".repeat(24)}` };

/** A pretend Piper server: remembers what it was asked and answers with a tiny "WAV". */
function fakePiper() {
  const asked: Array<{ text: string; length_scale: number; voice?: string }> = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/info") return void res.end("{}");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(JSON.parse(body));
      res.setHeader("content-type", "audio/wav").end(Buffer.from("RIFFfake"));
    });
  });
  return new Promise<{ url: string; asked: typeof asked; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked, close: () => server.close() })),
  );
}

describe("Piper voice", () => {
  let piper: Awaited<ReturnType<typeof fakePiper>>;
  before(async () => (piper = await fakePiper()));
  after(() => piper.close());

  it("asks the server for the text, slower or faster by speed", async () => {
    const tts = new PiperTts({ port: 0, url: piper.url });
    assert.equal((await tts.synthesize("Привет", 1)).toString(), "RIFFfake");
    await tts.synthesize("Быстрее", 2);
    assert.deepEqual(piper.asked.map((a) => [a.text, a.length_scale]), [["Привет", 1], ["Быстрее", 0.5]]);
  });

  it("refuses empty text and shortens very long text", async () => {
    const tts = new PiperTts({ port: 0, url: piper.url });
    await assert.rejects(tts.synthesize("   "), /nothing to say/);
    await tts.synthesize("я".repeat(900));
    assert.equal(piper.asked.at(-1)!.text.length, 400);
  });

  it("lists the voices on disk and refuses one that is not there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voices-"));
    for (const v of ["ru_RU-irina-medium", "ru_RU-denis-medium"]) {
      writeFileSync(join(dir, `${v}.onnx`), "x");
      writeFileSync(join(dir, `${v}.onnx.json`), "{}");
    }
    writeFileSync(join(dir, "broken.onnx"), "x"); // no .json: not a usable voice
    const tts = new PiperTts({ port: 0, url: piper.url, model: join(dir, "ru_RU-irina-medium.onnx") });
    assert.deepEqual(tts.voices(), { default: "ru_RU-irina-medium", voices: ["ru_RU-irina-medium", "ru_RU-denis-medium"] });
    await assert.rejects(tts.synthesize("x", 1, "../../etc/passwd"), /no such voice/);
    await tts.synthesize("Привет", 1, "ru_RU-denis-medium");
    assert.equal(piper.asked.at(-1)!.voice, "ru_RU-denis-medium");
    await tts.synthesize("Привет", 1, "ru_RU-irina-medium");
    assert.equal(piper.asked.at(-1)!.voice, undefined); // the main voice needs no name
    rmSync(dir, { recursive: true, force: true });
  });

  it("is served at /api/tts only with the token, and only when set up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tts-"));
    const on = await buildApp(testConfig({ dataDir: dir, piper: { port: 0, url: piper.url } }));
    assert.equal((await on.inject({ url: "/api/tts", headers: auth })).json().piper, true);
    const ok = await on.inject({ method: "POST", url: "/api/tts", headers: auth, payload: { text: "Свет выключен" } });
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers["content-type"]), /audio\/wav/);
    assert.equal((await on.inject({ method: "POST", url: "/api/tts", payload: { text: "x" } })).statusCode, 401);
    await on.close();

    const off = await buildApp(testConfig({ dataDir: dir }));
    assert.equal((await off.inject({ url: "/api/tts", headers: auth })).json().piper, false);
    assert.equal((await off.inject({ method: "POST", url: "/api/tts", headers: auth, payload: { text: "x" } })).statusCode, 404);
    await off.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
