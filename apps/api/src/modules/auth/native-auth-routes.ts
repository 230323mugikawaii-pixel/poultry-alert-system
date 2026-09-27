import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import {
  type NativeAuthService,
  nativeClientId,
  nativeRedirectUri
} from "./native-auth-service.js";
import { setSessionCookie, usesSecureCookies } from "./session-cookie.js";

export const nativeCookieName = (env: AppEnvironment, provider: string) =>
  `${env.COOKIE_NAME}_native_${provider.toLowerCase()}`;
export function nativeNoStore(reply: FastifyReply): void {
  reply
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("Referrer-Policy", "no-referrer");
}
export function createNativeAuthRoutes(
  service: NativeAuthService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.addHook("onRequest", async (_req, reply) => nativeNoStore(reply));
    app.setErrorHandler(async (error, _req, reply) => {
      const status =
        error instanceof AppError
          ? error.statusCode
          : typeof error === "object" && error !== null && "validation" in error
            ? 400
            : 503;
      await reply.status(status).send({
        error: {
          code:
            error instanceof AppError ? error.code : "NATIVE_AUTH_UNAVAILABLE",
          message: "ログインを完了できませんでした。もう一度お試しください。"
        }
      });
    });
    app.get("/api/v1/auth/native/providers", async () => ({
      providers: (["GOOGLE", "MICROSOFT"] as const).map((provider) => ({
        provider,
        status: service.availability(provider)
      }))
    }));
    app.get(
      "/api/v1/auth/native/:provider/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: {
          params: Type.Object({
            provider: Type.Union([
              Type.Literal("google"),
              Type.Literal("microsoft")
            ])
          }),
          querystring: Type.Object(
            {
              client_id: Type.Literal(nativeClientId),
              redirect_uri: Type.Literal(nativeRedirectUri),
              response_type: Type.Literal("code"),
              code_challenge_method: Type.Literal("S256"),
              code_challenge: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
              state: Type.String({ pattern: "^[A-Za-z0-9_-]{43,128}$" })
            },
            { additionalProperties: false }
          )
        }
      },
      async (request, reply) => {
        const provider =
          request.params.provider === "google" ? "GOOGLE" : "MICROSOFT";
        const result = await service.start(
          provider,
          request.query.state,
          request.query.code_challenge
        );
        reply.setCookie(
          nativeCookieName(environment, provider),
          result.binding,
          {
            httpOnly: true,
            secure: usesSecureCookies(environment),
            sameSite: "lax",
            path: `/api/v1/auth/${request.params.provider}`,
            maxAge: 600
          }
        );
        await reply.redirect(result.authorizationUrl);
      }
    );
    app.post(
      "/api/v1/auth/native/token",
      {
        bodyLimit: 2048,
        config: { rateLimit: { max: 15, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object(
            {
              grant_type: Type.Literal("authorization_code"),
              client_id: Type.Literal(nativeClientId),
              redirect_uri: Type.Literal(nativeRedirectUri),
              code: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
              code_verifier: Type.String({
                pattern: "^[A-Za-z0-9._~-]{43,128}$"
              })
            },
            { additionalProperties: false }
          )
        }
      },
      async (request, reply) => {
        // This is a public native client: no client secret, no browser cookie reliance.
        // Keep the existing origin policy, and require the one-shot PKCE proof.
        if (request.headers.origin !== environment.PUBLIC_ORIGIN)
          throw new AppError(
            "ORIGIN_NOT_ALLOWED",
            "この操作は許可されていません。",
            403
          );
        const result = await service.exchange(
          request.body.code,
          request.body.code_verifier,
          { ipAddress: request.ip }
        );
        setSessionCookie(reply, environment, result.sessionToken);
        return {
          user: {
            id: result.user.id,
            email: result.user.email,
            displayName: result.user.displayName
          }
        };
      }
    );
  };
}
