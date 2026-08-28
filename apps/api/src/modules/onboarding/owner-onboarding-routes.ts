import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AppEnvironment } from "../../config/env.js";
import { AppError } from "../../lib/app-error.js";
import type { AuthService } from "../auth/auth-service.js";
import { usesSecureCookies } from "../auth/session-cookie.js";
import type { MailProviderId } from "../mail/mail-provider.js";
import type { SecurityThrottleService } from "../security/security-throttle-service.js";
import type { OwnerOnboardingRecord } from "./owner-onboarding-repository.js";
import type { OwnerOnboardingService } from "./owner-onboarding-service.js";

const ProviderParams = Type.Object({
  provider: Type.Union([Type.Literal("google"), Type.Literal("microsoft")])
});
const ChoiceParams = Type.Object({
  choiceId: Type.String({ format: "uuid" })
});
const OnboardingResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  status: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("PURCHASED"),
    Type.Literal("COMPLETED"),
    Type.Literal("EXPIRED"),
    Type.Literal("ABANDONED")
  ]),
  teamId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  seatCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  keywords: Type.Array(Type.String()),
  expiresAt: Type.String(),
  purchasedAt: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  choices: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      provider: Type.Union([Type.Literal("GOOGLE"), Type.Literal("MICROSOFT")]),
      status: Type.Union([
        Type.Literal("AUTHORIZED"),
        Type.Literal("ACTIVATED"),
        Type.Literal("DEFERRED"),
        Type.Literal("SKIPPED")
      ]),
      email: Type.Union([Type.String(), Type.Null()])
    })
  )
});

export function createOwnerOnboardingRoutes(
  authService: AuthService,
  onboardingService: OwnerOnboardingService,
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

    app.get("/api/v1/owner-onboarding/providers", async () => ({
      providers: (["GOOGLE", "MICROSOFT"] as const).map((provider) => ({
        provider,
        status: onboardingService.providerAvailability(provider)
      }))
    }));

    app.get(
      "/api/v1/owner-onboarding/current",
      {
        schema: {
          response: {
            200: Type.Object({
              onboarding: Type.Union([OnboardingResponse, Type.Null()])
            })
          }
        }
      },
      async (request) => {
        const userId = await authenticateUserId(
          request.cookies,
          authService,
          environment
        );
        const onboarding = await onboardingService.getCurrent(userId);
        return {
          onboarding: onboarding ? serializeOnboarding(onboarding) : null
        };
      }
    );

    app.post(
      "/api/v1/owner-onboarding/oauth/:provider/start",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: { params: ProviderParams }
      },
      async (request, reply) => {
        requireSameOrigin(request.headers.origin, environment);
        const provider = readProvider(request.params.provider);
        if (onboardingService.providerAvailability(provider) !== "AVAILABLE") {
          await reply
            .status(303)
            .redirect(
              ownerOnboardingResultUrl(environment, "unavailable", provider)
            );
          return;
        }
        const userId = await optionalAuthenticatedUserId(
          request.cookies,
          authService,
          environment
        );
        await securityThrottle.consume([
          throttleRule("owner_onboarding_start_global", ["all"], 1_000, 1, 5),
          throttleRule(
            "owner_onboarding_start_source",
            [request.ip],
            20,
            15,
            15
          ),
          throttleRule(
            `owner_onboarding_start_${provider.toLowerCase()}_actor`,
            [userId ?? request.ip],
            10,
            15,
            15
          )
        ]);
        const authorization =
          await onboardingService.createAuthorizationRequest({
            provider,
            authenticatedUserId: userId
          });
        const cookie = ownerOnboardingStateCookie(environment, provider);
        reply.setCookie(cookie.name, authorization.state, {
          httpOnly: true,
          secure: usesSecureCookies(environment),
          sameSite: "lax",
          path: cookie.path,
          maxAge: cookie.ttlMinutes * 60
        });
        await reply.status(303).redirect(authorization.authorizationUrl);
      }
    );

    app.post(
      "/api/v1/owner-onboarding/providers/:provider/skip",
      {
        schema: {
          params: ProviderParams,
          response: { 200: OnboardingResponse }
        }
      },
      async (request) => {
        requireSameOrigin(request.headers.origin, environment);
        const userId = await authenticateUserId(
          request.cookies,
          authService,
          environment
        );
        return serializeOnboarding(
          await onboardingService.skipProvider(
            userId,
            readProvider(request.params.provider)
          )
        );
      }
    );

    app.post(
      "/api/v1/owner-onboarding/demo-purchase",
      {
        config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
        schema: {
          body: Type.Object({
            onboardingId: Type.String({ format: "uuid" }),
            keywords: Type.Array(
              Type.String({ minLength: 1, maxLength: 100 }),
              { minItems: 1, maxItems: 100 }
            ),
            seatCount: Type.Integer({ minimum: 1, maximum: 101 })
          }),
          response: {
            200: Type.Object({
              demoPurchase: Type.Literal(true),
              amountYen: Type.Integer({ minimum: 6000 }),
              onboarding: OnboardingResponse
            })
          }
        }
      },
      async (request) => {
        requireSameOrigin(request.headers.origin, environment);
        const userId = await authenticateUserId(
          request.cookies,
          authService,
          environment
        );
        const created = await onboardingService.completeDemoPurchase({
          userId,
          onboardingId: request.body.onboardingId,
          keywords: request.body.keywords,
          seatCount: request.body.seatCount
        });
        const onboarding = await onboardingService.getCurrent(userId);
        if (!onboarding) throw new Error("owner_onboarding_purchase_missing");
        return {
          demoPurchase: true as const,
          amountYen: created.team.currentTermAmountYen,
          onboarding: serializeOnboarding(onboarding)
        };
      }
    );

    app.post(
      "/api/v1/owner-onboarding/choices/:choiceId/activate",
      {
        schema: { params: ChoiceParams, response: { 200: OnboardingResponse } }
      },
      async (request) => {
        requireSameOrigin(request.headers.origin, environment);
        const userId = await authenticateUserId(
          request.cookies,
          authService,
          environment
        );
        return serializeOnboarding(
          await onboardingService.activateChoice({
            userId,
            choiceId: request.params.choiceId,
            requestId: request.id
          })
        );
      }
    );

    app.post(
      "/api/v1/owner-onboarding/choices/:choiceId/defer",
      {
        schema: { params: ChoiceParams, response: { 200: OnboardingResponse } }
      },
      async (request) => {
        requireSameOrigin(request.headers.origin, environment);
        const userId = await authenticateUserId(
          request.cookies,
          authService,
          environment
        );
        return serializeOnboarding(
          await onboardingService.deferChoice(userId, request.params.choiceId)
        );
      }
    );
  };
}

