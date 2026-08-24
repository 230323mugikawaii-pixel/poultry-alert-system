import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthenticatedSession, AuthService } from "./auth-service.js";

const AcceptedResponse = Type.Object({ accepted: Type.Literal(true) });
const UserResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  email: Type.String(),
  displayName: Type.Union([Type.String(), Type.Null()])
});
const SessionResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  deviceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  deviceName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  expiresAt: Type.String(),
  current: Type.Boolean()
});

export function createAuthRoutes(
  authService: AuthService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const authenticate = async (request: {
      readonly cookies: Readonly<Record<string, string | undefined>>;
    }): Promise<AuthenticatedSession> => {
      const token = request.cookies[environment.COOKIE_NAME];
      if (!token) {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
      return authService.authenticate(token);
    };

    const requireSameOrigin = (request: {
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    }): void => {
      if (request.headers.origin !== environment.PUBLIC_ORIGIN) {
        throw new AppError(
          "ORIGIN_NOT_ALLOWED",
          "この操作は許可されていません。",
          403
        );
      }
    };

    app.post(
      "/api/v1/auth/magic-links/request",
      {
        config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            email: Type.String({ minLength: 3, maxLength: 320 })
          }),
          response: { 202: AcceptedResponse }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        await authService.requestMagicLink(request.body.email);
        await reply.status(202).send({ accepted: true });
      }
    );

    app.post(
      "/api/v1/auth/magic-links/consume",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            token: Type.String({ minLength: 40, maxLength: 100 }),
            deviceName: Type.Optional(
              Type.String({ minLength: 1, maxLength: 120 })
            )
          }),
          response: { 200: Type.Object({ user: UserResponse }) }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const result = await authService.consumeMagicLink(request.body.token, {
          ...(request.body.deviceName
            ? { deviceName: request.body.deviceName }
            : {}),
          ipAddress: request.ip,
          ...(request.headers["user-agent"]
            ? { userAgent: request.headers["user-agent"] }
            : {})
        });

        reply.setCookie(environment.COOKIE_NAME, result.sessionToken, {
          httpOnly: true,
          secure:
            environment.APP_ENV === "production" ||
            environment.APP_ENV === "staging",
          sameSite: "lax",
          path: "/",
          maxAge: environment.SESSION_ABSOLUTE_DAYS * 86_400
        });
        await reply.send({ user: publicUser(result.user) });
      }
    );

    app.get(
      "/api/v1/auth/me",
      { schema: { response: { 200: Type.Object({ user: UserResponse }) } } },
      async (request) => {
        const authenticated = await authenticate(request);
        return { user: publicUser(authenticated.user) };
      }
    );

    app.get(
      "/api/v1/auth/sessions",
      {
        schema: {
          response: {
            200: Type.Object({ sessions: Type.Array(SessionResponse) })
          }
        }
      },
      async (request) => {
        const authenticated = await authenticate(request);
        const sessions = await authService.listSessions(
          authenticated.user.id,
          authenticated.session.id
        );
        return {
          sessions: sessions.map((session) => ({
            id: session.id,
            deviceId: session.deviceId,
            deviceName: session.deviceName,
            createdAt: session.createdAt.toISOString(),
            lastSeenAt: session.lastSeenAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
            current: session.current ?? false
          }))
        };
      }
    );

    app.delete(
      "/api/v1/auth/sessions/:sessionId",
      {
        schema: {
          params: Type.Object({ sessionId: Type.String({ format: "uuid" }) }),
          response: { 204: Type.Null() }
        }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const authenticated = await authenticate(request);
        await authService.revokeSession(
          authenticated.user.id,
          request.params.sessionId
        );
        if (authenticated.session.id === request.params.sessionId) {
          reply.clearCookie(environment.COOKIE_NAME, { path: "/" });
        }
        await reply.status(204).send(null);
      }
    );

    app.post(
      "/api/v1/auth/logout",
      { schema: { response: { 204: Type.Null() } } },
      async (request, reply) => {
        requireSameOrigin(request);
        const authenticated = await authenticate(request);
        await authService.revokeSession(
          authenticated.user.id,
          authenticated.session.id
        );
        reply.clearCookie(environment.COOKIE_NAME, { path: "/" });
        await reply.status(204).send(null);
      }
    );

    app.post(
      "/api/v1/auth/logout-all",
      { schema: { response: { 204: Type.Null() } } },
      async (request, reply) => {
        requireSameOrigin(request);
        const authenticated = await authenticate(request);
        await authService.revokeAllSessions(authenticated.user.id);
        reply.clearCookie(environment.COOKIE_NAME, { path: "/" });
        await reply.status(204).send(null);
      }
    );
  };
}

function publicUser(user: {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
}): {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  };
}
