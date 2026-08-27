import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import { usesSecureCookies } from "../auth/session-cookie.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { TeamService } from "../teams/team-service.js";
import type { GmailConnectionRecord } from "./gmail-connection-repository.js";
import type { GmailConnectionService } from "./gmail-connection-service.js";
import { getGmailProviderAvailability } from "./gmail-provider-configuration.js";

const TeamParams = Type.Object({
  teamId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
  })
});
const ConnectionResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  teamId: Type.String({ format: "uuid" }),
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

export function createGmailConnectionRoutes(
  authService: AuthService,
  teamService: TeamService,
  gmailConnectionService: GmailConnectionService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body)
    );

    const stateCookieName = `${environment.COOKIE_NAME}_gmail_oauth_state`;

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
      async (request) => {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        const connection = await gmailConnectionService.getConnection(
          request.params.teamId,
          userId
        );
        return {
          connection: connection ? serializeConnection(connection) : null
        };
      }
    );

    app.get(
      "/api/v1/teams/:teamId/gmail-connection/provider-status",
      {
        schema: {
          params: TeamParams,
          response: {
            200: Type.Object({
              provider: Type.Literal("GOOGLE"),
              status: Type.Union([
                Type.Literal("AVAILABLE"),
                Type.Literal("NOT_CONFIGURED")
              ])
            })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        return {
          provider: "GOOGLE" as const,
          status: getGmailProviderAvailability(environment)
        };
      }
    );

    const startOAuth = async (
      request: {
        readonly id: string;
        readonly ip: string;
        readonly params: { readonly teamId: string };
        readonly cookies: Readonly<Record<string, string | undefined>>;
        readonly headers: Readonly<
          Record<string, string | string[] | undefined>
        >;
        readonly log: {
          error(data: object, message: string): unknown;
          warn(data: object, message: string): unknown;
        };
      },
      reply: {
        setCookie(name: string, value: string, options: object): unknown;
        status(code: number): { redirect(url: string): unknown };
      },
      intent: "CONNECT" | "REAUTHORIZE"
    ): Promise<void> => {
      requireSameOrigin(request);
      try {
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        if (getGmailProviderAvailability(environment) !== "AVAILABLE") {
          request.log.warn(
            { code: "GMAIL_PROVIDER_NOT_CONFIGURED", provider: "GOOGLE" },
            "Gmail OAuth start unavailable"
          );
          await reply
            .status(303)
            .redirect(frontendResultUrl(environment, "unavailable"));
          return;
        }
        await securityThrottle.consume([
          throttleRule("gmail_start_global", ["all"], 1_000, 1, 5),
          throttleRule("gmail_start_source", [request.ip], 20, 15, 15),
          throttleRule("gmail_start_user", [userId], 10, 15, 15),
          throttleRule(
            "gmail_start_team_user",
            [request.params.teamId, userId],
            10,
            15,
            15
          )
        ]);
        const authorization =
          await gmailConnectionService.createAuthorizationRequest(
            userId,
            request.params.teamId,
            intent
          );
        reply.setCookie(stateCookieName, authorization.state, {
          httpOnly: true,
          secure: usesSecureCookies(environment),
          sameSite: "lax",
          path: "/api/v1/auth/gmail",
          maxAge: environment.GMAIL_OAUTH_STATE_TTL_MINUTES * 60
        });
        await reply.status(303).redirect(authorization.authorizationUrl);
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) {
          throw error;
        }
        request.log.error(
          {
            err: error,
            code: "GMAIL_OAUTH_START_FAILED",
            provider: "GOOGLE"
          },
          "Gmail OAuth start failed"
        );
        await reply
          .status(303)
          .redirect(frontendResultUrl(environment, "error"));
      }
    };

    app.post(
      "/api/v1/teams/:teamId/gmail-connection/oauth/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: TeamParams }
      },
      async (request, reply) => startOAuth(request, reply, "CONNECT")
    );

    app.post(
      "/api/v1/teams/:teamId/gmail-connection/reauthorize",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: TeamParams }
      },
      async (request, reply) => startOAuth(request, reply, "REAUTHORIZE")
    );

    app.get(
      "/api/v1/auth/gmail/callback",
      {
        config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
        schema: {
          querystring: Type.Object({
            code: Type.Optional(Type.String({ maxLength: 4096 })),
            state: Type.Optional(Type.String({ maxLength: 100 })),
            error: Type.Optional(Type.String({ maxLength: 100 }))
          })
        }
      },
      async (request, reply) => {
        const state = request.query.state ?? "";
        const stateCookie = request.cookies[stateCookieName] ?? "";
        reply.clearCookie(stateCookieName, { path: "/api/v1/auth/gmail" });
        if (
          request.query.error ||
          !request.query.code ||
          !state ||
          !safeEqual(state, stateCookie)
        ) {
          await reply.redirect(frontendResultUrl(environment, "error"));
          return;
        }
        try {
          const userId = await authenticateUserId(request);
          await securityThrottle.consume([
            throttleRule("gmail_callback_global", ["all"], 2_000, 1, 5),
            throttleRule("gmail_callback_source", [request.ip], 30, 15, 15),
            throttleRule("gmail_callback_user", [userId], 20, 15, 15),
            throttleRule("gmail_callback_state", [state], 3, 15, 15)
          ]);
          await gmailConnectionService.completeAuthorization({
            state,
            code: request.query.code,
            authenticatedUserId: userId,
            requestId: request.id
          });
          await reply.redirect(frontendResultUrl(environment, "success"));
        } catch (error) {
          const code =
            error instanceof AppError ? error.code : "GMAIL_AUTH_FAILED";
          const reasonCode =
            error instanceof AppError &&
            typeof error.details?.reasonCode === "string"
              ? error.details.reasonCode
              : "UNCLASSIFIED";
          request.log.warn(
            { code, reasonCode },
            "Gmail authorization callback failed"
          );
          await reply.redirect(frontendResultUrl(environment, "error"));
        }
      }
    );

    app.delete(
      "/api/v1/teams/:teamId/gmail-connection",
      {
        schema: { params: TeamParams, response: { 204: Type.Null() } }
      },
      async (request, reply) => {
        requireSameOrigin(request);
        const userId = await authenticateUserId(request);
        await teamService.requireOwnerForTeam(userId, request.params.teamId);
        await gmailConnectionService.disconnect({
          teamId: request.params.teamId,
          ownerUserId: userId,
          requestId: request.id
        });
        await reply.status(204).send(null);
      }
    );
  };
}

function serializeConnection(connection: GmailConnectionRecord) {
  return {
    id: connection.id,
    teamId: connection.teamId,
    email: connection.email,
    authorizationStatus: connection.authorizationStatus,
    connectionStatus: connection.connectionStatus,
    grantedScopes: [...connection.grantedScopes],
    lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
    lastErrorCode: connection.lastErrorCode
  };
}

function frontendResultUrl(
  environment: AppEnvironment,
  result: "success" | "error" | "unavailable"
): string {
  const url = new URL("/", environment.PUBLIC_ORIGIN);
  url.searchParams.set("gmailAuth", result);
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