export function ownerOnboardingStateCookie(
  environment: AppEnvironment,
  provider: MailProviderId
) {
  return provider === "GOOGLE"
    ? {
        name: `${environment.COOKIE_NAME}_onboarding_google_state`,
        path: "/api/v1/auth/gmail",
        ttlMinutes: environment.GMAIL_OAUTH_STATE_TTL_MINUTES
      }
    : {
        name: `${environment.COOKIE_NAME}_onboarding_microsoft_state`,
        path: "/api/v1/auth/mail/microsoft",
        ttlMinutes: environment.MICROSOFT_OAUTH_STATE_TTL_MINUTES
      };
}

export function ownerOnboardingResultUrl(
  environment: AppEnvironment,
  result: "success" | "error" | "unavailable",
  provider: MailProviderId
): string {
  const url = new URL("/", environment.PUBLIC_ORIGIN);
  url.searchParams.set("ownerOnboarding", result);
  url.searchParams.set("mailProvider", provider);
  return url.toString();
}

function serializeOnboarding(onboarding: OwnerOnboardingRecord) {
  return {
    id: onboarding.id,
    status: onboarding.status,
    teamId: onboarding.teamId,
    seatCount: onboarding.seatCount,
    keywords: [...onboarding.keywords],
    expiresAt: onboarding.expiresAt.toISOString(),
    purchasedAt: onboarding.purchasedAt?.toISOString() ?? null,
    completedAt: onboarding.completedAt?.toISOString() ?? null,
    choices: onboarding.choices.map((choice) => ({
      id: choice.id,
      provider: choice.provider,
      status: choice.status,
      email: choice.email
    }))
  };
}

async function authenticateUserId(
  cookies: Readonly<Record<string, string | undefined>>,
  authService: AuthService,
  environment: AppEnvironment
): Promise<string> {
  const token = cookies[environment.COOKIE_NAME];
  if (!token)
    throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
  return (await authService.authenticate(token)).user.id;
}

async function optionalAuthenticatedUserId(
  cookies: Readonly<Record<string, string | undefined>>,
  authService: AuthService,
  environment: AppEnvironment
): Promise<string | null> {
  try {
    return await authenticateUserId(cookies, authService, environment);
  } catch {
    return null;
  }
}

function readProvider(value: string): MailProviderId {
  return value === "microsoft" ? "MICROSOFT" : "GOOGLE";
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

function throttleRule(
  scope: string,
  dimensions: readonly string[],
  maximumAttempts: number,
  windowMinutes: number,
  lockMinutes: number
) {
  return { scope, dimensions, maximumAttempts, windowMinutes, lockMinutes };
}
