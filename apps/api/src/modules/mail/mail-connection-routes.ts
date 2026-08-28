import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import { usesSecureCookies } from "../auth/session-cookie.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { TeamService } from "../teams/team-service.js";
import type { MailConnectionRecord } from "./mail-connection-repository.js";
import type { MailConnectionService } from "./mail-connection-service.js";
import type { MailProviderId } from "./mail-provider.js";
import {
  getMailProviderAvailability,
  getMailProviderStatuses
} from "./mail-provider-configuration.js";

const TeamParams = Type.Object({
  teamId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
  })
});
const ConnectionParams = Type.Object({
  teamId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
  }),
  connectionId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
  })
});
const ProviderQuery = Type.Object({
  provider: Type.Union([Type.Literal("GOOGLE"), Type.Literal("MICROSOFT")])
});
const CallbackQuery = Type.Object({
  code: Type.Optional(Type.String({ maxLength: 4096 })),
  state: Type.Optional(Type.String({ maxLength: 100 })),
  error: Type.Optional(Type.String({ maxLength: 100 }))
});
const ConnectionResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  teamId: Type.String({ format: "uuid" }),
  provider: Type.Union([Type.Literal("GOOGLE"), Type.Literal("MICROSOFT")]),
  email: Type.String(),
  authorizationStatus: Type.Union([
    Type.Literal("ACTIVE"),
    Type.Literal("REAUTH_REQUIRED"),
    Type.Literal("REVOKED"),
    Type.Literal("ERROR")
  ]),
  connectionStatus: Type.Union([
    Type.Literal("ACTIVE"),
    Type.Literal("REAUTH_REQUIRED"),
    Type.Literal("REVOKED"),
    Type.Literal("ERROR")
  ]),
  grantedScopes: Type.Array(Type.String()),
  lastVerifiedAt: Type.Union([Type.String(), Type.Null()]),
  lastSyncAt: Type.Union([Type.String(), Type.Null()]),
  lastErrorCode: Type.Union([Type.String(), Type.Null()])
});

