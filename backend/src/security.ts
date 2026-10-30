import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AppContext } from "./context.js";
import { isSignable } from "./signing.js";

const sha = (s: string) => createHash("sha256").update(s).digest();

/** The token comes only from the Authorization header: URLs end up in logs and browser history. */
function tokenFrom(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** Response headers (CSP etc.) and the token check on everything under /api. */
export async function registerSecurity(app: FastifyInstance, { cfg, signer, limiter }: AppContext): Promise<void> {
  // Plain-HTTP LAN app: no HSTS and no upgrade-insecure-requests. Inline code is forbidden outright.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "blob:", "data:"],
        "media-src": ["'self'", "blob:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
    strictTransportSecurity: false,
    referrerPolicy: { policy: "no-referrer" },
  });

  // Everything under /api requires the token (or a signed link for one media file).
  const expected = sha(cfg.apiToken);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;
    if ((req.method === "GET" || req.method === "HEAD") && isSignable(url.pathname) && signer.verify(url.pathname, q.get("exp"), q.get("sig"))) return;

    const given = tokenFrom(req);
    // No credentials is not a guess (an expired signed link, a logged-out tab): it is refused but not counted.
    if (!given) return reply.code(401).send({ error: "unauthorized" });
    const wait = limiter.retryAfterSec(req.ip);
    if (wait > 0) return reply.code(429).header("retry-after", wait).send({ error: `too many wrong tokens, try again in ${wait} s` });
    if (!timingSafeEqual(sha(given), expected)) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
    limiter.succeed(req.ip);
  });
}
