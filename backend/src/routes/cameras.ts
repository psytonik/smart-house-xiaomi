import { HttpError } from "../go2rtc.js";
import { REGIONS, type LoginInput, type Region } from "../xiaomi.js";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function camerasRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { xiaomi } = ctx;
  // --- cameras and Mi Home sign-in (ADR 0013): the browser never sends a stream source ---
  app.get("/api/cameras", async () => ({ streams: await xiaomi.streams(), accounts: await xiaomi.accounts() }));

  app.post("/api/xiaomi/login", async (req) => {
    const b = req.body;
    const keys = b && typeof b === "object" ? Object.keys(b) : [];
    const str = (k: string) => (b as Record<string, unknown>)[k];
    const filled = (k: string) => typeof str(k) === "string" && (str(k) as string).length > 0;
    let input: LoginInput | undefined;
    if (keys.length === 2 && filled("username") && filled("password")) input = { username: str("username") as string, password: str("password") as string };
    else if (keys.length === 1 && filled("captcha")) input = { captcha: str("captcha") as string };
    else if (keys.length === 1 && filled("verify")) input = { verify: str("verify") as string };
    if (!input) throw new HttpError(400, "send username and password, or a captcha answer, or a verification code");
    return xiaomi.login(input);
  });

  app.get<{ Querystring: { account?: string; region?: string } }>("/api/xiaomi/devices", async (req) => {
    const { account = "", region = "" } = req.query;
    return { devices: await xiaomi.devices(account, region as Region) };
  });

  app.post<{ Body: { account: string; region: Region; did: string; name: string } }>(
    "/api/cameras",
    {
      schema: {
        body: {
          type: "object",
          required: ["account", "region", "did", "name"],
          additionalProperties: false,
          properties: {
            account: { type: "string", maxLength: 40 },
            region: { type: "string", enum: [...REGIONS] },
            did: { type: "string", maxLength: 80 },
            name: { type: "string", maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(await xiaomi.add(req.body)),
  );
}