export function createMailConnectionRoutes(
  authService: AuthService,
  teamService: TeamService,
  mailConnectionService: MailConnectionService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
      app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, body)
      );
    }

    const authenticateUserId = async (request: {
      readonly cookies: Readonly<Record<string, string | undefined>>;
    }): Promise<string> => {
      const sessionToken = request.cookies[environment.COOKIE_NAME];
      if (!sessionToken) {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
      return (await authService.authenticate(sessionToken)).user.id;
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

    const getConnections = async (request: {
      readonly params: { readonly teamId: string };
      readonly cookies: Readonly<Record<string, string | undefined>>;
    }) => {
      const userId = await authenticateUserId(request);
      await teamService.requireOwnerForTeam(userId, request.params.teamId);
      const connections = await mailConnectionService.getConnections(
        request.params.teamId,
        userId
      );
      return {
        connections: connections.map(serializeConnection)
      };
    };

    app.get(
      "/api/v1/teams/:teamId/mail-connections",
      {
        schema: {
          params: TeamParams,
          response: {
            200: Type.Object({ connections: Type.Array(ConnectionResponse) })
          }
        }
      },
      getConnections
    );

    const getLegacyConnection = async (request: {
      readonly params: { readonly teamId: string };
      readonly cookies: Readonly<Record<string, string | undefined>>;
    }) => {
      const result = await getConnections(request);
      return { connection: result.connections[0] ?? null };
    };

    app.get(
      "/api/v1/teams/:teamId/mail-connection",
      {
        schema: {
          params: TeamParams,
          response: {
            200: Type.Object({
              connection: Type.Union([ConnectionResponse, Type.Null()])
            })
          }
        }
      },
      getLegacyConnection
    );

    // Compatibility for clients shipped with the Gmail-only foundation.
    app.get(
      "/api/v1/teams/:teamId/gmail-connection",
      {
        schema: {
          params: TeamParams,
          response: {
            200: Type.Object({
              connection: Type.Union([ConnectionResponse, Type.Null()])
            })
          }
        }
      },
      getLegacyConnection
    );

    app.get(
      "/api/v1/teams/:teamId/mail-connection/providers",
      {
        schema: {
          params: TeamParams,
          response: {
            200: Type.Object({
              providers: Type.Array(
                Type.Object({
                  provider: Type.Union([
                    Type.Literal("GOOGLE"),
                    Type.Literal("MICROSOFT")
                  ]),
                  status: Type.Union([
                    Type.Literal("AVAILABLE"),
                    Type.Literal("NOT_CONFIGURED")
                  ])
                })
              )
            })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        const statuses = getMailProviderStatuses(environment);
        return {
          providers: [
            { provider: "GOOGLE" as const, status: statuses.GOOGLE },
            { provider: "MICROSOFT" as const, status: statuses.MICROSOFT }
          ]
        };
      }
    );

    app.get(
      "/api/v1/teams/:teamId/gmail-connection/provider-status",
      { schema: { params: TeamParams } },
      async (request) => {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        return {
          provider: "GOOGLE" as const,
          status: getMailProviderAvailability(environment, "GOOGLE")
        };
      }
    );

    const startOAuth = async (
      request: StartRequest,
      reply: StartReply,
      intent: "CONNECT" | "REAUTHORIZE",
      provider: MailProviderId,
      connectionId: string | null = null
    ): Promise<void> => {
      requireSameOrigin(request);
      try {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        if (
          getMailProviderAvailability(environment, provider) !== "AVAILABLE"
        ) {
          request.log.warn(
            { code: "MAIL_PROVIDER_NOT_CONFIGURED", provider },
            "Mail OAuth start unavailable"
          );
          await reply
            .status(303)
            .redirect(frontendResultUrl(environment, "unavailable", provider));
          return;
        }
        const throttlePrefix = `mail_${provider.toLowerCase()}_start`;
        await securityThrottle.consume([
          throttleRule(`${throttlePrefix}_global`, ["all"], 1_000, 1, 5),
          throttleRule(`${throttlePrefix}_source`, [request.ip], 20, 15, 15),
          throttleRule(`${throttlePrefix}_user`, [userId], 10, 15, 15),
          throttleRule(
            `${throttlePrefix}_team_user`,
            [request.params.teamId, userId],
            10,
            15,
            15
          )
        ]);
        const authorization =
          await mailConnectionService.createAuthorizationRequest(
            userId,
            request.params.teamId,
            intent,
            provider,
            connectionId
          );
        const stateCookie = stateCookieConfiguration(environment, provider);
        reply.setCookie(stateCookie.name, authorization.state, {
          httpOnly: true,
          secure: usesSecureCookies(environment),
          sameSite: "lax",
          path: stateCookie.path,
          maxAge: stateCookie.ttlMinutes * 60
        });
        await reply.status(303).redirect(authorization.authorizationUrl);
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) {
          throw error;
        }
        request.log.error(
          { err: error, code: "MAIL_OAUTH_START_FAILED", provider },
          "Mail OAuth start failed"
        );
        await reply
          .status(303)
          .redirect(frontendResultUrl(environment, "error", provider));
      }
    };

    app.post(
      "/api/v1/teams/:teamId/mail-connection/oauth/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: TeamParams, querystring: ProviderQuery }
      },
      async (request, reply) =>
        startOAuth(request, reply, "CONNECT", request.query.provider)
    );

    app.post(
      "/api/v1/teams/:teamId/mail-connections/:connectionId/reauthorize",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: ConnectionParams, querystring: ProviderQuery }
      },
      async (request, reply) =>
        startOAuth(
          request,
          reply,
          "REAUTHORIZE",
          request.query.provider,
          request.params.connectionId
        )
    );

    app.post(
      "/api/v1/teams/:teamId/gmail-connection/oauth/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: TeamParams }
      },
      async (request, reply) => startOAuth(request, reply, "CONNECT", "GOOGLE")
    );

    const handleCallback = async (
      request: CallbackRequest,
      reply: CallbackReply,
      provider: MailProviderId
    ): Promise<void> => {
      const state = request.query.state ?? "";
      const stateCookie = stateCookieConfiguration(environment, provider);
      const cookieState = request.cookies[stateCookie.name] ?? "";
      reply.clearCookie(stateCookie.name, { path: stateCookie.path });
      if (
        request.query.error ||
        !request.query.code ||
        !state ||
        !safeEqual(state, cookieState)
      ) {
        await reply.redirect(frontendResultUrl(environment, "error", provider));
        return;
      }
      try {
        const userId = await authenticateUserId(request);
        const throttlePrefix = `mail_${provider.toLowerCase()}_callback`;
        await securityThrottle.consume([
          throttleRule(`${throttlePrefix}_global`, ["all"], 2_000, 1, 5),
          throttleRule(`${throttlePrefix}_source`, [request.ip], 30, 15, 15),
          throttleRule(`${throttlePrefix}_user`, [userId], 20, 15, 15),
          throttleRule(`${throttlePrefix}_state`, [state], 3, 15, 15)
        ]);
        await mailConnectionService.completeAuthorization({
          provider,
          state,
          code: request.query.code,
          authenticatedUserId: userId,
          requestId: request.id
        });
        await reply.redirect(
          frontendResultUrl(environment, "success", provider)
        );
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : "MAIL_AUTH_FAILED";
        const reasonCode =
          error instanceof AppError &&
          typeof error.details?.reasonCode === "string"
            ? error.details.reasonCode
            : "UNCLASSIFIED";
        request.log.warn(
          { code, provider, reasonCode },
          "Mail authorization callback failed"
        );
        await reply.redirect(frontendResultUrl(environment, "error", provider));
      }
    };

    app.get(
      "/api/v1/auth/gmail/callback",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: { querystring: CallbackQuery }
      },
      async (request, reply) => handleCallback(request, reply, "GOOGLE")
    );

    app.get(
      "/api/v1/auth/mail/microsoft/callback",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: { querystring: CallbackQuery }
      },
      async (request, reply) => handleCallback(request, reply, "MICROSOFT")
    );

    const disconnect = async (
      request: DisconnectRequest,
      reply: DisconnectReply
    ): Promise<void> => {
      requireSameOrigin(request);
      const userId = await authenticateUserId(request);
      await teamService.requireOwnerForTeam(userId, request.params.teamId);
      await mailConnectionService.disconnect({
        teamId: request.params.teamId,
        ownerUserId: userId,
        connectionId: request.params.connectionId,
        requestId: request.id
      });
      await reply.status(204).send(null);
    };

    app.delete(
      "/api/v1/teams/:teamId/mail-connections/:connectionId",
      { schema: { params: ConnectionParams } },
      disconnect
    );
  };
}

