import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { MailConnectionService } from "../src/modules/mail/mail-connection-service.js";
import type {
  MailOAuthGrant,
  MailProviderAdapter
} from "../src/modules/mail/mail-provider.js";
import {
  getMailProviderAvailability,
  getMailProviderStatuses
} from "../src/modules/mail/mail-provider-configuration.js";
import {
  GMAIL_READONLY_SCOPE,
  GoogleMailProvider
} from "../src/modules/mail/providers/google-mail-provider.js";
import {
  MICROSOFT_MAIL_READ_SCOPE,
  MicrosoftMailProvider,
  MicrosoftOidcIdTokenVerifier,
  type MicrosoftIdTokenVerifier
} from "../src/modules/mail/providers/microsoft-mail-provider.js";
import { LocalAesGcmTokenEncryptionProvider } from "../src/modules/mail/token-encryption.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemoryMailConnectionRepository } from "./helpers/memory-mail.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

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
  MICROSOFT_OAUTH_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_OAUTH_CLIENT_SECRET: "test-microsoft-client-secret",
  MICROSOFT_OAUTH_REDIRECT_URI:
    "http://127.0.0.1:8080/api/v1/auth/mail/microsoft/callback",
  MICROSOFT_OAUTH_TENANT: "common",
  MICROSOFT_OAUTH_STATE_TTL_MINUTES: 10,
  MAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
  MAIL_TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
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

const syntheticRefreshToken =
  "synthetic-refresh-token-for-tests-only-not-a-real-credential";

describe("mail provider configuration", () => {
  it("reports availability separately for Gmail and Microsoft", () => {
    expect(getMailProviderStatuses(environment)).toEqual({
      GOOGLE: "AVAILABLE",
      MICROSOFT: "AVAILABLE"
    });
    expect(
      getMailProviderAvailability(
        {
          ...environment,
          GMAIL_OAUTH_CLIENT_ID: "development-gmail-client-id"
        },
        "GOOGLE"
      )
    ).toBe("NOT_CONFIGURED");
    expect(
      getMailProviderAvailability(
        {
          ...environment,
          MICROSOFT_OAUTH_CLIENT_SECRET: "development-microsoft-client-secret"
        },
        "MICROSOFT"
      )
    ).toBe("NOT_CONFIGURED");
    expect(
      getMailProviderAvailability(
        {
          ...environment,
          MAIL_TOKEN_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        },
        "GOOGLE"
      )
    ).toBe("NOT_CONFIGURED");
  });
});

describe("Gmail token encryption", () => {
  it("round-trips with AES-256-GCM without retaining plaintext", async () => {
    const encryption = createEncryption();
    const encrypted = await encryption.encrypt(syntheticRefreshToken);

    expect(encrypted.ciphertext).not.toContain(syntheticRefreshToken);
    expect(encrypted.provider).toBe("LOCAL_AES_256_GCM");
    await expect(encryption.decrypt(encrypted)).resolves.toBe(
      syntheticRefreshToken
    );
  });

  it("rejects ciphertext under a different key version", async () => {
    const encrypted = await createEncryption().encrypt(syntheticRefreshToken);
    const otherVersion = new LocalAesGcmTokenEncryptionProvider(
      environment.MAIL_TOKEN_ENCRYPTION_KEY,
      "other-version"
    );
    await expect(otherVersion.decrypt(encrypted)).rejects.toThrow(
      "mail_encryption_key_unavailable"
    );
  });
});

