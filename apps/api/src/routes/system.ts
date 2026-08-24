import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

const StatusResponse = Type.Object({
  ok: Type.Literal(true),
  service: Type.Literal("call-now-api")
});

export const systemRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/healthz",
    {
      schema: {
        response: { 200: StatusResponse }
      }
    },
    async () => ({ ok: true as const, service: "call-now-api" as const })
  );

  app.get(
    "/readyz",
    {
      schema: {
        response: { 200: StatusResponse }
      }
    },
    async () => ({ ok: true as const, service: "call-now-api" as const })
  );
};

