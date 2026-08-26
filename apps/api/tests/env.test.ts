import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

describe("loadEnvironment", () => {
  it("applies safe local defaults", () => {
    expect(loadEnvironment({})).toMatchObject({
      APP_ENV: "development",
      PORT: 8080,
      PUBLIC_ORIGIN: "http://127.0.0.1:5500",
      GOOGLE_OAUTH_STATE_TTL_MINUTES: 10,
      GMAIL_OAUTH_REDIRECT_URI:
        "http://127.0.0.1:8080/api/v1/auth/gmail/callback",
      GMAIL_TOKEN_ENCRYPTION_PROVIDER: "local"
    });
  });

  it("requires HTTPS, real Gmail OAuth credentials, and KMS outside development", () => {
    const base = {
      APP_ENV: "staging",
      PUBLIC_ORIGIN: "https://staging.call-now.example",
      GMAIL_OAUTH_CLIENT_ID: "staging-gmail-client-id",
      GMAIL_OAUTH_CLIENT_SECRET: "staging-gmail-client-secret"
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
    ).toThrow("Gmail tokens must use Google Cloud KMS outside development");

    expect(
      loadEnvironment({
        ...base,
        GMAIL_OAUTH_REDIRECT_URI:
          "https://api.staging.call-now.example/api/v1/auth/gmail/callback",
        GMAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms",
        GMAIL_KMS_KEY_NAME:
          "projects/test/locations/asia-northeast1/keyRings/call-now/cryptoKeys/gmail"
      })
    ).toMatchObject({
      APP_ENV: "staging",
      GMAIL_TOKEN_ENCRYPTION_PROVIDER: "gcp-kms"
    });
  });

  it("requires HTTPS in production", () => {
    expect(() =>
      loadEnvironment({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "http://call-now.example"
      })
    ).toThrow("PUBLIC_ORIGIN must use HTTPS in production");
  });

  it("rejects invalid ports", () => {
    expect(() => loadEnvironment({ PORT: "70000" })).toThrow(
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
