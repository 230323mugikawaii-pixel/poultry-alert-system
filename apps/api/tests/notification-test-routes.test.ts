import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import type { NotificationTestRecord } from "../src/modules/alerts/notification-test-repository.js";
import type { NotificationTestService } from "../src/modules/alerts/notification-test-service.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const environment = loadEnvironment({
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_notification_test_session",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/callnow_test",
  AUTH_TOKEN_PEPPER: "notification-test-pepper-at-least-thirty-two-characters"
});
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("notification test routes", () => {
  it("requires OWNER and Same-Origin, returns server IDs, and rate limits starts", async () => {
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
    const member = await login(authService, emailSender, "member@example.com");
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      teamCodeGenerator: () => "482751"
    });
    const team = await teamService.createTeam({
      ownerUserId: owner.userId,
      seatLimit: 0
    });
    teamRepository.addMember(member.userId);
    const record = createNotificationTest(team.team.teamId, owner.userId);
    const notificationTestService = {
      start: async () => ({ test: record, created: true }),
      confirm: async () => ({
        test: {
          ...record,
          status: "ALERT_CREATED" as const,
          detectedAt: record.createdAt,
          alertId: randomUUID(),
          completedAt: record.createdAt
        },
        created: true
      }),
      getForOwner: async () => record,
      markFailed: async () => ({ ...record, status: "FAILED" as const }),
      markExpired: async () => ({ ...record, status: "EXPIRED" as const })
    } as unknown as NotificationTestService;
    const app = await buildApp({
      environment,
      authService,
      teamService,
      notificationTestService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        environment.AUTH_TOKEN_PEPPER,
        () => record.createdAt
      ),
      logger: false
    });
    apps.push(app);
    const url = `/api/v1/teams/${team.team.teamId}/notification-tests`;
    const payload = {
      mailConnectionId: record.sourceMailConnectionId,
      keyword: record.keyword
    };

    const noOrigin = await app.inject({
      method: "POST",
      url,
      headers: { cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}` },
      payload
    });
    expect(noOrigin.statusCode).toBe(403);

    const deniedMember = await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${member.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      },
      payload
    });
    expect(deniedMember.statusCode).toBe(403);

    const start = () =>
      app.inject({
        method: "POST",
        url,
        headers: {
          cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
          origin: environment.PUBLIC_ORIGIN
        },
        payload
      });
    for (let index = 0; index < 3; index += 1) {
      const response = await start();
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        test: {
          id: record.id,
          requestId: record.requestId,
          status: "PENDING"
        }
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const limited = await start();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: "NOTIFICATION_TEST_RATE_LIMITED" }
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `${url}/${record.id}/confirm`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      },
      payload: { requestId: record.requestId }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({
      test: { status: "ALERT_CREATED" },
      alertCreated: true
    });
  });
});

function createNotificationTest(
  teamId: string,
  actorUserId: string
): NotificationTestRecord {
  const now = new Date("2026-08-31T01:00:00.000Z");
  return {
    id: randomUUID(),
    teamId,
    actorUserId,
    sourceMailConnectionId: randomUUID(),
    keyword: "停電のお知らせ",
    requestId: "server-generated-request-id",
    status: "PENDING",
    expiresAt: new Date(now.getTime() + 180_000),
    detectedAt: null,
    alertId: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
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
