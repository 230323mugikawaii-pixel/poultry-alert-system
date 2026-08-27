import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryIdentityProfile
} from "../src/modules/auth/primary-auth-provider.js";
import { PrimaryAuthService } from "../src/modules/auth/primary-auth-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

const environment = loadEnvironment({
  APP_ENV: "test",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_primary_test_session",
  AUTH_TOKEN_PEPPER: "primary-route-pepper-at-least-thirty-two-characters",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/google/callback"
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("primary auth routes", () => {
  it("reports unavailable providers without simulating success", async () => {
    const fixture = await createFixture();

    const providers = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/providers"
    });
    const unavailable = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/apple/start"
    });

    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toEqual({
      providers: [
        { provider: "GOOGLE", status: "AVAILABLE" },
        { provider: "MICROSOFT", status: "NOT_CONFIGURED" },
        { provider: "APPLE", status: "NOT_CONFIGURED" }
      ]
    });
    expect(unavailable.statusCode).toBe(302);
    expect(unavailable.headers.location).toContain("primaryAuth=unavailable");
    expect(fixture.repository.sessions).toHaveLength(0);
  });

  it("completes Google login and issues the existing server session cookie", async () => {
    const fixture = await createFixture();
    const started = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start"
    });
    const state = new URL(String(started.headers.location)).searchParams.get(
      "state"
    );
    const callback = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=valid-primary-google-code&state=${state}`,
      headers: { cookie: firstCookie(started.headers["set-cookie"]) }
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("primaryAuth=success");
    const sessionCookie = cookieNamed(
      callback.headers["set-cookie"],
      environment.COOKIE_NAME
    );
    expect(sessionCookie).toContain(`${environment.COOKIE_NAME}=`);
    expect(String(callback.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(callback.headers["set-cookie"])).toContain("SameSite=Lax");

    const me = await fixture.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: sessionCookie }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: "route@example.com" } });
  });

  it("requires a session and same origin before linking", async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/identities/google/link/start",
      headers: { origin: environment.PUBLIC_ORIGIN }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" }
    });
  });
});

async function createFixture() {
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
  const primaryAuthService = new PrimaryAuthService({
    repository,
    authService,
    providerAdapters: [new RouteGoogleProvider()],
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10, APPLE: 10 }
  });
  const app = await buildApp({
    environment,
    logger: false,
    authService,
    primaryAuthService,
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      environment.AUTH_TOKEN_PEPPER
    )
  });
  apps.push(app);
  return { app, repository };
}

class RouteGoogleProvider implements PrimaryAuthProviderAdapter {
  public readonly provider = "GOOGLE" as const;
  private nonce = "";

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    this.nonce = input.nonce;
    const url = new URL("https://accounts.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<PrimaryIdentityProfile> {
    if (
      input.code !== "valid-primary-google-code" ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("invalid_route_google_fixture");
    }
    return {
      provider: "GOOGLE",
      subject: "route-google-subject",
      email: "route@example.com",
      emailVerified: true,
      displayName: "Route User"
    };
  }
}

function firstCookie(value: string | string[] | undefined): string {
  return (
    String(Array.isArray(value) ? value[0] : value)
      .split(";")[0]
      ?.trim() ?? ""
  );
}

function cookieNamed(
  value: string | string[] | undefined,
  name: string
): string {
  const cookies = Array.isArray(value) ? value : [String(value ?? "")];
  const selected = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return selected?.split(";")[0]?.trim() ?? "";
}
