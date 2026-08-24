import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";

const environment: AppEnvironment = {
  APP_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_test_session",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  AUTH_TOKEN_PEPPER: "test-token-pepper-at-least-thirty-two-characters",
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

describe("magic link routes", () => {
  it("does not expose the token and sets a protected session cookie after consumption", async () => {
    const repository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5
    });
    const app = await buildApp({ environment, authService, logger: false });
    apps.push(app);

    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links/request",
      headers: { origin: environment.PUBLIC_ORIGIN },
      payload: { email: "member@example.com" }
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ accepted: true });
    expect(requested.body).not.toContain("token");

    const token = new URL(
      emailSender.messages[0]?.magicLink ?? ""
    ).searchParams.get("token");
    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links/consume",
      headers: { origin: environment.PUBLIC_ORIGIN },
      payload: { token, deviceName: "Safari" }
    });
    expect(consumed.statusCode).toBe(200);
    const cookie = consumed.headers["set-cookie"];
    expect(cookie).toContain("callnow_test_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: String(cookie).split(";")[0] }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(
      "member@example.com"
    );
  });

  it("rejects state-changing requests from another origin", async () => {
    const authService = new AuthService({
      repository: new MemoryAuthRepository(),
      emailSender: new MemoryMagicLinkEmailSender(),
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5
    });
    const app = await buildApp({ environment, authService, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/magic-links/request",
      headers: { origin: "https://evil.example" },
      payload: { email: "member@example.com" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "ORIGIN_NOT_ALLOWED"
    );
  });
});
