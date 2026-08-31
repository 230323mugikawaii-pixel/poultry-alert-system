import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";
import { AppError } from "../src/lib/app-error.js";
import type { AlertRecord } from "../src/modules/alerts/alert-repository.js";
import type { AlertService } from "../src/modules/alerts/alert-service.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import type { NotificationMemberService } from "../src/modules/notification-members/notification-member-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
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

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("alert routes", () => {
  it("limits owner alerts to OWNER and returns a data-minimized member view", async () => {
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
    const owner = await login(authService, emailSender, "owner@example.com");
    const accountMember = await login(
      authService,
      emailSender,
      "member@example.com"
    );
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      teamCodeGenerator: () => "482731"
    });
    const team = await teamService.createTeam({
      ownerUserId: owner.userId,
      seatLimit: 0
    });
    teamRepository.addMember(accountMember.userId);
    const alert = createAlert(team.team.teamId);
    const alertService = {
      listForOwner: async () => [alert],
      listForNotificationMember: async () => [alert],
      acknowledgeByOwner: async () => ({
        alert: { ...alert, status: "ACKNOWLEDGED" as const },
        alreadyAcknowledged: false
      }),
      acknowledgeByNotificationMember: async () => ({
        alert: { ...alert, status: "ACKNOWLEDGED" as const },
        alreadyAcknowledged: false
      })
    } as unknown as AlertService;
    const memberService = {
      authenticate: async () => ({
        member: {
          id: randomUUID(),
          teamId: team.team.teamId,
          callNowId: "CN-ABCD1234",
          displayName: "通知担当",
          passwordHash: "not-returned",
          status: "ACTIVE" as const,
          createdAt: new Date(),
          disabledAt: null,
          deletedAt: null
        },
        session: {
          id: randomUUID(),
          notificationMemberId: randomUUID(),
          createdAt: new Date(),
          lastSeenAt: new Date(),
          idleExpiresAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 120_000),
          revokedAt: null
        },
        team: { id: team.team.teamId, publicCode: "482731", name: null }
      })
    } as unknown as NotificationMemberService;
    const app = await buildApp({
      environment,
      authService,
      teamService,
      notificationMemberService: memberService,
      alertService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER
      ),
      logger: false
    });
    apps.push(app);

    const ownerResponse = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.team.teamId}/alerts`,
      headers: { cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}` }
    });
    expect(ownerResponse.statusCode, ownerResponse.body).toBe(200);
    expect(ownerResponse.json()).toMatchObject({
      alerts: [{ matchedKeyword: "停電のお知らせ", recipientCount: 2 }]
    });

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.team.teamId}/alerts`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${accountMember.sessionToken}`
      }
    });
    expect(denied.statusCode).toBe(403);

    const memberResponse = await app.inject({
      method: "GET",
      url: "/api/v1/notification-members/alerts",
      headers: { cookie: `${environment.COOKIE_NAME}_member=member-token` }
    });
    expect(memberResponse.statusCode).toBe(200);
    expect(memberResponse.body).not.toContain("sourceEventId");
    expect(memberResponse.body).not.toContain("passwordHash");
    expect(memberResponse.body).not.toContain("token");
    expect(memberResponse.body).not.toContain("@example.com");

    const blockedCrossOriginAcknowledge = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.team.teamId}/alerts/${alert.id}/acknowledge`,
      headers: { cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}` }
    });
    expect(blockedCrossOriginAcknowledge.statusCode).toBe(403);

    const ownerAcknowledge = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.team.teamId}/alerts/${alert.id}/acknowledge`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    expect(ownerAcknowledge.statusCode, ownerAcknowledge.body).toBe(200);

    const memberAcknowledge = await app.inject({
      method: "POST",
      url: `/api/v1/notification-members/alerts/${alert.id}/acknowledge`,
      headers: {
        cookie: `${environment.COOKIE_NAME}_member=member-token`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    expect(memberAcknowledge.statusCode, memberAcknowledge.body).toBe(200);
  });
});

describe("alert SSE routes", () => {
  it("streams member alerts with exact credentialed CORS headers", async () => {
    const alert = createAlert(randomUUID(), "TEST");
    const memberService = createStreamingMemberService();
    const alertService = {
      listForOwner: async () => [alert],
      listForNotificationMember: async () => [alert]
    } as unknown as AlertService;
    const app = await buildStreamingApp(memberService, alertService);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${address}/api/v1/notification-members/alerts/events`,
      {
        headers: {
          cookie: `${environment.COOKIE_NAME}_member=member-token`,
          origin: environment.PUBLIC_ORIGIN
        },
        signal: controller.signal
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform"
    );
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      environment.PUBLIC_ORIGIN
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
    expect(response.headers.get("vary")).toContain("Origin");
    const body = await readStreamUntil(response, '"kind":"TEST"');
    expect(body).toContain("retry: 5000");
    expect(body).toContain("event: alerts");
    expect(body).toContain('"kind":"TEST"');
    controller.abort();

    const wrongOrigin = await fetch(
      `${address}/api/v1/notification-members/alerts/events`,
      {
        headers: {
          cookie: `${environment.COOKIE_NAME}_member=member-token`,
          origin: "https://unexpected.example"
        }
      }
    );
    expect(wrongOrigin.status).toBe(403);

    const invalidSession = await fetch(
      `${address}/api/v1/notification-members/alerts/events`,
      {
        headers: {
          cookie: `${environment.COOKIE_NAME}_member=invalid-token`,
          origin: environment.PUBLIC_ORIGIN
        }
      }
    );
    expect(invalidSession.status).toBe(401);
  });

  it("ends only invalid sessions and reconnects after transient load errors", async () => {
    let authenticationCount = 0;
    const endedMemberService = createStreamingMemberService(async () => {
      authenticationCount += 1;
      if (authenticationCount > 1) {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
    });
    const endedApp = await buildStreamingApp(endedMemberService, {
      listForOwner: async () => [],
      listForNotificationMember: async () => []
    } as unknown as AlertService);
    const endedAddress = await endedApp.listen({
      host: "127.0.0.1",
      port: 0
    });
    const endedResponse = await fetch(
      `${endedAddress}/api/v1/notification-members/alerts/events`,
      {
        headers: {
          cookie: `${environment.COOKIE_NAME}_member=member-token`,
          origin: environment.PUBLIC_ORIGIN
        }
      }
    );
    expect(await endedResponse.text()).toContain("event: session-ended");

    const transientApp = await buildStreamingApp(
      createStreamingMemberService(),
      {
        listForOwner: async () => [],
        listForNotificationMember: async () => {
          throw new Error("temporary database failure");
        }
      } as unknown as AlertService
    );
    const transientAddress = await transientApp.listen({
      host: "127.0.0.1",
      port: 0
    });
    const transientResponse = await fetch(
      `${transientAddress}/api/v1/notification-members/alerts/events`,
      {
        headers: {
          cookie: `${environment.COOKIE_NAME}_member=member-token`,
          origin: environment.PUBLIC_ORIGIN
        }
      }
    );
    const transientBody = await transientResponse.text();
    expect(transientBody).toContain("event: stream-error");
    expect(transientBody).not.toContain("event: session-ended");
  });
});