interface BaseRequest {
  readonly id: string;
  readonly ip: string;
  readonly params: { readonly teamId: string; readonly connectionId?: string };
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly log: {
    error(data: object, message: string): unknown;
    warn(data: object, message: string): unknown;
  };
}

type StartRequest = BaseRequest;
type DisconnectRequest = Omit<BaseRequest, "params"> & {
  readonly params: { readonly teamId: string; readonly connectionId: string };
};

interface StartReply {
  setCookie(name: string, value: string, options: object): unknown;
  status(code: number): { redirect(url: string): unknown };
}

interface DisconnectReply {
  status(code: number): { send(value: null): unknown };
}

interface CallbackRequest {
  readonly id: string;
  readonly ip: string;
  readonly query: {
    readonly code?: string;
    readonly state?: string;
    readonly error?: string;
  };
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly log: { warn(data: object, message: string): unknown };
}

interface CallbackReply {
  clearCookie(name: string, options: object): unknown;
  redirect(url: string): unknown;
}

function serializeConnection(connection: MailConnectionRecord) {
  return {
    id: connection.id,
    teamId: connection.teamId,
    provider: connection.provider,
    email: connection.email,
    authorizationStatus: connection.authorizationStatus,
    connectionStatus: connection.connectionStatus,
    grantedScopes: [...connection.grantedScopes],
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
    lastErrorCode: connection.lastErrorCode
  };
}

function stateCookieConfiguration(
  environment: AppEnvironment,
  provider: MailProviderId
): {
  readonly name: string;
  readonly path: string;
  readonly ttlMinutes: number;
} {
  return provider === "GOOGLE"
    ? {
        name: `${environment.COOKIE_NAME}_mail_google_state`,
        path: "/api/v1/auth/gmail",
        ttlMinutes: environment.GMAIL_OAUTH_STATE_TTL_MINUTES
      }
    : {
        name: `${environment.COOKIE_NAME}_mail_microsoft_state`,
        path: "/api/v1/auth/mail/microsoft",
        ttlMinutes: environment.MICROSOFT_OAUTH_STATE_TTL_MINUTES
      };
}

function frontendResultUrl(
  environment: AppEnvironment,
  result: "success" | "error" | "unavailable",
  provider: MailProviderId
): string {
  const url = new URL("/", environment.PUBLIC_ORIGIN);
  url.searchParams.set("mailAuth", result);
  url.searchParams.set("mailProvider", provider);
  return url.toString();
}

function safeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first, "utf8");
  const secondBuffer = Buffer.from(second, "utf8");
  return (
    firstBuffer.length === secondBuffer.length &&
    timingSafeEqual(firstBuffer, secondBuffer)
  );
}

function throttleRule(
  scope: string,
  dimensions: readonly string[],
  maximumAttempts: number,
  windowMinutes: number,
  lockMinutes: number
) {
  return { scope, dimensions, maximumAttempts, windowMinutes, lockMinutes };
}
