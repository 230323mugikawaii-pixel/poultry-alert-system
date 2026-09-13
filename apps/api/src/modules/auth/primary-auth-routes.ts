import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { AuthService } from "./auth-service.js";
import type { PrimaryIdentityProvider } from "./auth-repository.js";
import type { PrimaryAuthService } from "./primary-auth-service.js";
import { setSessionCookie, usesSecureCookies } from "./session-cookie.js";

const ProviderParams = Type.Object({
  provider: Type.Union([
    Type.Literal("google"),
    Type.Literal("microsoft"),
    Type.Literal("apple")
  ])
});
const CallbackQuery = Type.Object({
  code: Type.Optional(Type.String({ maxLength: 4096 })),
  state: Type.Optional(Type.String({ maxLength: 100 })),
  error: Type.Optional(Type.String({ maxLength: 100 }))
});
const AppleCallbackBody = Type.Object({
  code: Type.Optional(Type.String({ maxLength: 4096 })),
  state: Type.Optional(Type.String({ maxLength: 100 })),
  error: Type.Optional(Type.String({ maxLength: 100 })),
  user: Type.Optional(Type.String({ maxLength: 8192 }))
});

export function createPrimaryAuthRoutes(
  primaryAuthService: PrimaryAuthService,
  authService: AuthService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
      app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => {
          try {
            done(null, Object.fromEntries(new URLSearchParams(String(body))));
          } catch (error) {
            done(error as Error, undefined);
          }
        }
      );
    }

    app.get("/api/v1/auth/providers", async () => ({
      providers: allProviders().map((provider) => ({
        provider,
        status: primaryAuthService.getProviderAvailability(provider)
      }))
    }));

    app.get("/api/v1/auth/identities", async (request) => {
      const userId = await authenticateUserId(
        request.cookies[environment.COOKIE_NAME],
        authService
      );
      const identities = await primaryAuthService.listIdentities(userId);
      return {
        identities: identities.map((identity) => ({
          provider: identity.provider,
          email: identity.email,
          linkedAt: identity.linkedAt.toISOString(),
          lastUsedAt: identity.lastUsedAt?.toISOString() ?? null
        }))
      };
    });

    app.get(
      "/api/v1/auth/:provider/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: ProviderParams }
      },
      async (request, reply) => {
        const provider = readProvider(request.params.provider);
        if (
          primaryAuthService.getProviderAvailability(provider) !== "AVAILABLE"
        ) {
          await reply.redirect(
            frontendResultUrl(environment, "unavailable", provider, "LOGIN")
          );
          return;
        }
        await securityThrottle.consume([
          throttleRule("primary_login_start_global", ["all"], 1_000, 1, 5),
          throttleRule(
            `primary_login_start_${provider.toLowerCase()}_source`,
            [request.ip],
            20,
            15,
            15
          )
        ]);
        const authorization =
          await primaryAuthService.createAuthorizationRequest({
            provider,
            intent: "LOGIN",
            authenticatedUserId: null
          });
        setStateCookie(reply, environment, provider, authorization.state);
        await reply.redirect(authorization.authorizationUrl);
      }
    );

    app.post(
      "/api/v1/auth/identities/:provider/link/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: ProviderParams }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin, environment);
        const provider = readProvider(request.params.provider);
        const userId = await authenticateUserId(
          request.cookies[environment.COOKIE_NAME],
          authService
        );
        if (
          primaryAuthService.getProviderAvailability(provider) !== "AVAILABLE"
        ) {
          await reply
            .status(303)
            .redirect(
              frontendResultUrl(environment, "unavailable", provider, "LINK")
            );
          return;
        }
        await securityThrottle.consume([
          throttleRule("primary_link_start_global", ["all"], 1_000, 1, 5),
          throttleRule(
            `primary_link_start_${provider.toLowerCase()}_user`,
            [userId],
            10,
            15,
            15
          )
        ]);
        const authorization =
          await primaryAuthService.createAuthorizationRequest({
            provider,
            intent: "LINK",
            authenticatedUserId: userId
          });
        setStateCookie(reply, environment, provider, authorization.state);
        await reply.status(303).redirect(authorization.authorizationUrl);
      }
    );

    app.delete(
      "/api/v1/auth/identities/:provider",
      { schema: { params: ProviderParams } },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin, environment);
        const userId = await authenticateUserId(
          request.cookies[environment.COOKIE_NAME],
          authService
        );
        await primaryAuthService.unlinkIdentity(
          userId,
          readProvider(request.params.provider)
        );
        await reply.status(204).send(null);
      }
    );

    const callback = async (
      request: CallbackRequest,
      reply: FastifyReply,
      provider: PrimaryIdentityProvider,
      values: CallbackValues
    ): Promise<void> => {
      const state = values.state ?? "";
      const cookieName = stateCookieName(environment, provider);
      const cookieState = request.cookies[cookieName] ?? "";
      reply.clearCookie(cookieName, { path: callbackPath(provider) });
      const currentUserId = await optionalAuthenticatedUserId(
        request.cookies[environment.COOKIE_NAME],
        authService
      );
      if (
        values.error ||
        !values.code ||
        !state ||
        !safeEqual(state, cookieState)
      ) {
        await reply.redirect(
          frontendResultUrl(
            environment,
            "error",
            provider,
            currentUserId ? "LINK" : "LOGIN"
          )
        );
        return;
      }
      try {
        await securityThrottle.consume([
          throttleRule("primary_callback_global", ["all"], 2_000, 1, 5),
          throttleRule(
            `primary_callback_${provider.toLowerCase()}_source`,
            [request.ip],
            30,
            15,
            15
          ),
          throttleRule(
            `primary_callback_${provider.toLowerCase()}_state`,
            [state],
            3,
            15,
            15
          )
        ]);
        const result = await primaryAuthService.completeAuthorization({
          provider,
          state,
          code: values.code,
          authenticatedUserId: currentUserId,
          ...(values.user ? { userPayload: values.user } : {}),
          clientContext: {
            ipAddress: request.ip,
            ...(typeof request.headers["user-agent"] === "string"
              ? { userAgent: request.headers["user-agent"] }
              : {})
          }
        });
        if (result.intent === "LOGIN") {
          await revokeReplacedBrowserSession(
            authService,
            request.cookies[environment.COOKIE_NAME]
          );
          setSessionCookie(reply, environment, result.sessionToken);
        }
        await reply.redirect(
          frontendResultUrl(environment, "success", provider, result.intent)
        );
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : "PRIMARY_LOGIN_FAILED";
        request.log.warn({ code, provider }, "Primary login callback failed");
        await reply.redirect(
          frontendResultUrl(
            environment,
            "error",
            provider,
            currentUserId ? "LINK" : "LOGIN"
          )
        );
      }
    };

    app.get(
      "/api/v1/auth/google/callback",
      { schema: { querystring: CallbackQuery } },
      async (request, reply) =>
        callback(request, reply, "GOOGLE", request.query)
    );
    app.get(
      "/api/v1/auth/microsoft/callback",
      { schema: { querystring: CallbackQuery } },
      async (request, reply) =>
        callback(request, reply, "MICROSOFT", request.query)
    );
    app.post(
      "/api/v1/auth/apple/callback",
      { schema: { body: AppleCallbackBody } },
      async (request, reply) => callback(request, reply, "APPLE", request.body)
    );
  };
}

