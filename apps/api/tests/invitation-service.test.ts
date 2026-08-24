import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvitationService } from "../src/modules/invitations/invitation-service.js";
import { TeamService } from "../src/modules/teams/team-service.js";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { MemoryInvitationRepository } from "./helpers/memory-invitation.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";
import { MemoryTeamRepository } from "./helpers/memory-team.js";

const ownerUserId = "00000000-0000-0000-0000-000000000001";
const now = new Date("2026-08-24T00:00:00.000Z");

async function createFixture(seatLimit = 5) {
  let currentTime = now;
  const teamRepository = new MemoryTeamRepository();
  const teamService = new TeamService({
    repository: teamRepository,
    now: () => currentTime,
    teamCodeGenerator: () => "482731"
  });
  const { team } = await teamService.createTeam(
    { ownerUserId, seatLimit },
    seatLimit > 0
      ? {
          passwordHash: "$argon2id$fixture",
          expiresAt: new Date("2026-09-23T00:00:00.000Z")
        }
      : null
  );
  const invitationRepository = new MemoryInvitationRepository(teamRepository);
  const invitationService = new InvitationService({
    repository: invitationRepository,
    teamService,
    publicOrigin: "https://call-now.example",
    tokenPepper: "test-token-pepper-at-least-thirty-two-characters",
    invitationTtlDays: 30,
    joinGrantTtlMinutes: 15,
    lineLinkTtlHours: 24,
    securityThrottle: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      "test-token-pepper-at-least-thirty-two-characters",
      () => currentTime
    ),
    now: () => currentTime
  });
  return {
    team,
    teamRepository,
    teamService,
    invitationRepository,
    invitationService,
    setNow: (value: Date) => {
      currentTime = value;
    }
  };
}

async function joinWithPassword(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  password: string,
  userId: string = randomUUID()
) {
  const grant = await fixture.invitationService.verifyPasswordInvitation({
    teamCode: fixture.team.teamCode,
    password,
    attemptKey: `198.51.100.${fixture.teamRepository.members.length}`
  });
  return fixture.invitationService.completeJoin({
    userId,
    joinToken: grant.joinToken,
    idempotencyKey: randomUUID()
  });
}

