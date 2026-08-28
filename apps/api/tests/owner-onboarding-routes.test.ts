import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { MailConnectionService } from "../src/modules/mail/mail-connection-service.js";
import type {
  MailOAuthGrant,
  MailProviderAdapter,
  MailProviderId
} from "../src/modules/mail/mail-provider.js";
import { LocalAesGcmTokenEncryptionProvider } from "../src/modules/mail/token-encryption.js";
import { OwnerOnboardingService } from "../src/modules/onboarding/owner-onboarding-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemoryMailConnectionRepository } from "./helpers/memory-mail.js";
import { MemoryOwnerOnboardingRepository } from "./helpers/memory-owner-onboarding.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const environment = loadEnvironment({
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_owner_onboarding_test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/callnow_test",
  AUTH_TOKEN_PEPPER:
    "owner-onboarding-test-pepper-at-least-thirty-two-characters",
  GMAIL_OAUTH_CLIENT_ID: "test-gmail-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
  GMAIL_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/gmail/callback",
  MICROSOFT_OAUTH_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_OAUTH_CLIENT_SECRET: "test-microsoft-client-secret",
  MICROSOFT_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/mail/microsoft/callback",
  MAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64"),
  MAIL_TOKEN_ENCRYPTION_KEY_VERSION: "owner-onboarding-route-test-v1"
});

describe("owner monitoring onboarding routes", () => {
  it("binds state to an HttpOnly cookie and fails cancellation safely", async () => {
    const app = await createFixture();
    const started = await startGoogle(app);
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = cookieNamed(
      started.headers["set-cookie"],
      `${environment.COOKIE_NAME}_onboarding_google_state`
    );
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/api/v1/auth/gmail");
    expect(stateCookie).not.toContain("Secure");

    const canceled = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?error=access_denied&state=${state}`,
      headers: { cookie: stateCookie.split(";")[0] }
    });
    expect(canceled.statusCode).toBe(302);
    expect(canceled.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?ownerOnboarding=error&mailProvider=GOOGLE`
    );
    expect(canceled.headers["set-cookie"]).toContain("Max-Age=0");
    await app.close();
  });

  it("creates a server session once and rejects mismatched or replayed callback state", async () => {
    const app = await createFixture();
    const mismatchedStart = await startGoogle(app);
    const mismatchedCookie = cookieNamed(
      mismatchedStart.headers["set-cookie"],
      `${environment.COOKIE_NAME}_onboarding_google_state`
    );
    const mismatched = await app.inject({
      method: "GET",
      url: "/api/v1/auth/gmail/callback?code=valid-google-code&state=invalid-state-value",
      headers: { cookie: mismatchedCookie.split(";")[0] }
    });
    expect(mismatched.statusCode).toBe(302);
    expect(mismatched.headers.location).toContain("ownerOnboarding=error");

    const started = await startGoogle(app);
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = cookieNamed(
      started.headers["set-cookie"],
      `${environment.COOKIE_NAME}_onboarding_google_state`
    );
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: stateCookie.split(";")[0] }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?ownerOnboarding=success&mailProvider=GOOGLE`
    );
    const sessionCookie = cookieNamed(
      callback.headers["set-cookie"],
      environment.COOKIE_NAME
    );
    expect(sessionCookie).toContain("HttpOnly");
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/owner-onboarding/current",
      headers: { cookie: sessionCookie.split(";")[0] }
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      onboarding: {
        status: "PENDING",
        choices: [
          {
            provider: "GOOGLE",
            status: "AUTHORIZED",
            email: "owner@example.com"
          }
        ]
      }
    });

    const replayed = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: stateCookie.split(";")[0] }
    });
    expect(replayed.statusCode).toBe(302);
    expect(replayed.headers.location).toContain("ownerOnboarding=error");
    await app.close();
  });
});

async function createFixture() {
  const authRepository = new MemoryAuthRepository();
  const authService = new AuthService({
    repository: authRepository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: environment.PUBLIC_ORIGIN,
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
    sessionIdleDays: environment.SESSION_IDLE_DAYS,
    sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
    maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
  });
  const providers = [
    new RouteMailProvider("GOOGLE", "owner@example.com"),
    new RouteMailProvider("MICROSOFT", "owner@company.example")
  ];
  const encryption = new LocalAesGcmTokenEncryptionProvider(
    environment.MAIL_TOKEN_ENCRYPTION_KEY,
    environment.MAIL_TOKEN_ENCRYPTION_KEY_VERSION
  );
  const teamService = new TeamService({
    repository: new MemoryTeamRepository(),
    teamCodeGenerator: () => "482731"
  });
  const ownerOnboardingService = new OwnerOnboardingService({
    repository: new MemoryOwnerOnboardingRepository(),
    authRepository,
    authService,
    teamService,
    providerAdapters: providers,
    tokenEncryption: encryption,
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
    onboardingTtlHours: 168
  });
  return buildApp({
    environment,
    authService,
    teamService,
    ownerOnboardingService,
    mailConnectionService: new MailConnectionService({
      repository: new MemoryMailConnectionRepository(),
      providerAdapters: providers,
      tokenEncryption: encryption,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 }
    }),
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      environment.AUTH_TOKEN_PEPPER
    ),
    logger: false
  });
}

async function startGoogle(app: Awaited<ReturnType<typeof createFixture>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/owner-onboarding/oauth/google/start",
    headers: {
      origin: environment.PUBLIC_ORIGIN,
      "content-type": "application/x-www-form-urlencoded"
    },
    payload: ""
  });
  expect(response.statusCode, response.body).toBe(303);
  return response;
}

class RouteMailProvider implements MailProviderAdapter {
  public privateNonce: string | null = null;

  public constructor(
    public readonly provider: MailProviderId,
    private readonly email: string
  ) {}

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    this.privateNonce = input.nonce;
    const url = new URL("https://identity.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant> {
    if (
      input.code !== `valid-${this.provider.toLowerCase()}-code` ||
      !input.codeVerifier ||
      input.expectedNonce !== this.privateNonce
    ) {
      throw new Error("invalid_route_oauth_fixture");
    }
    return {
      provider: this.provider,
      subject: `${this.provider.toLowerCase()}-route-subject`,
      email: this.email,
      emailVerified: true,
      refreshToken: `${this.provider.toLowerCase()}-route-refresh-token`,
      grantedScopes: ["openid", "email", "mail.read"]
    };
  }

  public async refreshAccessToken() {
    return {
      accessToken: "route-access-token",
      expiresAt: null,
      rotatedRefreshToken: null
    };
  }

  public async revokeAuthorization(): Promise<void> {}

  public classifyProviderError() {
    return "UNKNOWN" as const;
  }
}

function cookieNamed(
  header: string | string[] | undefined,
  name: string
): string {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`cookie_not_found:${name}`);
  return cookie;
}
