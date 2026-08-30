import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";

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

describe("system routes", () => {
  it.each(["/healthz", "/readyz"])(
    "returns healthy status for %s",
    async (url) => {
      const app = await buildApp({ environment, logger: false });
      apps.push(app);

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, service: "call-now-api" });
    }
  );

  it("returns a stable error envelope for unknown routes", async () => {
    const app = await buildApp({ environment, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found."
      }
    });
  });

  it.each(["POST", "DELETE"])(
    "allows %s from the configured frontend origin",
    async (method) => {
      const app = await buildApp({ environment, logger: false });
      apps.push(app);

      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/teams/00000000-0000-4000-8000-000000000000/mail-connection",
        headers: {
          origin: environment.PUBLIC_ORIGIN,
          "access-control-request-method": method
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(
        environment.PUBLIC_ORIGIN
      );
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-methods"]).toBe(
        "GET, HEAD, POST, PUT, DELETE, OPTIONS"
      );
    }
  );

  it("reports a dependency outage through readiness without failing liveness", async () => {
    const app = await buildApp({
      environment,
      logger: false,
      readinessCheck: async () => {
        throw new Error("database unavailable");
      }
    });
    apps.push(app);

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const alive = await app.inject({ method: "GET", url: "/healthz" });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      ok: false,
      service: "call-now-api",
      reason: "dependency_unavailable"
    });
    expect(alive.statusCode).toBe(200);
  });

  it("keeps system probes available and returns a stable rate-limit error elsewhere", async () => {
    const app = await buildApp({ environment, logger: false });
    apps.push(app);
    app.get("/rate-limited-test", async () => ({ ok: true }));

    for (let index = 0; index < 130; index += 1) {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
    }

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/rate-limited-test"
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/rate-limited-test"
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({
      error: { code: "RATE_LIMITED" }
    });
  });
});
