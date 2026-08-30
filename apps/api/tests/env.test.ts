import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

describe("loadEnvironment", () => {
  it("applies safe local defaults", () => {
    expect(loadEnvironment({})).toMatchObject({
      APP_ENV: "development",
      PORT: 8080,
      PUBLIC_ORIGIN: "http://127.0.0.1:5500",
      GOOGLE_OAUTH_STATE_TTL_MINUTES: 10,
      MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "",
      APPLE_OAUTH_CLIENT_ID: "",
      GMAIL_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:8080/api/v1/auth/gmail/callback",
      MICROSOFT_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:8080/api/v1/auth/mail/microsoft/callback",
      MICROSOFT_OAUTH_TENANT: "common",
      MAIL_TOKEN_ENCRYPTION_PROVIDER: "local",
      MAX_CONFIGURED_SEAT_COUNT: 1_000_000
    });
  });

  it("requires HTTPS, real Gmail OAuth credentials, and KMS outside development", () => {
    const base = {
      APP_ENV: "staging",
      PUBLIC_ORIGIN: "https://staging.call-now.example",
      GMAIL_OAUTH_CLIENT_ID: "staging-gmail-client-id",
      GMAIL_OAUTH_CLIENT_SECRET: "staging-gmail-client-secret",
      MICROSOFT_OAUTH_CLIENT_ID: "staging-microsoft-client-id",
      MICROSOFT_OAUTH_CLIENT_SECRET: "staging-microsoft-client-secret",
      MICROSOFT_OAUTH_REDIRECT_URI:
        "https://api.staging.call-now.example/api/v1/auth/mail/microsoft/callback"
    };
    expect(() =>
      loadEnvironment({
        ...base,
        GMAIL_OAUTH_REDIRECT_URI:
          "http://api.staging.call-now.example/api/v1/auth/gmail/callback"
      })
    ).toThrow("GMAIL_OAUTH_REDIRECT_URI must use HTTPS outside development");

    expect(() =>
      loadEnvironment({
        ...base,
        GMAIL_OAUTH_REDIRECT_URI:
          "https://api.staging.call-now.example/api/v1/auth/gmail/callback"
      })
    ).toThrow(
      "Mail refresh tokens must use Google Cloud KMS outside development"
    );

    expect(
      loadEnvironment({
        ...base,
        GMAIL_OAUTH_REDIRECT_URI:
          "https://api.staging.call-now.example/api/v1/auth/gmail/callback",
        MAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms",
        MAIL_KMS_KEY_NAME:
          "projects/test/locations/asia-northeast1/keyRings/call-now/cryptoKeys/gmail"
      })
    ).toMatchObject({
      APP_ENV: "staging",
      MAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms"
    });
  });

  it("requires HTTPS and an explicit Microsoft tenant outside development", () => {
    expect(() =>
      loadEnvironment({
        APP_ENV: "staging",
        PUBLIC_ORIGIN: "https://staging.call-now.example",
        GMAIL_OAUTH_CLIENT_ID: "staging-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "staging-gmail-client-secret",
        GMAIL_OAUTH_REDIRECT_URI:
          "https://api.staging.call-now.example/api/v1/auth/gmail/callback",
        MICROSOFT_OAUTH_CLIENT_ID: "staging-microsoft-client-id",
        MICROSOFT_OAUTH_CLIENT_SECRET: "staging-microsoft-client-secret",
        MICROSOFT_OAUTH_REDIRECT_URI:
          "http://api.staging.call-now.example/api/v1/auth/mail/microsoft/callback"
      })
    ).toThrow(
      "MICROSOFT_OAUTH_REDIRECT_URI must use HTTPS outside development"
    );

    expect(() =>
      loadEnvironment({ MICROSOFT_OAUTH_TENANT: "not/a/tenant" })
    ).toThrow("MICROSOFT_OAUTH_TENANT is invalid");
  });

  it("requires HTTPS in production", () => {
    expect(() =>
      loadEnvironment({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "http://call-now.example"
      })
    ).toThrow("PUBLIC_ORIGIN must use HTTPS in production");
  });

  it("requires complete optional login provider configuration", () => {
    expect(() =>
      loadEnvironment({
        MICROSOFT_LOGIN_OAUTH_CLIENT_ID: "login-client-only"
      })
    ).toThrow("Microsoft login OAuth configuration is incomplete");

    expect(() =>
      loadEnvironment({
        APPLE_OAUTH_CLIENT_ID: "apple-service-id",
        APPLE_OAUTH_TEAM_ID: "apple-team-id",
        APPLE_OAUTH_KEY_ID: "apple-key-id",
        APPLE_OAUTH_PRIVATE_KEY: "private-key-placeholder",
        APPLE_OAUTH_REDIRECT_URI: "not-a-url"
      })
    ).toThrow("Apple login OAuth redirect URI must be a valid URL");

    expect(() =>
      loadEnvironment({
        APPLE_OAUTH_CLIENT_ID: "apple-service-id",
        APPLE_OAUTH_TEAM_ID: "apple-team-id",
        APPLE_OAUTH_KEY_ID: "apple-key-id",
        APPLE_OAUTH_PRIVATE_KEY: "private-key-placeholder",
        APPLE_OAUTH_REDIRECT_URI:
          "http://127.0.0.1:8080/api/v1/auth/apple/callback"
      })
    ).toThrow(
      "Apple login OAuth redirect URI must use HTTPS with a domain name"
    );
  });

  it("rejects invalid ports", () => {
    expect(() => loadEnvironment({ PORT: "70000" })).toThrow(
      "Invalid environment configuration"
    );
  });

  it("keeps the technical seat guard configurable without a customer-facing cap", () => {
    expect(
      loadEnvironment({ MAX_CONFIGURED_SEAT_COUNT: "250000" })
        .MAX_CONFIGURED_SEAT_COUNT
    ).toBe(250_000);
    expect(() => loadEnvironment({ MAX_CONFIGURED_SEAT_COUNT: "99" })).toThrow(
      "Invalid environment configuration"
    );
  });

  it("requires HTTPS and non-development Google OAuth credentials in production", () => {
    expect(() =>
      loadEnvironment({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "https://call-now.example",
        AUTH_TOKEN_PEPPER: "production-pepper-at-least-thirty-two-characters",
        GOOGLE_OAUTH_REDIRECT_URI:
          "http://api.call-now.example/api/v1/auth/google/callback"
      })
    ).toThrow("GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production");

    expect(() =>
      loadEnvironment({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "https://call-now.example",
        AUTH_TOKEN_PEPPER: "production-pepper-at-least-thirty-two-characters",
        GOOGLE_OAUTH_REDIRECT_URI:
          "https://api.call-now.example/api/v1/auth/google/callback"
      })
    ).toThrow("Google OAuth credentials must be replaced in production");
  });
});
