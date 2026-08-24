import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaidSeatIncreaseService } from "../src/modules/teams/paid-seat-increase-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const ownerUserId = "00000000-0000-0000-0000-000000000001";

async function createFixture(seatLimit = 5) {
  const repository = new MemoryTeamRepository();
  const codes = ["111111", "482731"];
  const service = new TeamService({
    repository,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    teamCodeGenerator: () => codes.shift() ?? "999999"
  });
  const { team } = await service.createTeam({
    ownerUserId,
    seatLimit,
    keywords: ["停電", "通電", "警報"]
  });
  return { repository, service, team };
}

describe("TeamService", () => {
  it("creates one owner outside five contracted member seats", async () => {
    const fixture = await createFixture(5);
    expect(fixture.team.seatSummary).toMatchObject({
      seatLimit: 5,
      activeMemberCount: 0,
      availableSeats: 5,
      totalUserLimit: 6,
      currentUserCount: 1
    });
    expect(fixture.team.currentTermAmountYen).toBe(6500);
  });

  it("creates the subscription and initial capacity invitation together", async () => {
    const repository = new MemoryTeamRepository();
    const service = new TeamService({
      repository,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
      teamCodeGenerator: () => "482731"
    });
    const created = await service.createTeam(
      { ownerUserId, seatLimit: 5 },
      {
        passwordHash: "$argon2id$prepared",
        expiresAt: new Date("2026-09-23T00:00:00.000Z")
      }
    );

    expect(created.team.seatSummary.availableSeats).toBe(5);
    expect(created.invitation).toMatchObject({ maxUses: 5, usedCount: 0 });
  });

  it("retries a colliding six-digit team code", async () => {
    const repository = new MemoryTeamRepository();
    repository.failNextTeamCode = true;
    const codes = ["111111", "482731"];
    const service = new TeamService({
      repository,
      teamCodeGenerator: () => codes.shift() ?? "999999"
    });
    const { team } = await service.createTeam({ ownerUserId, seatLimit: 0 });
    expect(team.teamCode).toBe("482731");
  });

  it("waits for payment before applying an increase and opens only the new seat", async () => {
    const fixture = await createFixture(5);
    for (let count = 0; count < 5; count += 1) {
      fixture.repository.addMember();
    }
    const requested = await fixture.service.requestSeatLimitChange(
      ownerUserId,
      6
    );
    expect(requested).toMatchObject({
      status: "AWAITING_PAYMENT",
      activeMemberCount: 5,
      availableSeats: 0
    });

    const paidIncrease = new PaidSeatIncreaseService({
      repository: fixture.repository,
      tokenPepper: "test-token-pepper-at-least-thirty-two-characters",
      invitationTtlDays: 30,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });
    const applied = await paidIncrease.apply({
      changeId: requested.changeId,
      paymentEventId: "payment-event-0001"
    });
    expect(applied).toMatchObject({
      status: "APPLIED",
      requestedSeatLimit: 6,
      activeMemberCount: 5,
      availableSeats: 1,
      invitation: { maxUses: 1, usedCount: 0 }
    });
    expect(applied.invitationPassword).toMatch(/^[A-Za-z0-9_-]{40,100}$/);

    const repeated = await paidIncrease.apply({
      changeId: requested.changeId,
      paymentEventId: "payment-event-0001"
    });
    expect(repeated.invitation?.id).toBe(applied.invitation?.id);
    expect(repeated.invitationPassword).toBe(applied.invitationPassword);
  });

  it("holds an unsafe reduction and applies a safe reduction immediately", async () => {
    const blocked = await createFixture(6);
    for (let count = 0; count < 6; count += 1) {
      blocked.repository.addMember();
    }
    await expect(
      blocked.service.requestSeatLimitChange(ownerUserId, 5)
    ).resolves.toMatchObject({
      status: "PENDING_CAPACITY",
      activeMemberCount: 6,
      availableSeats: 0
    });

    const safe = await createFixture(6);
    for (let count = 0; count < 4; count += 1) {
      safe.repository.addMember();
    }
    await expect(
      safe.service.requestSeatLimitChange(ownerUserId, 5, {
        passwordHash: "$argon2id$prepared",
        expiresAt: new Date("2026-09-23T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      status: "APPLIED",
      activeMemberCount: 4,
      availableSeats: 1,
      invitation: { maxUses: 1, usedCount: 0 }
    });
  });

  it("rejects member-only attempts to change the subscription", async () => {
    const fixture = await createFixture(5);
    const memberId = randomUUID();
    fixture.repository.addMember(memberId);

    await expect(
      fixture.service.requestSeatLimitChange(memberId, 6)
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  });
});
