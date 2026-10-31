import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { AppContext } from "../context.js";
import { plain, runAssistant, type ApiCall, type Brain } from "../assistant.js";
import { AssistantMemory } from "../assistantMemory.js";
import { HttpError } from "../go2rtc.js";
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
        return await runAssistant({ brain: client, model: cfg.assistant.model, call, text: req.body.text, history: req.body.history, memory });
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

  // What it was asked and who understood it: the place to see which phrases still need a rule.
  app.get("/api/assistant/journal", async () => ({ learned: memory.list(), recent: memory.recent(100) }));
}
