import { describe, expect, it } from "vitest";
import { AuthService } from "../src/modules/auth/auth-service.js";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryIdentityProfile
} from "../src/modules/auth/primary-auth-provider.js";
import { PrimaryAuthService } from "../src/modules/auth/primary-auth-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";

const tokenPepper = "primary-auth-test-pepper-at-least-thirty-two-characters";

describe("primary authentication", () => {
  it("reports providers without credentials as not configured", () => {
    const fixture = createFixture([
      adapter("GOOGLE", "google", "g@example.com")
    ]);

    expect(fixture.service.getProviderAvailability("GOOGLE")).toBe("AVAILABLE");
    expect(fixture.service.getProviderAvailability("MICROSOFT")).toBe(
      "NOT_CONFIGURED"
    );
    expect(fixture.service.getProviderAvailability("APPLE")).toBe(
      "NOT_CONFIGURED"
    );
  });

  it("creates a user and server session from a provider subject", async () => {
    const fixture = createFixture([
      adapter("GOOGLE", "google-subject", "google@example.com")
    ]);

    const result = await login(fixture.service, "GOOGLE");

    expect(result.intent).toBe("LOGIN");
    expect(result.user.email).toBe("google@example.com");
    expect(fixture.repository.sessions).toHaveLength(1);
    expect(fixture.repository.primaryIdentities).toMatchObject([
      { provider: "GOOGLE", providerSubject: "google-subject" }
    ]);
  });

  it("never merges a different provider by matching email alone", async () => {
    const fixture = createFixture([
      adapter("GOOGLE", "google-subject", "same@example.com"),
      adapter("MICROSOFT", "microsoft-subject", "same@example.com")
    ]);
    await login(fixture.service, "GOOGLE");

    await expect(login(fixture.service, "MICROSOFT")).rejects.toMatchObject({
      code: "LOGIN_IDENTITY_LINK_REQUIRED",
      statusCode: 409
    });
    expect(fixture.repository.users.size).toBe(1);
  });

  it("links another provider only to the authenticated user", async () => {
    const fixture = createFixture([
      adapter("GOOGLE", "google-subject", "owner@example.com"),
      adapter("MICROSOFT", "microsoft-subject", "owner@example.com")
    ]);
    const loggedIn = await login(fixture.service, "GOOGLE");

    const linked = await link(fixture.service, "MICROSOFT", loggedIn.user.id);

    expect(linked.intent).toBe("LINK");
    await expect(
      fixture.service.listIdentities(loggedIn.user.id)
    ).resolves.toHaveLength(2);
  });

  it("refuses to reuse state and refuses to remove the last identity", async () => {
    const fixture = createFixture([
      adapter("APPLE", "apple-subject", "relay@privaterelay.appleid.com")
    ]);
    const request = await fixture.service.createAuthorizationRequest({
      provider: "APPLE",
      intent: "LOGIN",
      authenticatedUserId: null
    });
    const first = await fixture.service.completeAuthorization({
      provider: "APPLE",
      state: request.state,
      code: "valid-apple-code",
      authenticatedUserId: null,
      clientContext: { ipAddress: "127.0.0.1", userAgent: "vitest" }
    });
    if (first.intent !== "LOGIN") throw new Error("expected_login_result");

    await expect(
      fixture.service.completeAuthorization({
        provider: "APPLE",
        state: request.state,
        code: "valid-apple-code",
        authenticatedUserId: null,
        clientContext: { ipAddress: "127.0.0.1", userAgent: "vitest" }
      })
    ).rejects.toMatchObject({ code: "PRIMARY_LOGIN_INVALID_OR_EXPIRED" });
    await expect(
      fixture.service.unlinkIdentity(first.user.id, "APPLE")
    ).rejects.toMatchObject({ code: "LAST_LOGIN_IDENTITY_REQUIRED" });
  });
});

function createFixture(
  providerAdapters: readonly PrimaryAuthProviderAdapter[]
) {
  const repository = new MemoryAuthRepository();
  const authService = new AuthService({
    repository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: "https://test.call-now.example",
    tokenPepper,
    magicLinkTtlMinutes: 15,
    sessionIdleDays: 30,
    sessionAbsoluteDays: 90,
    maxActiveSessions: 5
  });
  return {
    repository,
    service: new PrimaryAuthService({
      repository,
      authService,
      providerAdapters,
      tokenPepper,
      stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10, APPLE: 10 }
    })
  };
}

function adapter(
  provider: "GOOGLE" | "MICROSOFT" | "APPLE",
  subject: string,
  email: string
): PrimaryAuthProviderAdapter {
  return {
    provider,
    createAuthorizationUrl: ({ state }) =>
      `https://identity.example/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async (): Promise<PrimaryIdentityProfile> => ({
      provider,
      subject,
      email,
      emailVerified: true,
      displayName: `${provider} User`
    })
  };
}

async function login(
  service: PrimaryAuthService,
  provider: "GOOGLE" | "MICROSOFT" | "APPLE"
) {
  const request = await service.createAuthorizationRequest({
    provider,
    intent: "LOGIN",
    authenticatedUserId: null
  });
  const result = await service.completeAuthorization({
    provider,
    state: request.state,
    code: `valid-${provider.toLowerCase()}-code`,
    authenticatedUserId: null,
    clientContext: { ipAddress: "127.0.0.1", userAgent: "vitest" }
  });
  if (result.intent !== "LOGIN") throw new Error("expected_login_result");
  return result;
}

async function link(
  service: PrimaryAuthService,
  provider: "GOOGLE" | "MICROSOFT" | "APPLE",
  userId: string
) {
  const request = await service.createAuthorizationRequest({
    provider,
    intent: "LINK",
    authenticatedUserId: userId
  });
  return service.completeAuthorization({
    provider,
    state: request.state,
    code: `valid-${provider.toLowerCase()}-code`,
    authenticatedUserId: userId,
    clientContext: { ipAddress: "127.0.0.1", userAgent: "vitest" }
  });
}
