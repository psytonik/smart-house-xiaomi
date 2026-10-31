import type Anthropic from "@anthropic-ai/sdk";
import type { Brain } from "./assistant.js";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

interface OllamaReply {
  message: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }> };
}

/** The assistant's conversation (Anthropic-shaped) in the form Ollama's /api/chat wants. */
export function toOllamaMessages(system: string | undefined, messages: Anthropic.MessageParam[]): OllamaMessage[] {
  const out: OllamaMessage[] = system ? [{ role: "system", content: system }] : [];
  // Ollama's tool result names the tool, not the call: remember which call was which tool.
  const names = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
      const calls = m.content.flatMap((b) => (b.type === "tool_use" ? [b] : []));
      for (const c of calls) names.set(c.id, c.name);
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input as Record<string, unknown> } })) } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", content: typeof b.content === "string" ? b.content : JSON.stringify(b.content), tool_name: names.get(b.tool_use_id) });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

/** An Ollama answer in the shape the assistant loop reads. */
export function fromOllamaReply(reply: OllamaReply): Anthropic.Message {
  const content: unknown[] = [];
  const text = reply.message.content?.trim();
  if (text) content.push({ type: "text", text });
  const calls = reply.message.tool_calls ?? [];
  calls.forEach((c, i) => {
    const args = typeof c.function.arguments === "string" ? safeJson(c.function.arguments) : c.function.arguments;
    content.push({ type: "tool_use", id: `call_${Date.now()}_${i}`, name: c.function.name, input: args });
  });
  return { stop_reason: calls.length ? "tool_use" : "end_turn", content } as unknown as Anthropic.Message;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A free model running on this computer through Ollama. Talks the same language as the Anthropic client the loop expects. */
export function ollamaBrain(baseUrl: string, fetchImpl: typeof fetch = fetch): Brain {
  return {
    messages: {
      async create(params) {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(90_000),
            body: JSON.stringify({
              model: params.model,
              stream: false,
              think: false, // reasoning models would spend seconds thinking before every "turn on the light"
              options: { temperature: 0.2 },
              messages: toOllamaMessages(typeof params.system === "string" ? params.system : undefined, params.messages),
              tools: (params.tools ?? []).flatMap((t) => ("input_schema" in t ? [{ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }] : [])),
            }),
          });
        } catch {
          throw new OllamaError("Ollama is not answering: start it (ollama serve) and check that the model is downloaded");
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new OllamaError(res.status === 404 ? `Ollama has no model "${params.model}": run  ollama pull ${params.model}` : `Ollama failed (${res.status}) ${detail.slice(0, 120)}`);
        }
        return fromOllamaReply((await res.json()) as OllamaReply);
      },
    },
  };
}

export class OllamaError extends Error {}
