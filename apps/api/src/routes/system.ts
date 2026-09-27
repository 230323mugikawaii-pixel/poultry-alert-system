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
    // Cloud Run's public frontend reserves some paths ending in z. Keep the
    // existing local probes and provide non-reserved public aliases.
    for (const path of ["/healthz", "/health"]) {
      app.get(
        path,
        {
          config: { rateLimit: false },
          schema: {
            response: { 200: StatusResponse }
          }
        },
        async () => ({ ok: true as const, service: "call-now-api" as const })
      );
    }

    for (const path of ["/readyz", "/ready"]) {
      app.get(
        path,
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
    }
  };
}
