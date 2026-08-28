import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/app-error.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import type {
  MailOAuthGrant,
  MailProviderAdapter,
  MailProviderId
} from "../src/modules/mail/mail-provider.js";
import type {
  StoredEncryptedToken,
  TokenEncryptionProvider
} from "../src/modules/mail/token-encryption.js";
import { OwnerOnboardingService } from "../src/modules/onboarding/owner-onboarding-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemoryOwnerOnboardingRepository } from "./helpers/memory-owner-onboarding.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const now = new Date("2026-08-29T00:00:00.000Z");

describe("owner monitoring onboarding", () => {
  it("establishes identity, session, and pending mail authorization in one OAuth ceremony", async () => {
    const fixture = createFixture();
    const request = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: null
    });
    const result = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: request.state,
      code: "valid-google-code",
      authenticatedUserId: null,
      clientContext: { ipAddress: "127.0.0.1" }
    });

    expect(result.login?.user.email).toBe("owner@example.com");
    expect(result.login?.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,100}$/u);
    expect(result.onboarding?.status).toBe("PENDING");
    expect(result.onboarding?.choices).toEqual([
      expect.objectContaining({
        provider: "GOOGLE",
        status: "AUTHORIZED",
        email: "owner@example.com"
      })
    ]);
    expect(fixture.teamRepository.context).toBeNull();
    expect(fixture.repository.authorizations[0]?.token?.ciphertext).not.toBe(
      "refresh-GOOGLE"
    );
  });

  it("consumes OAuth state once and does not accept callback replay", async () => {
    const fixture = createFixture();
    const request = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: null
    });
    await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: request.state,
      code: "valid-google-code",
      authenticatedUserId: null,
      clientContext: {}
    });
    await expect(
      fixture.service.completeAuthorization({
        provider: "GOOGLE",
        state: request.state,
        code: "valid-google-code",
        authenticatedUserId: null,
        clientContext: {}
      })
    ).rejects.toMatchObject({
      code: "OWNER_ONBOARDING_AUTHORIZATION_INVALID_OR_EXPIRED"
    });
  });

  it("links a second monitoring provider to the authenticated user", async () => {
    const fixture = createFixture();
    const google = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: null
    });
    const first = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: google.state,
      code: "valid-google-code",
      authenticatedUserId: null,
      clientContext: {}
    });
    const userId = first.login?.user.id;
    expect(userId).toBeTypeOf("string");
    const microsoft = await fixture.service.createAuthorizationRequest({
      provider: "MICROSOFT",
      authenticatedUserId: userId ?? null
    });
    const second = await fixture.service.completeAuthorization({
      provider: "MICROSOFT",
      state: microsoft.state,
      code: "valid-microsoft-code",
      authenticatedUserId: userId ?? null,
      clientContext: {}
    });

    expect(second.login).toBeNull();
    expect(second.onboarding?.userId).toBe(userId);
    expect(second.onboarding?.choices).toHaveLength(2);
    expect(fixture.authRepository.users.size).toBe(1);
  });

  it("never merges an anonymous provider identity by matching email only", async () => {
    const fixture = createFixture();
    fixture.authRepository.users.set("owner@example.com", {
      id: randomUUID(),
      email: "owner@example.com",
      displayName: null,
      status: "ACTIVE"
    });
    const request = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: null
    });
    await expect(
      fixture.service.completeAuthorization({
        provider: "GOOGLE",
        state: request.state,
        code: "valid-google-code",
        authenticatedUserId: null,
        clientContext: {}
      })
    ).rejects.toBeInstanceOf(AppError);
    expect(fixture.authRepository.users.size).toBe(1);
  });

  it("does not revoke a refresh token that remains active after reauthorization", async () => {
    const revokedTokens: string[] = [];
    const fixture = createFixture(revokedTokens);
    const firstRequest = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: null
    });
    const first = await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: firstRequest.state,
      code: "valid-google-code",
      authenticatedUserId: null,
      clientContext: {}
    });
    const secondRequest = await fixture.service.createAuthorizationRequest({
      provider: "GOOGLE",
      authenticatedUserId: first.login?.user.id ?? null
    });
    await fixture.service.completeAuthorization({
      provider: "GOOGLE",
      state: secondRequest.state,
      code: "valid-google-code",
      authenticatedUserId: first.login?.user.id ?? null,
      clientContext: {}
    });

    expect(revokedTokens).toEqual([]);
  });
});

function createFixture(revokedTokens: string[] = []) {
  const authRepository = new MemoryAuthRepository();
  const repository = new MemoryOwnerOnboardingRepository();
  const teamRepository = new MemoryTeamRepository();
  const authService = new AuthService({
    repository: authRepository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: "https://test.call-now.example",
    tokenPepper: "test-token-pepper-at-least-thirty-two-characters",
    magicLinkTtlMinutes: 15,
    sessionIdleDays: 30,
    sessionAbsoluteDays: 90,
    maxActiveSessions: 5,
    now: () => now
  });
  const providerAdapters = [
    createProvider("GOOGLE", "owner@example.com", revokedTokens),
    createProvider("MICROSOFT", "owner@company.example", revokedTokens)
  ];
  return {
    authRepository,
    repository,
    teamRepository,
    service: new OwnerOnboardingService({
      repository,
      authRepository,
      authService,
      teamService: new TeamService({
        repository: teamRepository,
        now: () => now,
        teamCodeGenerator: () => "482731"
      }),
      providerAdapters,
      tokenEncryption: new TestTokenEncryption(),
      tokenPepper: "test-token-pepper-at-least-thirty-two-characters",
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10 },
      onboardingTtlHours: 168,
      now: () => now
    })
  };
}

function createProvider(
  provider: MailProviderId,
  email: string,
  revokedTokens: string[]
): MailProviderAdapter {
  return {
    provider,
    createAuthorizationUrl: ({ state, codeChallenge, nonce }) => {
      const url = new URL("https://identity.example/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("nonce", nonce);
      return url.toString();
    },
    exchangeCode: async ({ code }): Promise<MailOAuthGrant> => {
      if (!code.startsWith("valid-")) throw new Error("invalid_code");
      return {
        provider,
        subject: `${provider.toLowerCase()}-subject`,
        email,
        emailVerified: true,
        refreshToken: `refresh-${provider}`,
        grantedScopes:
          provider === "GOOGLE"
            ? ["openid", "email", "gmail.readonly"]
            : ["openid", "email", "offline_access", "Mail.Read"]
      };
    },
    refreshAccessToken: async () => ({
      accessToken: "test-access-token",
      expiresAt: null,
      rotatedRefreshToken: null
    }),
    revokeAuthorization: async (token) => {
      revokedTokens.push(token);
    },
    classifyProviderError: () => "UNKNOWN"
  };
}

class TestTokenEncryption implements TokenEncryptionProvider {
  public async encrypt(plaintext: string): Promise<StoredEncryptedToken> {
    return {
      ciphertext: Buffer.from(plaintext, "utf8").toString("base64url"),
      provider: "TEST",
      keyVersion: "test-v1"
    };
  }

  public async decrypt(token: StoredEncryptedToken): Promise<string> {
    return Buffer.from(token.ciphertext, "base64url").toString("utf8");
  }
}
