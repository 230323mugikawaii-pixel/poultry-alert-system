import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { GmailConnectionService } from "../src/modules/gmail/gmail-connection-service.js";
import type {
  GmailOAuthGrant,
  GmailOAuthProvider
} from "../src/modules/gmail/gmail-oauth-client.js";
import {
  GMAIL_READONLY_SCOPE,
  GoogleGmailOAuthClient
} from "../src/modules/gmail/gmail-oauth-client.js";
import { LocalAesGcmTokenEncryptionProvider } from "../src/modules/gmail/token-encryption.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemoryGmailConnectionRepository } from "./helpers/memory-gmail.js";
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
  GMAIL_OAUTH_CLIENT_ID: "test-gmail-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "test-gmail-client-secret",
  GMAIL_OAUTH_REDIRECT_URI:
    "https://api.test.call-now.example/api/v1/auth/gmail/callback",
  GMAIL_OAUTH_STATE_TTL_MINUTES: 10,
  GMAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
  GMAIL_TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GMAIL_TOKEN_ENCRYPTION_KEY_VERSION: "test-local-v1",
  GMAIL_KMS_KEY_NAME: "",
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
      environment.GMAIL_TOKEN_ENCRYPTION_KEY,
      "other-version"
    );
    await expect(otherVersion.decrypt(encrypted)).rejects.toThrow(
      "gmail_encryption_key_unavailable"
    );
  });
});