function createAlert(
  teamId: string,
  kind: "REAL" | "TEST" = "REAL"
): AlertRecord {
  const now = new Date("2026-08-28T09:00:00.000Z");
  return {
    id: randomUUID(),
    teamId,
    sourceMailConnectionId: randomUUID(),
    sourceProvider: "GOOGLE",
    kind,
    status: "ACTIVE",
    detectedAt: now,
    matchedKeyword: "停電のお知らせ",
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgedByName: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    recipientCount: 2
  };
}

function createStreamingMemberService(
  beforeAuthenticate?: () => Promise<void>
): NotificationMemberService {
  return {
    authenticate: async (token: string) => {
      if (token !== "member-token") {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
      await beforeAuthenticate?.();
      return {
        member: {
          id: randomUUID(),
          teamId: randomUUID(),
          callNowId: "CN-ABCD1234",
          displayName: "通知担当",
          passwordHash: "not-returned",
          status: "ACTIVE" as const,
          createdAt: new Date(),
          disabledAt: null,
          deletedAt: null
        },
        session: {
          id: randomUUID(),
          notificationMemberId: randomUUID(),
          createdAt: new Date(),
          lastSeenAt: new Date(),
          idleExpiresAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 120_000),
          revokedAt: null
        },
        team: { id: randomUUID(), publicCode: "482731", name: null }
      };
    }
  } as unknown as NotificationMemberService;
}

async function buildStreamingApp(
  memberService: NotificationMemberService,
  alertService: AlertService
) {
  const app = await buildApp({
    environment,
    authService: {
      authenticate: async () => {
        throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
      }
    } as unknown as AuthService,
    teamService: {
      requireOwnerForTeam: async () => {
        throw new AppError("OWNER_REQUIRED", "代表者権限が必要です。", 403);
      }
    } as unknown as TeamService,
    notificationMemberService: memberService,
    alertService,
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      environment.AUTH_TOKEN_PEPPER
    ),
    logger: false
  });
  apps.push(app);
  return app;
}

async function readStreamUntil(
  response: Response,
  marker: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body is unavailable");
  const decoder = new TextDecoder();
  let output = "";
  for (let index = 0; index < 10 && !output.includes(marker); index += 1) {
    const result = await reader.read();
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  await reader.cancel();
  return output;
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
