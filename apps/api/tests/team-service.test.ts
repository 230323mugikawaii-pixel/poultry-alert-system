import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  const team = await service.createTeam({
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

  it("retries a colliding six-digit team code", async () => {
    const repository = new MemoryTeamRepository();
    repository.failNextTeamCode = true;
    const codes = ["111111", "482731"];
    const service = new TeamService({
      repository,
      teamCodeGenerator: () => codes.shift() ?? "999999"
    });
    const team = await service.createTeam({ ownerUserId, seatLimit: 0 });
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

    const applied = await fixture.service.applyPaidSeatIncrease(
      requested.changeId
    );
    expect(applied).toMatchObject({
      status: "APPLIED",
      requestedSeatLimit: 6,
      activeMemberCount: 5,
      availableSeats: 1
    });
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
      safe.service.requestSeatLimitChange(ownerUserId, 5)
    ).resolves.toMatchObject({
      status: "APPLIED",
      activeMemberCount: 4,
      availableSeats: 1
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
