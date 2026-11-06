import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { AppContext } from "../context.js";
import { plain, runAssistant, type ApiCall, type Brain } from "../assistant.js";
import { AssistantMemory } from "../assistantMemory.js";
import { HttpError } from "../go2rtc.js";
import { analyze, autoTeach } from "../journalReport.js";
import { OllamaError, ollamaBrain } from "../ollama.js";

/** `brain` is only for tests; the real client reads ANTHROPIC_API_KEY (or a logged-in profile) itself. */
export function assistantRoutes(app: FastifyInstance, ctx: AppContext, brain?: Brain): void {
  const { cfg } = ctx;
  let client: Brain | undefined = brain;
  const memory = new AssistantMemory(join(cfg.dataDir, "assistant"));

  app.get("/api/assistant", async () => ({ configured: cfg.assistant.enabled || brain !== undefined }));

  app.post<{ Body: { text: string; history?: Array<{ role: "user" | "assistant"; content: string }> } }>(
    "/api/assistant",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            history: {
              type: "array",
              maxItems: 8,
              items: { type: "object", additionalProperties: false, required: ["role", "content"], properties: { role: { enum: ["user", "assistant"] }, content: { type: "string", maxLength: 1000 } } },
            },
          },
        },
      },
    },
    async (req) => {
      if (!cfg.assistant.enabled && !brain) throw new HttpError(404, "the assistant is off: set ANTHROPIC_API_KEY in backend/.env, or ASSISTANT_PROVIDER=ollama");
      client ??= cfg.assistant.provider === "ollama" ? ollamaBrain(cfg.assistant.ollamaUrl) : new Anthropic();

      // The assistant acts through the app's own API with the caller's token, so it can do no more than the caller can.
      const call: ApiCall = async (method, url, body) => {
        const res = await app.inject({ method, url, headers: { authorization: req.headers.authorization ?? "" }, ...(body ? { payload: body } : {}) });
        let parsed: unknown = res.body;
        try {
          parsed = res.json();
        } catch {
          /* not JSON (an image, say): keep the text */
        }
        return { status: res.statusCode, body: parsed };
      };

      try {
        const out = await runAssistant({ brain: client, model: cfg.assistant.model, call, text: req.body.text, history: req.body.history, memory });
        if (autoTeach(memory)) out.learned = true;
        return out;
      } catch (e) {
        if (e instanceof OllamaError) throw new HttpError(502, e.message);
        if (e instanceof Anthropic.APIError) {
          req.log.error(e);
          throw new HttpError(502, e.status === 401 ? "the Anthropic key is wrong or missing" : "the assistant's brain is not answering, try again");
        }
        throw e;
      }
    },
  );

  const phrase = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 500 } } } as const;

  // "Remember this": saves what the model just did for that phrase (kept on the server, never sent by the page).
  app.post<{ Body: { text: string } }>("/api/assistant/learn", { schema: { body: phrase } }, async (req) => {
    if (!memory.learn(plain(req.body.text))) throw new HttpError(409, "there is nothing to remember for that phrase (say it again first)");
    return { ok: true };
  });
  app.post<{ Body: { text: string } }>("/api/assistant/forget", { schema: { body: phrase } }, async (req) => ({ ok: memory.forget(plain(req.body.text)) }));

  // Phrases that failed and were fixed by the person's next words (see journalReport.ts); the person approves them here, the steps come from the server.
  const suggestions = () => analyze(memory.recent(100_000).reverse(), new Set(memory.list().map((l) => l.phrase))).proposals;
  app.get("/api/assistant/suggestions", async () => ({ suggestions: suggestions().slice(0, 5).map(({ phrase, becameText, times }) => ({ phrase, becameText, times })) }));
  app.post<{ Body: { text: string } }>("/api/assistant/teach", { schema: { body: phrase } }, async (req) => {
    const found = suggestions().find((s) => s.phrase === plain(req.body.text));
    if (!found || !memory.teach(found.phrase, found.steps)) throw new HttpError(409, "there is no such suggestion");
    return { ok: true };
  });

  // What it was asked and who understood it: the place to see which phrases still need a rule.
  app.get("/api/assistant/journal", async () => ({ learned: memory.list(), recent: memory.recent(100) }));

  // The assistant's voice: Piper, a neural voice on this computer. The page falls back to the browser's voices without it.
  app.get("/api/tts", async () => (ctx.tts ? { piper: true, ...ctx.tts.voices() } : { piper: false, default: "", voices: [] }));
  app.post<{ Body: { text: string; speed?: number; voice?: string } }>(
    "/api/tts",
    { schema: { body: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 400 }, speed: { type: "number", minimum: 0.5, maximum: 2 }, voice: { type: "string", pattern: "^[A-Za-z0-9_-]{1,60}$" } } } } },
    async (req, reply) => {
      if (!ctx.tts) throw new HttpError(404, "the neural voice is not set up (see docs/assistant.md, Piper)");
      try {
        return reply.type("audio/wav").send(await ctx.tts.synthesize(req.body.text, req.body.speed, req.body.voice));
      } catch (e) {
        req.log.error(e);
        throw new HttpError(502, "the voice is not answering, the browser's voice will be used");
      }
    },
  );
}
