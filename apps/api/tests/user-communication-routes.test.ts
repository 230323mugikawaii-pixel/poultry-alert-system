import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { UserCommunicationService } from "../src/modules/user-communications/user-communication-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryUserCommunicationRepository } from "./helpers/memory-user-communications.js";

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

describe("user notification and feedback routes", () => {
  it("stores feedback and delivers an operator reply as a private notification", async () => {
    const authRepository = new MemoryAuthRepository();
    const emailSender = new MemoryMagicLinkEmailSender();
    const authService = new AuthService({
      repository: authRepository,
      emailSender,
      publicOrigin: environment.PUBLIC_ORIGIN,
      tokenPepper: environment.AUTH_TOKEN_PEPPER,
      magicLinkTtlMinutes: 15,
      sessionIdleDays: 30,
      sessionAbsoluteDays: 90,
      maxActiveSessions: 5
    });
    const communications = new MemoryUserCommunicationRepository();
    const service = new UserCommunicationService(communications);
    const app = await buildApp({
      environment,
      authService,
      userCommunicationService: service,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    apps.push(app);

    const first = await login(authService, emailSender, "owner@example.com");
    const second = await login(authService, emailSender, "other@example.com");

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      headers: {
        origin: "https://other.example",
        cookie: first.cookie
      },
      payload: { content: "改善してほしい点があります。" }
    });
    expect(crossOrigin.statusCode).toBe(403);

    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: first.cookie
      },
      payload: { content: "  改善してほしい点があります。  " }
    });
    expect(submitted.statusCode).toBe(201);
    const feedbackId = submitted.json<{ id: string }>().id;
    expect(communications.feedback[0]?.message).toBe(
      "改善してほしい点があります。"
    );

    const reply = await service.recordOperatorReply({
      feedbackId,
      title: "フィードバックへの返信",
      message: "ご意見を確認しました。"
    });
    await expect(
      service.recordOperatorReply({
        feedbackId,
        title: "重複返信",
        message: "重複しません。"
      })
    ).resolves.toEqual(reply);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: first.cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json()).toMatchObject({
      unreadCount: 1,
      notifications: [
        {
          id: reply.id,
          type: "FEEDBACK_REPLY",
          readAt: null
        }
      ]
    });

    const otherCannotRead = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${reply.id}/read`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: second.cookie
      }
    });
    expect(otherCannotRead.statusCode, otherCannotRead.body).toBe(404);

    const read = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${reply.id}/read`,
      headers: {
        origin: environment.PUBLIC_ORIGIN,
        cookie: first.cookie
      }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ readAt: string | null }>().readAt).not.toBeNull();

    const listedAgain = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: first.cookie }
    });
    expect(listedAgain.json()).toMatchObject({ unreadCount: 0 });
  });
});

async function login(
  authService: AuthService,
  emailSender: MemoryMagicLinkEmailSender,
  email: string
): Promise<{ cookie: string }> {
  await authService.requestMagicLink(email);
  const link = emailSender.messages.at(-1)?.magicLink ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";
  const session = await authService.consumeMagicLink(token, {
    deviceName: "Test browser"
  });
  return { cookie: `${environment.COOKIE_NAME}=${session.sessionToken}` };
}