describe("InvitationService", () => {
  it("issues maxUses from additional member availability without storing plaintext", async () => {
    const fixture = await createFixture(5);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);

    expect(issued.invitation).toMatchObject({ maxUses: 5, usedCount: 0 });
    expect(issued.password).toMatch(/^[A-Za-z0-9_-]{20,100}$/);
    expect(fixture.invitationRepository.invitations[0]?.passwordHash).not.toBe(
      issued.password
    );
    expect(fixture.invitationRepository.invitations[0]?.passwordHash).toContain(
      "$argon2id$"
    );
  });

  it("exhausts a five-use invitation after five additional members join", async () => {
    const fixture = await createFixture(5);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);

    for (let count = 1; count <= 5; count += 1) {
      const joined = await joinWithPassword(fixture, issued.password);
      expect(joined.activeMemberCount).toBe(count);
    }
    expect(fixture.invitationRepository.invitations[0]).toMatchObject({
      status: "EXHAUSTED",
      usedCount: 5,
      maxUses: 5
    });
    await expect(
      fixture.invitationService.verifyPasswordInvitation({
        teamCode: "482731",
        password: issued.password,
        attemptKey: "203.0.113.10"
      })
    ).rejects.toMatchObject({ code: "INVITATION_EXHAUSTED" });
  });

  it("allows only one winner when two members compete for the last seat", async () => {
    const fixture = await createFixture(1);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);
    const firstGrant = await fixture.invitationService.verifyPasswordInvitation(
      {
        teamCode: "482731",
        password: issued.password,
        attemptKey: "192.0.2.1"
      }
    );
    const secondGrant =
      await fixture.invitationService.verifyPasswordInvitation({
        teamCode: "482731",
        password: issued.password,
        attemptKey: "192.0.2.2"
      });

    const attempts = await Promise.allSettled([
      fixture.invitationService.completeJoin({
        userId: randomUUID(),
        joinToken: firstGrant.joinToken,
        idempotencyKey: randomUUID()
      }),
      fixture.invitationService.completeJoin({
        userId: randomUUID(),
        joinToken: secondGrant.joinToken,
        idempotencyKey: randomUUID()
      })
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled")
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1
    );
  });

  it("creates a 24-hour one-use LINE link without including the password", async () => {
    const fixture = await createFixture(2);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);
    const line = await fixture.invitationService.createLineInvitationLink(
      ownerUserId,
      issued.invitation.id
    );

    expect(line.shareText).toContain("チームID：482731");
    expect(line.shareText).not.toContain(issued.password);
    expect(line.expiresAt.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    const token = new URL(line.invitationLink).searchParams.get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);
    expect(fixture.invitationRepository.links[0]?.tokenHash).not.toBe(token);

    const grant = await fixture.invitationService.verifyLineInvitation(
      token ?? ""
    );
    await fixture.invitationService.completeJoin({
      userId: randomUUID(),
      joinToken: grant.joinToken,
      idempotencyKey: randomUUID()
    });
    expect(fixture.invitationRepository.links[0]).toMatchObject({
      status: "EXHAUSTED",
      usedCount: 1,
      maxUses: 1
    });
  });

  it("invalidates active LINE links when the parent invitation is revoked", async () => {
    const fixture = await createFixture(2);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);
    const line = await fixture.invitationService.createLineInvitationLink(
      ownerUserId,
      issued.invitation.id
    );
    const token = new URL(line.invitationLink).searchParams.get("token");

    await fixture.invitationService.revokeInvitation(
      ownerUserId,
      issued.invitation.id
    );

    expect(fixture.invitationRepository.invitations[0]?.status).toBe("REVOKED");
    expect(fixture.invitationRepository.links[0]?.status).toBe("REVOKED");
    await expect(
      fixture.invitationService.verifyLineInvitation(token ?? "")
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
  });

  it("persists expired invitation and link states when they are observed", async () => {
    const fixture = await createFixture(2);
    const issued =
      await fixture.invitationService.reissuePasswordInvitation(ownerUserId);
    const line = await fixture.invitationService.createLineInvitationLink(
      ownerUserId,
      issued.invitation.id
    );
    const lineToken = new URL(line.invitationLink).searchParams.get("token");

    fixture.setNow(new Date("2026-08-25T00:00:01.000Z"));
    await expect(
      fixture.invitationService.verifyLineInvitation(lineToken ?? "")
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(fixture.invitationRepository.links[0]?.status).toBe("EXPIRED");
    expect(fixture.invitationRepository.invitations[0]?.status).toBe("ACTIVE");

    fixture.setNow(new Date("2026-09-24T00:00:01.000Z"));
    await expect(
      fixture.invitationService.verifyPasswordInvitation({
        teamCode: "482731",
        password: issued.password,
        attemptKey: "192.0.2.80"
      })
    ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(fixture.invitationRepository.invitations[0]?.status).toBe("EXPIRED");
    await expect(
      fixture.invitationService.listInvitations(ownerUserId)
    ).resolves.toEqual([
      expect.objectContaining({ id: issued.invitation.id, status: "EXPIRED" })
    ]);
  });

  it("locks repeated password failures for the team and source", async () => {
    const fixture = await createFixture(1);
    await fixture.invitationService.reissuePasswordInvitation(ownerUserId);
    for (let count = 0; count < 5; count += 1) {
      await expect(
        fixture.invitationService.verifyPasswordInvitation({
          teamCode: "482731",
          password: "wrong-password",
          attemptKey: "192.0.2.50"
        })
      ).rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    }
    await expect(
      fixture.invitationService.verifyPasswordInvitation({
        teamCode: "482731",
        password: "wrong-password",
        attemptKey: "192.0.2.50"
      })
    ).rejects.toMatchObject({ code: "INVITATION_TEMPORARILY_LOCKED" });
  });

  it("issues exactly one replacement seat after an owner removes a member", async () => {
    const fixture = await createFixture(5);
    for (let count = 0; count < 5; count += 1) {
      fixture.teamRepository.addMember();
    }
    const target = fixture.teamRepository.members.find(
      ({ role }) => role === "MEMBER"
    );
    const removed = await fixture.invitationService.removeMember(
      ownerUserId,
      target?.membershipId ?? ""
    );
    expect(removed).toMatchObject({
      activeMemberCount: 4,
      seatLimit: 5,
      availableSeats: 1,
      pendingSeatLimitApplied: false
    });
    expect(removed.invitation).toMatchObject({ maxUses: 1, usedCount: 0 });
    expect(removed.invitationPassword).toMatch(/^[A-Za-z0-9_-]{20,100}$/);
  });

  it("applies a pending reduction after removal without creating a false vacancy", async () => {
    const fixture = await createFixture(6);
    for (let count = 0; count < 6; count += 1) {
      fixture.teamRepository.addMember();
    }
    await fixture.teamService.requestSeatLimitChange(ownerUserId, 5);
    const target = fixture.teamRepository.members.find(
      ({ role }) => role === "MEMBER"
    );
    const removed = await fixture.invitationService.removeMember(
      ownerUserId,
      target?.membershipId ?? ""
    );
    expect(removed).toMatchObject({
      activeMemberCount: 5,
      seatLimit: 5,
      availableSeats: 0,
      pendingSeatLimitApplied: true,
      invitation: null,
      invitationPassword: null
    });
  });

  it("does not allow the owner membership to be removed as a member", async () => {
    const fixture = await createFixture(1);
    await expect(
      fixture.invitationService.removeMember(
        ownerUserId,
        fixture.team.membershipId
      )
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });
});