describe("Google Gmail OAuth client", () => {
  it("requests offline Gmail read-only consent independently from login", () => {
    const client = new GoogleMailProvider({
      clientId: environment.GMAIL_OAUTH_CLIENT_ID,
      clientSecret: environment.GMAIL_OAUTH_CLIENT_SECRET,
      redirectUri: environment.GMAIL_OAUTH_REDIRECT_URI
    });
    const url = new URL(
      client.createAuthorizationUrl({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        nonce: "n".repeat(43)
      })
    );
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("n".repeat(43));
    expect(scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(scopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.modify"
    );
  });
});

describe("Microsoft mail OAuth provider", () => {
  it("uses common authority, PKCE, offline access, and delegated Mail.Read only", () => {
    const provider = createMicrosoftProvider();
    const url = new URL(
      provider.createAuthorizationUrl({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        nonce: "n".repeat(43)
      })
    );
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toContain("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(scopes).toEqual(
      expect.arrayContaining([
        "openid",
        "profile",
        "email",
        "offline_access",
        MICROSOFT_MAIL_READ_SCOPE
      ])
    );
    expect(scopes).not.toContain("Mail.ReadWrite");
  });

  it("exchanges a PKCE code and requires Mail.Read before returning a grant", async () => {
    const requests: string[] = [];
    const verifier: MicrosoftIdTokenVerifier = {
      verify: async (_idToken, nonce) => {
        expect(nonce).toBe("expected-nonce");
        return {
          subject: "microsoft-tenant:microsoft-subject",
          email: "monitoring@outlook.example"
        };
      }
    };
    const provider = createMicrosoftProvider({
      verifier,
      fetcher: async (_url, init) => {
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("expected_url_encoded_microsoft_token_request");
        }
        requests.push(init.body.toString());
        return Response.json({
          access_token: "synthetic-microsoft-access-token",
          refresh_token: "synthetic-microsoft-refresh-token",
          id_token: "synthetic-microsoft-id-token",
          scope: `openid offline_access ${MICROSOFT_MAIL_READ_SCOPE}`,
          expires_in: 3600
        });
      }
    });

    await expect(
      provider.exchangeCode({
        code: "synthetic-microsoft-code",
        codeVerifier: "synthetic-code-verifier",
        expectedNonce: "expected-nonce"
      })
    ).resolves.toMatchObject({
      provider: "MICROSOFT",
      subject: "microsoft-tenant:microsoft-subject",
      email: "monitoring@outlook.example"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("code_verifier=synthetic-code-verifier");
    expect(requests[0]).not.toContain("Mail.ReadWrite");

    const insufficient = createMicrosoftProvider({
      verifier,
      fetcher: async () =>
        Response.json({
          access_token: "synthetic-microsoft-access-token",
          refresh_token: "synthetic-microsoft-refresh-token",
          id_token: "synthetic-microsoft-id-token",
          scope: "openid offline_access"
        })
    });
    await expect(
      insufficient.exchangeCode({
        code: "synthetic-microsoft-code",
        codeVerifier: "synthetic-code-verifier",
        expectedNonce: "expected-nonce"
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("maps Microsoft consent, reauthentication, throttling, and transient failures", () => {
    const provider = createMicrosoftProvider();
    expect(provider.classifyProviderError({ code: "invalid_grant" })).toBe(
      "REAUTHORIZATION_REQUIRED"
    );
    expect(provider.classifyProviderError({ code: "consent_required" })).toBe(
      "CONSENT_REQUIRED"
    );
    expect(provider.classifyProviderError({ status: 429 })).toBe(
      "RATE_LIMITED"
    );
    expect(provider.classifyProviderError({ status: 503 })).toBe("TRANSIENT");
  });

  it("verifies Microsoft signature, audience, issuer, expiry, nonce, and tenant", async () => {
    const clientId = "microsoft-oidc-test-client";
    const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const keySet = createLocalJWKSet({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }]
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tid: tenantId,
      ver: "2.0",
      nonce: "expected-nonce",
      preferred_username: "person@example.com"
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("provider-subject")
      .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const verifier = new MicrosoftOidcIdTokenVerifier(
      clientId,
      "common",
      keySet
    );

    await expect(verifier.verify(token, "expected-nonce")).resolves.toEqual({
      subject: `${tenantId}:provider-subject`,
      email: "person@example.com"
    });
    await expect(verifier.verify(token, "wrong-nonce")).rejects.toThrow(
      "microsoft_mail_identity_claims_invalid"
    );
    await expect(
      new MicrosoftOidcIdTokenVerifier(
        "wrong-audience",
        "common",
        keySet
      ).verify(token, "expected-nonce")
    ).rejects.toThrow();
  });
});

describe("MailConnectionService", () => {
  it("consumes state once and stores only encrypted refresh-token material", async () => {
    const fixture = createServiceFixture();
    const started = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );
    expect(
      new URL(started.authorizationUrl).searchParams.get("access_type")
    ).toBe("offline");

    const connected = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: started.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    expect(connected).toMatchObject({
      teamId: "team-id",
      email: "monitoring@example.com",
      authorizationStatus: "ACTIVE",
      connectionStatus: "ACTIVE"
    });
    const stored = [...fixture.repository.authorizations.values()].find(
      (authorization) => authorization.userId === "owner-user-id"
    );
    expect(stored?.token?.ciphertext).not.toContain(syntheticRefreshToken);
    await expect(
      fixture.service.completeAuthorization({
        provider: "GOOGLE",
        state: started.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
  });

  it("rejects expired state and a provider that omits the refresh token", async () => {
    const expired = createServiceFixture();
    const started = await expired.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );
    expired.clock.value = new Date("2026-08-26T00:11:00.000Z");
    await expect(
      expired.service.completeAuthorization({
        provider: "GOOGLE",
        state: started.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });

    const missing = createServiceFixture({ failExchange: true });
    const missingStarted = await missing.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );
    await expect(
      missing.service.completeAuthorization({
        provider: "GOOGLE",
        state: missingStarted.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED",
      details: { reasonCode: "PROVIDER_RESPONSE_INVALID" }
    });
  });

  it("binds each one-time challenge to its selected provider", async () => {
    const fixture = createServiceFixture();
    const started = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );

    await expect(
      fixture.service.completeAuthorization({
        provider: "MICROSOFT",
        state: started.state,
        code: "valid-microsoft-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
    await expect(
      fixture.service.completeAuthorization({
        provider: "GOOGLE",
        state: started.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "MAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
  });

  it("rotates on reauthorization, disconnects locally first, and marks revoked grants", async () => {
    const fixture = createServiceFixture();
    const first = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );
    const connected = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: first.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    fixture.provider.refreshToken = `${syntheticRefreshToken}-rotated`;
    const reauth = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "REAUTHORIZE",
      "GOOGLE",
      connected.id
    );
    await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: reauth.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    expect(fixture.provider.revokedTokens).toContain(syntheticRefreshToken);

    await fixture.service.markProviderFailure({
      authorizationId: connected.authorizationId,
      provider: "GOOGLE",
      error: { code: "invalid_grant" }
    });
    expect(fixture.repository.connections.get(connected.id)).toMatchObject({
      authorizationStatus: "REAUTH_REQUIRED",
      connectionStatus: "REAUTH_REQUIRED",
      lastErrorCode: "REAUTHORIZATION_REQUIRED"
    });

    await fixture.service.disconnect({
      teamId: "team-id",
      ownerUserId: "owner-user-id",
      connectionId: connected.id
    });
    expect(fixture.repository.connections.get(connected.id)).toMatchObject({
      connectionStatus: "REVOKED"
    });
    expect(
      fixture.repository.authorizations.get(connected.authorizationId)?.token
    ).toBeNull();
    expect(fixture.provider.revokedTokens).toContain(
      `${syntheticRefreshToken}-rotated`
    );
  });

  it("does not revoke a refresh token that remains active after reauthorization", async () => {
    const fixture = createServiceFixture();
    const first = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT",
      "GOOGLE"
    );
    const connected = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: first.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    const reauthorization = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "REAUTHORIZE",
      "GOOGLE",
      connected.id
    );
    await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: reauthorization.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });

    expect(fixture.provider.revokedTokens).not.toContain(syntheticRefreshToken);
  });
});

describe("Gmail connection routes", () => {
  it("allows an owner to connect and disconnect while denying a member", async () => {
    const authRepository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository: authRepository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
      sessionIdleDays: environment.SESSION_IDLE_DAYS,
      sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
      maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
    });
    const owner = await login(authService, emailSender, "owner@example.com");
    const member = await login(authService, emailSender, "member@example.com");
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      teamCodeGenerator: () => "482731"
    });
    const { team } = await teamService.createTeam({
      ownerUserId: owner.userId,
      seatLimit: 0
    });
    teamRepository.addMember(member.userId);
    const gmailRepository = new MemoryMailConnectionRepository();
    const provider = new FakeMailProviderAdapter();
    const microsoftProvider = new FakeMailProviderAdapter(false, "MICROSOFT");
    const mailConnectionService = new MailConnectionService({
      repository: gmailRepository,
      providerAdapters: [provider, microsoftProvider],
      tokenEncryption: createEncryption(),
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      stateTtlMinutes: {
        GOOGLE: environment.GMAIL_OAUTH_STATE_TTL_MINUTES,
        MICROSOFT: environment.MICROSOFT_OAUTH_STATE_TTL_MINUTES
      }
    });
    const app = await buildApp({
      environment,
      authService,
      teamService,
      mailConnectionService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    const providerStatuses = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/mail-connection/providers`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    expect(providerStatuses.statusCode).toBe(200);
    expect(providerStatuses.json()).toEqual({
      providers: [
        { provider: "GOOGLE", status: "AVAILABLE" },
        { provider: "MICROSOFT", status: "AVAILABLE" }
      ]
    });
    const memberStart = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.teamId}/gmail-connection/oauth/start`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(member.sessionToken)
      }
    });
    expect(memberStart.statusCode).toBe(403);

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.teamId}/gmail-connection/oauth/start`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken),
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: ""
    });
    expect(started.statusCode, started.body).toBe(303);
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = cookieNamed(
      started.headers["set-cookie"],
      `${environment.COOKIE_NAME}_mail_google_state`
    );
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Path=/api/v1/auth/gmail");
    expect(stateCookie).not.toContain("Secure");
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?code=valid-gmail-code&state=${state}`,
      headers: {
        cookie: `${sessionCookie(owner.sessionToken)}; ${stateCookie.split(";")[0]}`
      }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?mailAuth=success&mailProvider=GOOGLE`
    );
    const replayedCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?code=valid-gmail-code&state=${state}`,
      headers: {
        cookie: `${sessionCookie(owner.sessionToken)}; ${stateCookie.split(";")[0]}`
      }
    });
    expect(replayedCallback.statusCode).toBe(302);
    expect(replayedCallback.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?mailAuth=error&mailProvider=GOOGLE`
    );

    const ownerView = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/gmail-connection`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.json()).toMatchObject({
      connection: {
        provider: "GOOGLE",
        email: "monitoring@example.com",
        connectionStatus: "ACTIVE"
      }
    });

    const microsoftStart = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.teamId}/mail-connection/oauth/start?provider=MICROSOFT`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(microsoftStart.statusCode, microsoftStart.body).toBe(303);
    const microsoftAuthorizationUrl = new URL(
      String(microsoftStart.headers.location)
    );
    const microsoftState =
      microsoftAuthorizationUrl.searchParams.get("state") ?? "";
    const microsoftStateCookie = cookieNamed(
      microsoftStart.headers["set-cookie"],
      `${environment.COOKIE_NAME}_mail_microsoft_state`
    );
    expect(microsoftStateCookie).toContain("HttpOnly");
    expect(microsoftStateCookie).toContain("SameSite=Lax");
    expect(microsoftStateCookie).toContain("Path=/api/v1/auth/mail/microsoft");
    const microsoftCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/mail/microsoft/callback?code=valid-microsoft-code&state=${microsoftState}`,
      headers: {
        cookie: `${sessionCookie(owner.sessionToken)}; ${microsoftStateCookie.split(";")[0]}`
      }
    });
    expect(microsoftCallback.statusCode).toBe(302);
    expect(microsoftCallback.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?mailAuth=success&mailProvider=MICROSOFT`
    );
    const connectionsView = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/mail-connections`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    const activeConnections = connectionsView.json<{
      connections: Array<{
        id: string;
        provider: string;
        email: string;
        connectionStatus: string;
      }>;
    }>().connections;
    expect(activeConnections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "GOOGLE",
          email: "monitoring@example.com",
          connectionStatus: "ACTIVE"
        }),
        expect.objectContaining({
          provider: "MICROSOFT",
          email: "monitoring@outlook.example",
          connectionStatus: "ACTIVE"
        })
      ])
    );
    expect(activeConnections).toHaveLength(2);
    expect(provider.revokedTokens).toHaveLength(0);

    const memberView = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/mail-connections`,
      headers: { cookie: sessionCookie(member.sessionToken) }
    });
    expect(memberView.statusCode).toBe(403);
    expect(memberView.body).not.toContain("monitoring@example.com");

    const googleConnection = activeConnections.find(
      ({ provider }) => provider === "GOOGLE"
    );
    expect(googleConnection).toBeDefined();
    expect(googleConnection?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    const disconnected = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${team.teamId}/mail-connections/${googleConnection?.id}`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(disconnected.statusCode, disconnected.body).toBe(204);
    expect(provider.revokedTokens).toContain(syntheticRefreshToken);
    expect(microsoftProvider.revokedTokens).toHaveLength(0);
    const remaining = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/mail-connections`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    expect(remaining.json()).toMatchObject({
      connections: [{ provider: "MICROSOFT", connectionStatus: "ACTIVE" }]
    });
    await app.close();
  });

  it("reports each provider separately and returns safely when OAuth cannot start", async () => {
    const unavailableEnvironment: AppEnvironment = {
      ...environment,
      MICROSOFT_OAUTH_CLIENT_SECRET: "development-microsoft-client-secret"
    };
    const authRepository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository: authRepository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: environment.MAGIC_LINK_TTL_MINUTES,
      sessionIdleDays: environment.SESSION_IDLE_DAYS,
      sessionAbsoluteDays: environment.SESSION_ABSOLUTE_DAYS,
      maxActiveSessions: environment.MAX_ACTIVE_SESSIONS
    });
    const owner = await login(authService, emailSender, "owner@example.com");
    const teamService = new TeamService({
      repository: new MemoryTeamRepository(),
      teamCodeGenerator: () => "482731"
    });
    const { team } = await teamService.createTeam({
      ownerUserId: owner.userId,
      seatLimit: 0
    });
    const mailConnectionService = new MailConnectionService({
      repository: new MemoryMailConnectionRepository(),
      providerAdapters: [
        new FakeMailProviderAdapter(),
        new FakeMailProviderAdapter(false, "MICROSOFT")
      ],
      tokenEncryption: createEncryption(),
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 }
    });
    const app = await buildApp({
      environment: unavailableEnvironment,
      authService,
      teamService,
      mailConnectionService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });

    const statuses = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/mail-connection/providers`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    expect(statuses.json()).toEqual({
      providers: [
        { provider: "GOOGLE", status: "AVAILABLE" },
        { provider: "MICROSOFT", status: "NOT_CONFIGURED" }
      ]
    });
    const unavailableStart = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.teamId}/mail-connection/oauth/start?provider=MICROSOFT`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(unavailableStart.statusCode).toBe(303);
    expect(unavailableStart.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?mailAuth=unavailable&mailProvider=MICROSOFT`
    );
    expect(unavailableStart.headers["set-cookie"]).toBeUndefined();
    await app.close();

    const failingRepository = new MemoryMailConnectionRepository();
    failingRepository.createOAuthChallenge = async () => {
      throw new Error("synthetic database failure");
    };
    const failingApp = await buildApp({
      environment,
      authService,
      teamService,
      mailConnectionService: new MailConnectionService({
        repository: failingRepository,
        providerAdapters: [
          new FakeMailProviderAdapter(),
          new FakeMailProviderAdapter(false, "MICROSOFT")
        ],
        tokenEncryption: createEncryption(),
        tokenPepper: environment.AUTH_TOKEN_PEPPER,
        stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 }
      }),
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    const failedStart = await failingApp.inject({
      method: "POST",
      url: `/api/v1/teams/${team.teamId}/mail-connection/oauth/start?provider=GOOGLE`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(failedStart.statusCode).toBe(303);
    expect(failedStart.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?mailAuth=error&mailProvider=GOOGLE`
    );
    expect(failedStart.body).not.toContain("INTERNAL_ERROR");
    await failingApp.close();
  });
});

function createServiceFixture(options: { failExchange?: boolean } = {}) {
  const repository = new MemoryMailConnectionRepository();
  const provider = new FakeMailProviderAdapter(options.failExchange);
  const clock = { value: new Date("2026-08-26T00:00:00.000Z") };
  const service = new MailConnectionService({
    repository,
    providerAdapters: [
      provider,
      new FakeMailProviderAdapter(false, "MICROSOFT")
    ],
    tokenEncryption: createEncryption(),
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
    now: () => clock.value
  });
  return { repository, provider, clock, service };
}

class FakeMailProviderAdapter implements MailProviderAdapter {
  public readonly provider;
  public refreshToken = syntheticRefreshToken;
  public readonly revokedTokens: string[] = [];
  private nonce: string | null = null;

  public constructor(
    private readonly failExchange = false,
    provider: "GOOGLE" | "MICROSOFT" = "GOOGLE"
  ) {
    this.provider = provider;
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    this.nonce = input.nonce;
    const url = new URL("https://accounts.example/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set(
      "scope",
      this.provider === "GOOGLE"
        ? GMAIL_READONLY_SCOPE
        : MICROSOFT_MAIL_READ_SCOPE
    );
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant> {
    if (
      this.failExchange ||
      input.code !==
        (this.provider === "GOOGLE"
          ? "valid-gmail-code"
          : "valid-microsoft-code") ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("invalid synthetic Gmail grant");
    }
    return {
      provider: this.provider,
      subject:
        this.provider === "GOOGLE"
          ? "gmail-monitoring-subject"
          : "microsoft-tenant:microsoft-monitoring-subject",
      email:
        this.provider === "GOOGLE"
          ? "monitoring@example.com"
          : "monitoring@outlook.example",
      emailVerified: true,
      refreshToken: this.refreshToken,
      grantedScopes: [
        "openid",
        "email",
        this.provider === "GOOGLE"
          ? GMAIL_READONLY_SCOPE
          : MICROSOFT_MAIL_READ_SCOPE
      ]
    };
  }

  public async refreshAccessToken() {
    return {
      accessToken: "synthetic-access-token-for-tests-only",
      expiresAt: null,
      rotatedRefreshToken: null
    };
  }

  public async revokeAuthorization(refreshToken: string): Promise<void> {
    this.revokedTokens.push(refreshToken);
  }

  public classifyProviderError(error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return code === "invalid_grant"
      ? ("REAUTHORIZATION_REQUIRED" as const)
      : ("UNKNOWN" as const);
  }
}

function createEncryption(): LocalAesGcmTokenEncryptionProvider {
  return new LocalAesGcmTokenEncryptionProvider(
    environment.MAIL_TOKEN_ENCRYPTION_KEY,
    environment.MAIL_TOKEN_ENCRYPTION_KEY_VERSION
  );
}

function createMicrosoftProvider(
  options: {
    readonly fetcher?: typeof fetch;
    readonly verifier?: MicrosoftIdTokenVerifier;
  } = {}
): MicrosoftMailProvider {
  return new MicrosoftMailProvider({
    clientId: environment.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: environment.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: environment.MICROSOFT_OAUTH_REDIRECT_URI,
    tenant: environment.MICROSOFT_OAUTH_TENANT,
    fetcher:
      options.fetcher ??
      (async () => {
        throw new Error("unexpected_microsoft_network_request");
      }),
    idTokenVerifier: options.verifier ?? {
      verify: async () => ({
        subject: "microsoft-tenant:microsoft-subject",
        email: "monitoring@outlook.example"
      })
    }
  });
}

async function login(
  authService: AuthService,
  emailSender: MemoryMagicLinkEmailSender,
  email: string
): Promise<{ readonly userId: string; readonly sessionToken: string }> {
  await authService.requestMagicLink(email);
  const token = new URL(
    emailSender.messages.at(-1)?.magicLink ?? ""
  ).searchParams.get("token");
  const result = await authService.consumeMagicLink(token ?? "", {});
  return { userId: result.user.id, sessionToken: result.sessionToken };
}

function sessionCookie(token: string): string {
  return `${environment.COOKIE_NAME}=${token}`;
}

function cookieNamed(
  value: string | string[] | undefined,
  name: string
): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const cookie = values.find((candidate) => candidate.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Expected ${name} cookie`);
  }
  return cookie;
}
