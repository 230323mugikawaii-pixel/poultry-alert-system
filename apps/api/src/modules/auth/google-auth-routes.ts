import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { GoogleAuthService } from "./google-auth-service.js";
import type { AuthService } from "./auth-service.js";
import { setSessionCookie, usesSecureCookies } from "./session-cookie.js";

export function createGoogleAuthRoutes(
  googleAuthService: GoogleAuthService,
  authService: AuthService,
  securityThrottle: SecurityThrottleService,
  environment: AppEnvironment
): FastifyPluginAsyncTypebox {
  return async (app) => {
    const stateCookieName = `${environment.COOKIE_NAME}_google_oauth_state`;

    app.get(
      "/api/v1/auth/google/start",
      { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
      async (request, reply) => {
        await securityThrottle.consume([
          throttleRule("google_start_global", ["all"], 1_000, 1, 5),
          throttleRule("google_start_source", [request.ip], 20, 15, 15)
        ]);
        const authorization =
          await googleAuthService.createAuthorizationRequest();
        reply.setCookie(stateCookieName, authorization.state, {
          httpOnly: true,
          secure: usesSecureCookies(environment),
          sameSite: "lax",
          path: "/api/v1/auth/google",
          maxAge: environment.GOOGLE_OAUTH_STATE_TTL_MINUTES * 60
        });
        await reply.redirect(authorization.authorizationUrl);
      }
    );

    app.get(
      "/api/v1/auth/google/callback",
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
        reply.clearCookie(stateCookieName, { path: "/api/v1/auth/google" });

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
          await securityThrottle.consume([
            throttleRule("google_callback_global", ["all"], 2_000, 1, 5),
            throttleRule("google_callback_source", [request.ip], 30, 15, 15),
            throttleRule("google_callback_state", [state], 3, 15, 15)
          ]);
          const result = await googleAuthService.completeAuthorization(
            state,
            request.query.code,
            {
              ipAddress: request.ip,
              ...(request.headers["user-agent"]
                ? { userAgent: request.headers["user-agent"] }
                : {})
            }
          );
          await revokeReplacedBrowserSession(
            authService,
            request.cookies[environment.COOKIE_NAME]
          );
          setSessionCookie(reply, environment, result.sessionToken);
          await reply.redirect(frontendResultUrl(environment, "success"));
        } catch (error) {
          const code =
            error instanceof AppError ? error.code : "GOOGLE_LOGIN_FAILED";
          request.log.warn({ code }, "Google login callback failed");
          await reply.redirect(frontendResultUrl(environment, "error"));
        }
      }
    );
  };
}

async function revokeReplacedBrowserSession(
  authService: AuthService,
  sessionToken: string | undefined
): Promise<void> {
  if (!sessionToken) {
    return;
  }
  try {
    const authenticated = await authService.authenticate(sessionToken);
    await authService.revokeSession(
      authenticated.user.id,
      authenticated.session.id
    );
  } catch {
    // A missing, expired, or already revoked cookie must not block a new login.
  }
}

function frontendResultUrl(
  environment: AppEnvironment,
  result: "success" | "error"
): string {
  const url = new URL("/", environment.PUBLIC_ORIGIN);
  url.searchParams.set("googleAuth", result);
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
