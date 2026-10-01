import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { PrimaryAuthService } from "../src/modules/auth/primary-auth-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

const env = loadEnvironment({
  APP_ENV: "test",
  PUBLIC_ORIGIN: "https://frontend.example",
  COOKIE_NAME: "native_link_test",
  AUTH_TOKEN_PEPPER: "synthetic-native-link-pepper-at-least-32-characters",
  GOOGLE_OAUTH_CLIENT_ID: "fake-google",
  GOOGLE_OAUTH_CLIENT_SECRET: "fake-only",
  GOOGLE_OAUTH_REDIRECT_URI: "https://api.example/api/v1/auth/google/callback",
  MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "fake-microsoft",
  MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET: "fake-only",
  MICROSOFT_LOGIN_OAUTH_REDIRECT_URI:
    "https://api.example/api/v1/auth/microsoft/callback",
  MICROSOFT_LOGIN_OAUTH_TENANT: "common"
});
const verifier = "a".repeat(43);
const pkce = {
  codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
  codeChallengeMethod: "S256"
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(provider: "GOOGLE" | "MICROSOFT" = "MICROSOFT") {
  let now = new Date();
  let exchanges = 0;
  const repository = new MemoryAuthRepository();
  const auth = new AuthService({
    repository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: env.PUBLIC_ORIGIN,
    tokenPepper: env.AUTH_TOKEN_PEPPER,
    magicLinkTtlMinutes: 15,
    sessionIdleDays: 30,
    sessionAbsoluteDays: 90,
    maxActiveSessions: 10
  });
  const user = {
    id: randomUUID(),
    email: "native-owner@example.com",
    displayName: "Synthetic Owner",
    status: "ACTIVE" as const
  };
  repository.users.set(user.email, user);
  const session = await auth.createSessionForVerifiedUser(user, {});
  const sessionCookie = `${env.COOKIE_NAME}=${session.sessionToken}`;
  const service = new PrimaryAuthService({
    repository,
    authService: auth,
    tokenPepper: env.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10, APPLE: 10 },
    now: () => now,
    providerAdapters: [
      {
        provider,
        createAuthorizationUrl: ({ state }) =>
          `https://provider.example/authorize?state=${state}`,
        exchangeCode: async () => {
          exchanges++;
          return {
            provider,
            subject: "synthetic-provider-subject",
            email: user.email,
            displayName: user.displayName,
            emailVerified: true
          };
        }
      }
    ]
  });
  const app = await buildApp({
    environment: env,
    logger: false,
    authService: auth,
    primaryAuthService: service,
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      env.AUTH_TOKEN_PEPPER
    )
  });
  apps.push(app);
  const prefix = `/api/v1/auth/identities/${provider.toLowerCase()}/link`;
  const headers = { origin: env.PUBLIC_ORIGIN, cookie: sessionCookie };
  const start = () =>
    app.inject({
      method: "POST",
      url: `${prefix}/start?client=native`,
      headers,
      payload: pkce
    });
  const bootstrap = async () => {
    const started = await start();
    expect(started.statusCode).toBe(200);
    expect(started.headers["set-cookie"]).toBeUndefined();
    const url = new URL(
      started.json<{ authorizationUrl: string }>().authorizationUrl
    );
    expect(url.origin).toBe("https://api.example");
    const opened = await app.inject({
      method: "GET",
      url: url.pathname + url.search
    }); // NO app session in browser
    expect(opened.statusCode).toBe(302);
    const state = new URL(String(opened.headers.location)).searchParams.get(
      "state"
    )!;
    return {
      handoffUrl: url.pathname + url.search,
      state,
      browserCookies: cookies(opened.headers["set-cookie"])
    };
  };
  const callback = (state: string, cookie: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/auth/${provider.toLowerCase()}/callback?state=${state}&code=synthetic-valid-code`,
      headers: { cookie }
    });
  const pending = async () => {
    const browser = await bootstrap();
    const response = await callback(browser.state, browser.browserCookies);
    const url = new URL(String(response.headers.location));
    expect(url.protocol).toBe("com.callnow.app:");
    expect(url.searchParams.get("result")).toBe("link_pending");
    expect(repository.primaryIdentities).toHaveLength(0); // Browser proof NEVER links.
    return { ...browser, code: url.searchParams.get("code")! };
  };
  const finalize = (
    code: string,
    options: { verifier?: string; cookie?: string; origin?: string } = {}
  ) =>
    app.inject({
      method: "POST",
      url: `${prefix}/finalize`,
      headers: {
        origin: options.origin ?? env.PUBLIC_ORIGIN,
        cookie: options.cookie ?? sessionCookie
      },
      payload: { code, codeVerifier: options.verifier ?? verifier }
    });
  return {
    app,
    repository,
    auth,
    user,
    session,
    service,
    prefix,
    headers,
    start,
    bootstrap,
    callback,
    pending,
    finalize,
    exchanges: () => exchanges,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    }
  };
}
function cookies(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw : [raw ?? ""])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe("native identity link: separate app/browser cookie stores", () => {
  it.each(["GOOGLE", "MICROSOFT"] as const)(
    "links %s only after authenticated S256 finalization, no new login session",
    async (provider) => {
      const f = await fixture(provider);
      const pending = await f.pending();
      const result = await f.finalize(pending.code);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        identity: { provider, email: f.user.email }
      });
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(f.repository.sessions).toHaveLength(1);
      expect(f.repository.primaryIdentities).toHaveLength(1);
      expect(f.exchanges()).toBe(1);
      const identities = await f.app.inject({
        method: "GET",
        url: "/api/v1/auth/identities",
        headers: f.headers
      });
      expect(
        identities.json<{ identities: unknown[] }>().identities
      ).toHaveLength(1);
    }
  );

  it("consumes handoff, callback and finalize at most once", async () => {
    const f = await fixture();
    const p = await f.pending();
    const replay = await f.app.inject({ method: "GET", url: p.handoffUrl });
    expect(replay.headers.location).toContain("result=error");
    expect(
      (await f.callback(p.state, p.browserCookies)).headers.location
    ).toContain("result=error");
    const results = await Promise.all([f.finalize(p.code), f.finalize(p.code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(f.repository.primaryIdentities).toHaveLength(1);
    expect(f.exchanges()).toBe(1);
  });

  it("requires browser state cookie, not just a state query or app cookie", async () => {
    const f = await fixture();
    const b = await f.bootstrap();
    expect(
      (await f.callback(b.state, f.headers.cookie)).headers.location
    ).toContain("=error");
    expect(
      (await f.callback("z".repeat(43), b.browserCookies)).headers.location
    ).toContain("result=error");
    expect(f.exchanges()).toBe(0);
    expect(f.repository.primaryIdentities).toHaveLength(0);
  });

  it("cannot downgrade native LINK to web LINK by removing/changing its marker", async () => {
    const f = await fixture();
    const b = await f.bootstrap();
    const tampered =
      b.browserCookies.replace("_oauth_native=link", "_oauth_native=1") +
      "; " +
      f.headers.cookie;
    expect((await f.callback(b.state, tampered)).headers.location).toContain(
      "result=error"
    );
    expect(f.exchanges()).toBe(0);
    expect(f.repository.primaryIdentities).toHaveLength(0);
  });

  it("rejects wrong verifier without consuming the rightful app's completion", async () => {
    const f = await fixture();
    const p = await f.pending();
    expect(
      (await f.finalize(p.code, { verifier: "b".repeat(43) })).statusCode
    ).toBe(401);
    expect((await f.finalize(p.code)).statusCode).toBe(200);
  });

  it("requires the initiating session even for the same user; rejects other users and revoked sessions", async () => {
    const f = await fixture();
    const p = await f.pending();
    const replacement = await f.auth.createSessionForVerifiedUser(f.user, {});
    expect(
      (
        await f.finalize(p.code, {
          cookie: `${env.COOKIE_NAME}=${replacement.sessionToken}`
        })
      ).statusCode
    ).toBe(401);
    const other = { ...f.user, id: randomUUID(), email: "other@example.com" };
    f.repository.users.set(other.email, other);
    const otherSession = await f.auth.createSessionForVerifiedUser(other, {});
    expect(
      (
        await f.finalize(p.code, {
          cookie: `${env.COOKIE_NAME}=${otherSession.sessionToken}`
        })
      ).statusCode
    ).toBe(401);
    await f.auth.revokeSession(f.user.id, f.session.session.id);
    expect((await f.finalize(p.code)).statusCode).toBe(401);
    expect(f.repository.primaryIdentities).toHaveLength(0);
  });

  it("requires authentication, SameOrigin and S256 at start/finalize", async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${f.prefix}/start?client=native`,
          headers: { origin: env.PUBLIC_ORIGIN },
          payload: pkce
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${f.prefix}/start?client=native`,
          headers: { ...f.headers, origin: "https://wrong.example" },
          payload: pkce
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${f.prefix}/start?client=native`,
          headers: f.headers,
          payload: { ...pkce, codeChallengeMethod: "plain" }
        })
      ).statusCode
    ).toBe(400);
    const p = await f.pending();
    expect((await f.finalize(p.code, { cookie: "" })).statusCode).toBe(401);
    expect(
      (await f.finalize(p.code, { origin: "https://wrong.example" })).statusCode
    ).toBe(403);
    expect(f.repository.primaryIdentities).toHaveLength(0);
  });

  it("does not accept another provider's handoff or finalization code", async () => {
    const f = await fixture();
    const p = await f.pending();
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: p.handoffUrl.replace("/microsoft/", "/google/")
        })
      ).headers.location
    ).toContain("result=error");
    const result = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/identities/google/link/finalize",
      headers: f.headers,
      payload: { code: p.code, codeVerifier: verifier }
    });
    expect(result.statusCode).toBe(401);
    expect((await f.finalize(p.code)).statusCode).toBe(200);
  });

  it.each(["HANDOFF", "CALLBACK", "FINALIZE"])(
    "expires the %s stage",
    async (stage) => {
      const f = await fixture();
      if (stage === "HANDOFF") {
        const start = await f.start();
        const url = new URL(
          start.json<{ authorizationUrl: string }>().authorizationUrl
        );
        f.advance(120_001);
        expect(
          (
            await f.app.inject({
              method: "GET",
              url: url.pathname + url.search
            })
          ).headers.location
        ).toContain("result=error");
      } else if (stage === "CALLBACK") {
        const b = await f.bootstrap();
        f.advance(600_001);
        expect(
          (await f.callback(b.state, b.browserCookies)).headers.location
        ).toContain("result=error");
      } else {
        const p = await f.pending();
        f.advance(120_001);
        expect((await f.finalize(p.code)).statusCode).toBe(401);
      }
      expect(f.repository.primaryIdentities).toHaveLength(0);
    }
  );

  it.each(["LOGIN_IDENTITY_ALREADY_IN_USE", "LOGIN_PROVIDER_ALREADY_LINKED"])(
    "preserves %s protection at finalization",
    async (code) => {
      const f = await fixture();
      const p = await f.pending();
      f.repository.primaryIdentities.push({
        userId:
          code === "LOGIN_IDENTITY_ALREADY_IN_USE" ? randomUUID() : f.user.id,
        provider: "MICROSOFT",
        providerSubject:
          code === "LOGIN_IDENTITY_ALREADY_IN_USE"
            ? "synthetic-provider-subject"
            : "different-subject",
        email: "existing@example.com",
        linkedAt: new Date(),
        lastUsedAt: null,
        revokedAt: null
      });
      const response = await f.finalize(p.code);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        code
      );
      expect(f.repository.primaryIdentities).toHaveLength(1);
    }
  );

  it("preserves web LINK's redirect and same-cookie-store flow", async () => {
    const f = await fixture();
    const start = await f.app.inject({
      method: "POST",
      url: `${f.prefix}/start`,
      headers: f.headers
    });
    expect(start.statusCode).toBe(303);
    const state = new URL(String(start.headers.location)).searchParams.get(
      "state"
    )!;
    const result = await f.callback(
      state,
      cookies(start.headers["set-cookie"]) + "; " + f.headers.cookie
    );
    expect(result.headers.location).toContain("identityLink=success");
    expect(f.repository.primaryIdentities).toHaveLength(1);
  });

  it("preserves native LOGIN and its separate session exchange", async () => {
    const f = await fixture();
    const start = await f.app.inject({
      method: "GET",
      url: "/api/v1/auth/microsoft/start?client=native"
    });
    // Existing user without a linked identity must not be merged merely by email.
    f.repository.users.clear();
    const state = new URL(String(start.headers.location)).searchParams.get(
      "state"
    )!;
    const result = await f.callback(
      state,
      cookies(start.headers["set-cookie"])
    );
    const url = new URL(String(result.headers.location));
    expect(url.searchParams.get("result")).toBe("success");
    const exchange = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/exchange",
      headers: { origin: env.PUBLIC_ORIGIN },
      payload: { code: url.searchParams.get("code") }
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers["set-cookie"]).toBeDefined();
  });
});
