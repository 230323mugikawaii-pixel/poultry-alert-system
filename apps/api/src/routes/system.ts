import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

const StatusResponse = Type.Object({
  ok: Type.Literal(true),
  service: Type.Literal("call-now-api")
});

const UnavailableResponse = Type.Object({
  ok: Type.Literal(false),
  service: Type.Literal("call-now-api"),
  reason: Type.Literal("dependency_unavailable")
});

export function createSystemRoutes(
  readinessCheck: () => Promise<void> = async () => undefined
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/healthz",
      {
        config: { rateLimit: false },
        schema: {
          response: { 200: StatusResponse }
        }
      },
      async () => ({ ok: true as const, service: "call-now-api" as const })
    );

    app.get(
      "/readyz",
      {
        config: { rateLimit: false },
        schema: {
          response: { 200: StatusResponse, 503: UnavailableResponse }
        }
      },
      async (_request, reply) => {
        try {
          await readinessCheck();
          return { ok: true as const, service: "call-now-api" as const };
        } catch {
          await reply.status(503).send({
            ok: false,
            service: "call-now-api",
            reason: "dependency_unavailable"
          });
        }
      }
    );
  };
}
