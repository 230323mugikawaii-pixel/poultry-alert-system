import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnvironment } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/auth-service.js";
import { verifyInvitationPassword } from "../src/modules/invitations/invitation-credential.js";
import type {
  NotificationMemberRecord,
  NotificationMemberRepository
} from "../src/modules/notification-members/notification-member-repository.js";
import {
  generateCallNowId,
  NotificationMemberService
} from "../src/modules/notification-members/notification-member-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const tokenPepper = "test-token-pepper-at-least-thirty-two-characters";

describe("NotificationMemberService", () => {
  it("generates an opaque Call Now ID and stores only an Argon2id hash", async () => {
    const repository = createRepository();
    const service = createService(repository, () => "CN-AB12CD34");

    const result = await service.create({
      teamId: randomUUID(),
      actorUserId: randomUUID(),
      displayName: " 山田 "
    });

    expect(result.member).toMatchObject({
      callNowId: "CN-AB12CD34",
      displayName: "山田"
    });
    expect(result.initialPassword.length).toBeGreaterThanOrEqual(20);
    expect(repository.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(repository.passwordHash).not.toContain(result.initialPassword);
    await expect(
      verifyInvitationPassword(
        repository.passwordHash ?? "",
        result.initialPassword
      )
    ).resolves.toBe(true);
  });

  it("uses the shared throttle for owner credential management", async () => {
    const repository = createRepository();
    const throttleRepository = new MemorySecurityThrottleRepository();
    const first = createService(
      repository,
      () => "CN-AB12CD34",
      throttleRepository
    );
    const second = createService(
      repository,
      () => "CN-EF56GH78",
      throttleRepository
    );
    const input = {
      operation: "CREATE" as const,
      actorUserId: randomUUID(),
      teamId: randomUUID(),
      ipAddress: "198.51.100.10"
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await (attempt % 2 === 0 ? first : second).consumeManagementAttempt(
        input
      );
    }

    await expect(first.consumeManagementAttempt(input)).rejects.toMatchObject({
      code: "NOTIFICATION_MEMBER_MANAGEMENT_RATE_LIMITED",
      statusCode: 429
    });
    await expect(
      second.consumeManagementAttempt({ ...input, teamId: randomUUID() })
    ).resolves.toBeUndefined();
  });

  it("returns the same error for an unknown ID and a wrong password", async () => {
    const repository = createRepository();
    const service = createService(repository, () => "CN-AB12CD34");
    const created = await service.create({
      teamId: randomUUID(),
      actorUserId: randomUUID()
    });

    await expect(
      service.login({
        callNowId: created.member.callNowId,
        password: "incorrect-password",
        ipAddress: "198.51.100.20"
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_MEMBER_LOGIN_FAILED",
      statusCode: 401
    });
    await expect(
      service.login({
        callNowId: "CN-ZZZZZZZZ",
        password: "incorrect-password",
        ipAddress: "198.51.100.21"
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_MEMBER_LOGIN_FAILED",
      statusCode: 401
    });
  });

  it("keeps generated IDs inside the non-ambiguous random format", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateCallNowId()).toMatch(/^CN-[0-9A-HJKMNP-TV-Z]{8}$/u);
    }
  });

  it("returns HTTP 200 with seat data when an owner has no participants", async () => {
    const environment = loadEnvironment({
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_ORIGIN: "https://test.call-now.example",
      COOKIE_NAME: "callnow_notification_member_test",
      AUTH_TOKEN_PEPPER: tokenPepper
    });
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
    const teamRepository = new MemoryTeamRepository();
    const teamService = new TeamService({
      repository: teamRepository,
      teamCodeGenerator: () => "482731"
    });
    const created = await teamService.createTeam(
      { ownerUserId: owner.userId, seatLimit: 4 },
      {
        passwordHash: "$argon2id$fixture",
        expiresAt: new Date("2026-09-30T00:00:00.000Z")
      }
    );
    const notificationRepository = createRepository(5);
    const memberService = createService(
      notificationRepository,
      () => "CN-AB12CD34"
    );
    const app = await buildApp({
      environment,
      authService,
      teamService,
      notificationMemberService: memberService,
      securityThrottleService: new SecurityThrottleService(
        new MemorySecurityThrottleRepository(),
        tokenPepper
      ),
      logger: false
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${created.team.teamId}/notification-members`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      members: [],
      seats: {
        seatCount: 5,
        additionalSeatLimit: 4,
        activeNotificationMemberCount: 0,
        occupiedAdditionalSeats: 0,
        availableSeats: 4,
        pendingSeatCount: null
      }
    });

    const createdMember = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${created.team.teamId}/notification-members`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      },
      payload: { displayName: "参加者" }
    });
    expect(createdMember.statusCode, createdMember.body).toBe(201);
    expect(createdMember.headers["cache-control"]).toBe("no-store");
    const memberId = createdMember.json<{ member: { id: string } }>().member.id;
    const listedMember = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${created.team.teamId}/notification-members`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`
      }
    });
    expect(listedMember.statusCode, listedMember.body).toBe(200);
    expect(listedMember.body).not.toContain("initialPassword");
    expect(listedMember.body).not.toContain("passwordHash");
    expect(listedMember.body).not.toContain("$argon2id$");

    const crossSiteReset = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}/password-reset`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`
      }
    });
    expect(crossSiteReset.statusCode).toBe(403);

    const resetPassword = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}/password-reset`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    expect(resetPassword.statusCode, resetPassword.body).toBe(200);
    expect(resetPassword.headers["cache-control"]).toBe("no-store");
    expect(resetPassword.json()).toMatchObject({
      member: { id: memberId, callNowId: "CN-AB12CD34", status: "ACTIVE" }
    });
    expect(
      resetPassword.json<{ initialPassword: string }>().initialPassword
    ).toHaveLength(24);
    expect(resetPassword.body).not.toContain("passwordHash");
    await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });

    const crossSiteReactivation = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}/reactivate`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`
      }
    });
    expect(crossSiteReactivation.statusCode).toBe(403);

    const reactivated = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}/reactivate`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    expect(reactivated.statusCode, reactivated.body).toBe(200);
    expect(reactivated.headers["cache-control"]).toBe("no-store");
    expect(reactivated.json()).toMatchObject({
      member: { id: memberId, callNowId: "CN-AB12CD34", status: "ACTIVE" }
    });

    await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${created.team.teamId}/notification-members/${memberId}/record`,
      headers: {
        cookie: `${environment.COOKIE_NAME}=${owner.sessionToken}`,
        origin: environment.PUBLIC_ORIGIN
      }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ members: [] });
    await app.close();
  });
});

function createService(
  repository: TestNotificationMemberRepository,
  callNowIdGenerator: () => string,
  throttleRepository = new MemorySecurityThrottleRepository()
): NotificationMemberService {
  return new NotificationMemberService({
    repository,
    securityThrottle: new SecurityThrottleService(
      throttleRepository,
      tokenPepper
    ),
    tokenPepper,
    sessionIdleDays: 30,
    sessionAbsoluteDays: 90,
    maxActiveSessions: 5,
    callNowIdGenerator
  });
}

interface TestNotificationMemberRepository extends NotificationMemberRepository {
  passwordHash: string | null;
}

function createRepository(seatCount = 2): TestNotificationMemberRepository {
  let member: NotificationMemberRecord | null = null;
  const list = (teamId: string) => {
    const visibleMember = member?.teamId === teamId ? member : null;
    const activeMemberCount = visibleMember?.status === "ACTIVE" ? 1 : 0;
    return {
      members: visibleMember ? [visibleMember] : [],
      seats: {
        seatCount,
        additionalSeatLimit: seatCount - 1,
        activeNotificationMemberCount: activeMemberCount,
        occupiedAdditionalSeats: activeMemberCount,
        availableSeats: seatCount - 1 - activeMemberCount,
        pendingSeatCount: null
      }
    };
  };
  return {
    passwordHash: null,
    list: (teamId) => Promise.resolve(list(teamId)),
    create(input) {
      this.passwordHash = input.passwordHash;
      member = {
        id: randomUUID(),
        teamId: input.teamId,
        callNowId: input.callNowId,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        status: "ACTIVE",
        createdAt: input.now,
        disabledAt: null,
        deletedAt: null
      };
      return Promise.resolve(member);
    },
    replacePassword(input) {
      if (
        !member ||
        member.id !== input.memberId ||
        member.teamId !== input.teamId ||
        member.status !== "ACTIVE"
      ) {
        return Promise.reject(new Error("member_not_found"));
      }
      this.passwordHash = input.passwordHash;
      member = { ...member, passwordHash: input.passwordHash };
      return Promise.resolve(member);
    },
    disable: (input) => {
      if (
        !member ||
        member.id !== input.memberId ||
        member.status !== "ACTIVE"
      ) {
        return Promise.reject(new Error("member_not_found"));
      }
      member = { ...member, status: "DISABLED", disabledAt: input.now };
      return Promise.resolve(list(input.teamId));
    },
    reactivate(input) {
      if (
        !member ||
        member.id !== input.memberId ||
        member.status !== "DISABLED"
      ) {
        return Promise.reject(new Error("member_not_found"));
      }
      this.passwordHash = input.passwordHash;
      member = {
        ...member,
        passwordHash: input.passwordHash,
        status: "ACTIVE",
        disabledAt: null
      };
      return Promise.resolve(member);
    },
    softDelete: (input) => {
      if (
        !member ||
        member.id !== input.memberId ||
        member.status !== "DISABLED"
      ) {
        return Promise.reject(new Error("member_not_found"));
      }
      member = null;
      return Promise.resolve(list(input.teamId));
    },
    findByCallNowId: (callNowId) =>
      Promise.resolve(member?.callNowId === callNowId ? member : null),
    createSession: () => Promise.reject(new Error("not_implemented")),
    findActiveSession: () => Promise.resolve(null),
    touchSession: () => Promise.resolve(),
    revokeSession: () => Promise.resolve()
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