interface CallbackValues {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly user?: string;
}

interface CallbackRequest {
  readonly ip: string;
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly log: { warn(data: object, message: string): unknown };
}

function allProviders(): readonly PrimaryIdentityProvider[] {
  return ["GOOGLE", "MICROSOFT", "APPLE"];
}

function readProvider(value: string): PrimaryIdentityProvider {
  if (value === "microsoft") return "MICROSOFT";
  if (value === "apple") return "APPLE";
  return "GOOGLE";
}

async function authenticateUserId(
  token: string | undefined,
  authService: AuthService
): Promise<string> {
  if (!token)
    throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
  return (await authService.authenticate(token)).user.id;
}

async function optionalAuthenticatedUserId(
  token: string | undefined,
  authService: AuthService
): Promise<string | null> {
  if (!token) return null;
  try {
    return (await authService.authenticate(token)).user.id;
  } catch {
    return null;
  }
}

function requireSameOrigin(
  origin: string | string[] | undefined,
  environment: AppEnvironment
): void {
  if (origin !== environment.PUBLIC_ORIGIN) {
    throw new AppError(
      "ORIGIN_NOT_ALLOWED",
      "この操作は許可されていません。",
      403
    );
  }
}

function setStateCookie(
  reply: { setCookie(name: string, value: string, options: object): unknown },
  environment: AppEnvironment,
  provider: PrimaryIdentityProvider,
  state: string
): void {
  reply.setCookie(stateCookieName(environment, provider), state, {
    httpOnly: true,
    secure: provider === "APPLE" ? true : usesSecureCookies(environment),
    sameSite: provider === "APPLE" ? "none" : "lax",
    path: callbackPath(provider),
    maxAge: stateTtlMinutes(environment, provider) * 60
  });
}

function stateCookieName(
  environment: AppEnvironment,
  provider: PrimaryIdentityProvider
): string {
  return `${environment.COOKIE_NAME}_${provider.toLowerCase()}_oauth_state`;
}

function callbackPath(provider: PrimaryIdentityProvider): string {
  return `/api/v1/auth/${provider.toLowerCase()}`;
}

function stateTtlMinutes(
  environment: AppEnvironment,
  provider: PrimaryIdentityProvider
): number {
  if (provider === "MICROSOFT") {
    return environment.MICROSOFT_LOGIN_OAUTH_STATE_TTL_MINUTES;
  }
  if (provider === "APPLE") return environment.APPLE_OAUTH_STATE_TTL_MINUTES;
  return environment.GOOGLE_OAUTH_STATE_TTL_MINUTES;
}

function frontendResultUrl(
  environment: AppEnvironment,
  result: "success" | "error" | "unavailable",
  provider: PrimaryIdentityProvider,
  intent: "LOGIN" | "LINK"
): string {
  const url = new URL("/", environment.PUBLIC_ORIGIN);
  url.searchParams.set(
    intent === "LINK" ? "identityLink" : "primaryAuth",
    result
  );
  url.searchParams.set("loginProvider", provider);
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

async function revokeReplacedBrowserSession(
  authService: AuthService,
  sessionToken: string | undefined
): Promise<void> {
  if (!sessionToken) return;
  try {
    const authenticated = await authService.authenticate(sessionToken);
    await authService.revokeSession(
      authenticated.user.id,
      authenticated.session.id
    );
  } catch {
    // A missing, expired, or already revoked session never blocks a new login.
  }
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
