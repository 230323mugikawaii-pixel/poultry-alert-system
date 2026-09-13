import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { GoogleAuthService } from "../src/modules/auth/google-auth-service.js";
import type {
  GoogleIdentityProfile,
  GoogleOAuthProvider
} from "../src/modules/auth/google-oauth-client.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

const environment: AppEnvironment = {
  APP_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  TRUST_PROXY_HOPS: 0,
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_test_session",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  AUTH_TOKEN_PEPPER: "test-token-pepper-at-least-thirty-two-characters",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/google/callback",
  GOOGLE_OAUTH_STATE_TTL_MINUTES: 10,
  MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "",
  MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET: "",
  MICROSOFT_LOGIN_OAUTH_REDIRECT_URI: "",
  MICROSOFT_LOGIN_OAUTH_TENANT: "common",
  MICROSOFT_LOGIN_OAUTH_STATE_TTL_MINUTES: 10,
  APPLE_OAUTH_CLIENT_ID: "",
  APPLE_OAUTH_TEAM_ID: "",
  APPLE_OAUTH_KEY_ID: "",
  APPLE_OAUTH_PRIVATE_KEY: "",
  APPLE_OAUTH_REDIRECT_URI: "",
  APPLE_OAUTH_STATE_TTL_MINUTES: 10,
  GMAIL_OAUTH_CLIENT_ID: "test-gmail-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
  GMAIL_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/gmail/callback",
  GMAIL_OAUTH_STATE_TTL_MINUTES: 10,
  GMAIL_PUSH_MONITORING_ENABLED: false,
  GMAIL_PUBSUB_TOPIC_NAME: "",
  GMAIL_PUBSUB_PUSH_AUDIENCE: "",
  GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: "",
  GMAIL_WATCH_RENEW_BEFORE_HOURS: 48,
  GMAIL_HISTORY_RECOVERY_LOOKBACK_HOURS: 72,
  GMAIL_PUBSUB_MAX_BODY_BYTES: 262144,
  MICROSOFT_OAUTH_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_OAUTH_CLIENT_SECRET: "test-microsoft-client-secret",
  MICROSOFT_OAUTH_REDIRECT_URI:
    "http://127.0.0.1:8080/api/v1/auth/mail/microsoft/callback",
  MICROSOFT_OAUTH_TENANT: "common",
  MICROSOFT_OAUTH_STATE_TTL_MINUTES: 10,
  MAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
  MAIL_TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  MAIL_TOKEN_ENCRYPTION_KEY_VERSION: "test-local-v1",
  MAIL_KMS_KEY_NAME: "",
  MAGIC_LINK_TTL_MINUTES: 15,
  SESSION_IDLE_DAYS: 30,
  SESSION_ABSOLUTE_DAYS: 90,
  MAX_ACTIVE_SESSIONS: 5,
  INVITATION_TTL_DAYS: 30,
  JOIN_GRANT_TTL_MINUTES: 15,
  LINE_LINK_TTL_HOURS: 24,
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: 1025,
  SMTP_SECURE: false,
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  EMAIL_FROM: "Call Now <test@example.com>"
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("Google authentication routes", () => {
  it("creates a Phase 1 session in an HttpOnly cookie", async () => {
    const fixture = await createFixture();
    const started = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start"
    });

    expect(started.statusCode).toBe(302);
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("nonce")).toBeTruthy();
    const stateCookie = firstCookie(started.headers["set-cookie"]);

    const completed = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: stateCookie }
    });

    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe(
      "https://test.call-now.example/?googleAuth=success"
    );
    const sessionCookie = cookieNamed(
      completed.headers["set-cookie"],
      environment.COOKIE_NAME
    );
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");

    const me = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: sessionCookie.split(";")[0] }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: {
        email: "google-user@example.com",
        displayName: "Google User"
      }
    });
  });

  it("rejects a mismatched or reused OAuth state without a session", async () => {
    const fixture = await createFixture();
    const started = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start"
    });
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = firstCookie(started.headers["set-cookie"]);

    const mismatch = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-google-code&state=${"x".repeat(43)}`,
      headers: { cookie: stateCookie }
    });
    expect(mismatch.headers.location).toBe(
      "https://test.call-now.example/?googleAuth=error"
    );
    expect(
      cookieNamedOrNull(mismatch.headers["set-cookie"], environment.COOKIE_NAME)
    ).toBeNull();

    const first = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: stateCookie }
    });
    expect(first.headers.location).toContain("googleAuth=success");

    const reused = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: stateCookie }
    });
    expect(reused.headers.location).toContain("googleAuth=error");
    expect(
      cookieNamedOrNull(reused.headers["set-cookie"], environment.COOKIE_NAME)
    ).toBeNull();
  });

  it("rejects a Google identity whose email is not verified", async () => {
    const fixture = await createFixture({
      emailVerified: false
    });
    const started = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start"
    });
    const state = new URL(String(started.headers.location)).searchParams.get(
      "state"
    );
    const completed = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-google-code&state=${state}`,
      headers: { cookie: firstCookie(started.headers["set-cookie"]) }
    });

    expect(completed.headers.location).toContain("googleAuth=error");
    expect(fixture.repository.sessions).toHaveLength(0);
  });
});

async function createFixture(
  profileOverrides: Partial<GoogleIdentityProfile> = {}
): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  repository: MemoryAuthRepository;
}> {
  const repository = new MemoryAuthRepository();
  const authService = new AuthService({
    repository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: environment.PUBLIC_ORIGIN,
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
    sessionIdleDays: environment.SESSION_IDLE_DAYS,
    sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
    maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
  });
  const provider = new FakeGoogleOAuthProvider({
    subject: "google-subject-123",
    email: "google-user@example.com",
    emailVerified: true,
    displayName: "Google User",
    ...profileOverrides
  });
  const googleAuthService = new GoogleAuthService({
    repository,
    authService,
    oauthProvider: provider,
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: environment.GOOGLE_OAUTH_STATE_TTL_MINUTES
  });
  const app = await buildApp({
    environment,
    authService,
    googleAuthService,
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      environment.AUTH_TOKEN_PEPPER
    ),
    logger: false
  });
  apps.push(app);
  return { app, repository };
}

class FakeGoogleOAuthProvider implements GoogleOAuthProvider {
  private nonce: string | null = null;

  public constructor(private readonly profile: GoogleIdentityProfile) {}

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    const url = new URL("https://accounts.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    this.nonce = input.nonce;
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<GoogleIdentityProfile> {
    if (
      input.code !== "valid-google-code" ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("invalid test authorization code");
    }
    return this.profile;
  }
}

function firstCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;
  if (!cookie) {
    throw new Error("Expected a Set-Cookie header");
  }
  return cookie.split(";")[0] ?? cookie;
}

function cookieNamed(
  value: string | string[] | undefined,
  name: string
): string {
  const cookie = cookieNamedOrNull(value, name);
  if (!cookie) {
    throw new Error(`Expected ${name} cookie`);
  }
  return cookie;
}

function cookieNamedOrNull(
  value: string | string[] | undefined,
  name: string
): string | null {
  const cookies = Array.isArray(value) ? value : value ? [value] : [];
  return cookies.find((cookie) => cookie.startsWith(`${name}=`)) ?? null;
}
