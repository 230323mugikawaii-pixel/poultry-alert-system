import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

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

function createRepository(): TestNotificationMemberRepository {
  let member: NotificationMemberRecord | null = null;
  return {
    passwordHash: null,
    list: (teamId) =>
      Promise.resolve({
        members: member?.teamId === teamId ? [member] : [],
        seats: {
          seatCount: 2,
          additionalSeatLimit: 1,
          activeNotificationMemberCount: member ? 1 : 0,
          occupiedAdditionalSeats: member ? 1 : 0,
          availableSeats: member ? 0 : 1,
          pendingSeatCount: null
        }
      }),
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
        disabledAt: null
      };
      return Promise.resolve(member);
    },
    replacePassword: () => Promise.reject(new Error("not_implemented")),
    disable: () => Promise.reject(new Error("not_implemented")),
    findByCallNowId: (callNowId) =>
      Promise.resolve(member?.callNowId === callNowId ? member : null),
    createSession: () => Promise.reject(new Error("not_implemented")),
    findActiveSession: () => Promise.resolve(null),
    touchSession: () => Promise.resolve(),
    revokeSession: () => Promise.resolve()
  };
}