describe("Google Gmail OAuth client", () => {
  it("requests offline Gmail read-only consent independently from login", () => {
    const client = new GoogleGmailOAuthClient({
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

describe("GmailConnectionService", () => {
  it("consumes state once and stores only encrypted refresh-token material", async () => {
    const fixture = createServiceFixture();
    const started = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT"
    );
    expect(
      new URL(started.authorizationUrl).searchParams.get("access_type")
    ).toBe("offline");

    const connected = await fixture.service.completeAuthorization({
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
    const stored = fixture.repository.authorizations.get("owner-user-id");
    expect(stored?.token?.ciphertext).not.toContain(syntheticRefreshToken);
    await expect(
      fixture.service.completeAuthorization({
        state: started.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "GMAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
  });

  it("rejects expired state and a provider that omits the refresh token", async () => {
    const expired = createServiceFixture();
    const started = await expired.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT"
    );
    expired.clock.value = new Date("2026-08-26T00:11:00.000Z");
    await expect(
      expired.service.completeAuthorization({
        state: started.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "GMAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });

    const missing = createServiceFixture({ failExchange: true });
    const missingStarted = await missing.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT"
    );
    await expect(
      missing.service.completeAuthorization({
        state: missingStarted.state,
        code: "valid-gmail-code",
        authenticatedUserId: "owner-user-id"
      })
    ).rejects.toMatchObject({
      code: "GMAIL_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
  });

  it("rotates on reauthorization, disconnects locally first, and marks revoked grants", async () => {
    const fixture = createServiceFixture();
    const first = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "CONNECT"
    );
    const connected = await fixture.service.completeAuthorization({
      state: first.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    fixture.provider.refreshToken = `${syntheticRefreshToken}-rotated`;
    const reauth = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "REAUTHORIZE"
    );
    await fixture.service.completeAuthorization({
      state: reauth.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    expect(fixture.provider.revokedTokens).toContain(syntheticRefreshToken);

    await fixture.service.markCredentialFailure(
      connected.authorizationId,
      "invalid_grant"
    );
    expect(fixture.repository.connections.get("team-id")).toMatchObject({
      authorizationStatus: "REAUTH_REQUIRED",
      connectionStatus: "REAUTH_REQUIRED",
      lastErrorCode: "INVALID_GRANT"
    });

    await fixture.service.disconnect({
      teamId: "team-id",
      ownerUserId: "owner-user-id"
    });
    expect(fixture.repository.connections.get("team-id")).toMatchObject({
      connectionStatus: "REVOKED"
    });
    expect(
      fixture.repository.authorizations.get("owner-user-id")?.token
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
      "CONNECT"
    );
    await fixture.service.completeAuthorization({
      state: first.state,
      code: "valid-gmail-code",
      authenticatedUserId: "owner-user-id"
    });
    const reauthorization = await fixture.service.createAuthorizationRequest(
      "owner-user-id",
      "team-id",
      "REAUTHORIZE"
    );
    await fixture.service.completeAuthorization({
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
    const gmailRepository = new MemoryGmailConnectionRepository();
    const provider = new FakeGmailOAuthProvider();
    const gmailConnectionService = new GmailConnectionService({
      repository: gmailRepository,
      oauthProvider: provider,
      tokenEncryption: createEncryption(),
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      stateTtlMinutes: environment.GMAIL_OAUTH_STATE_TTL_MINUTES
    });
    const app = await buildApp({
      environment,
      authService,
      teamService,
      gmailConnectionService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
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
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(started.statusCode, started.body).toBe(303);
    const authorizationUrl = new URL(String(started.headers.location));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = cookieNamed(
      started.headers["set-cookie"],
      `${environment.COOKIE_NAME}_gmail_oauth_state`
    );
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/gmail/callback?code=valid-gmail-code&state=${state}`,
      headers: {
        cookie: `${sessionCookie(owner.sessionToken)}; ${stateCookie.split(";")[0]}`
      }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      `${environment.PUBLIC_ORIGIN}/?gmailAuth=success`
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
      `${environment.PUBLIC_ORIGIN}/?gmailAuth=error`
    );

    const ownerView = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/gmail-connection`,
      headers: { cookie: sessionCookie(owner.sessionToken) }
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.json()).toMatchObject({
      connection: {
        email: "monitoring@example.com",
        connectionStatus: "ACTIVE"
      }
    });

    const memberView = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.teamId}/gmail-connection`,
      headers: { cookie: sessionCookie(member.sessionToken) }
    });
    expect(memberView.statusCode).toBe(403);
    expect(memberView.body).not.toContain("monitoring@example.com");

    const disconnected = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${team.teamId}/gmail-connection`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: sessionCookie(owner.sessionToken)
      }
    });
    expect(disconnected.statusCode).toBe(204);
    expect(provider.revokedTokens).toContain(syntheticRefreshToken);
    await app.close();
  });
});

function createServiceFixture(options: { failExchange?: boolean } = {}) {
  const repository = new MemoryGmailConnectionRepository();
  const provider = new FakeGmailOAuthProvider(options.failExchange);
  const clock = { value: new Date("2026-08-26T00:00:00.000Z") };
  const service = new GmailConnectionService({
    repository,
    oauthProvider: provider,
    tokenEncryption: createEncryption(),
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: 10,
    now: () => clock.value
  });
  return { repository, provider, clock, service };
}

class FakeGmailOAuthProvider implements GmailOAuthProvider {
  public refreshToken = syntheticRefreshToken;
  public readonly revokedTokens: string[] = [];
  private nonce: string | null = null;

  public constructor(private readonly failExchange = false) {}

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
    url.searchParams.set("scope", GMAIL_READONLY_SCOPE);
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<GmailOAuthGrant> {
    if (
      this.failExchange ||
      input.code !== "valid-gmail-code" ||
      !input.codeVerifier ||
      input.expectedNonce !== this.nonce
    ) {
      throw new Error("invalid synthetic Gmail grant");
    }
    return {
      subject: "gmail-monitoring-subject",
      email: "monitoring@example.com",
      emailVerified: true,
      refreshToken: this.refreshToken,
      grantedScopes: ["openid", "email", GMAIL_READONLY_SCOPE]
    };
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    this.revokedTokens.push(refreshToken);
  }
}

function createEncryption(): LocalAesGcmTokenEncryptionProvider {
  return new LocalAesGcmTokenEncryptionProvider(
    environment.GMAIL_TOKEN_ENCRYPTION_KEY,
    environment.GMAIL_TOKEN_ENCRYPTION_KEY_VERSION
  );
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
