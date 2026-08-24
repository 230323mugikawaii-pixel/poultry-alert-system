import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { AppError } from "../src/lib/app-error.js";
import { InvitationService } from "../src/modules/invitations/invitation-service.js";
import { PrismaInvitationRepository } from "../src/modules/invitations/prisma-invitation-repository.js";
import { PrismaTeamRepository } from "../src/modules/teams/prisma-team-repository.js";
import { TeamService } from "../src/modules/teams/team-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const postgresDescribe =
  process.env.RUN_POSTGRES_TESTS === "true" ? describe : describe.skip;

let database: DatabaseClient;

postgresDescribe("PostgreSQL concurrent invitation redemption", () => {
  beforeAll(async () => {
    assertDedicatedTestDatabase(databaseUrl);
    database = createDatabaseClient(databaseUrl);
    await database.$queryRaw`SELECT 1`;
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        audit_events,
        invitation_redemptions,
        invitation_links,
        auth_challenges,
        invitations,
        notification_targets,
        sessions,
        devices,
        subscription_changes,
        team_keywords,
        subscriptions,
        team_memberships,
        gmail_connections,
        owner_transfers,
        auth_credentials,
        teams,
        users,
        security_throttles
      CASCADE
    `);
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  it("admits only five members to five seats and returns 409 for the loser", async () => {
    const users = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        database.user.create({
          data: {
            email: `postgres-acceptance-${index}@example.com`,
            emailVerifiedAt: new Date()
          }
        })
      )
    );
    const owner = users[0];
    const members = users.slice(1);
    expect(owner).toBeDefined();

    const teamService = new TeamService({
      repository: new PrismaTeamRepository(database),
      teamCodeGenerator: () => "482731"
    });
    const team = await teamService.createTeam({
      ownerUserId: owner?.id ?? "",
      seatLimit: 5
    });
    const invitationService = new InvitationService({
      repository: new PrismaInvitationRepository(database),
      teamService,
      publicOrigin: "https://acceptance.call-now.example",
      tokenPepper: "postgres-acceptance-pepper-at-least-thirty-two-characters",
      invitationTtlDays: 30,
      joinGrantTtlMinutes: 15,
      lineLinkTtlHours: 24
    });
    const issued = await invitationService.issueForTeam(
      team.teamId,
      owner?.id ?? ""
    );
    const grants = await Promise.all(
      members.map((_, index) =>
        invitationService.verifyPasswordInvitation({
          teamCode: team.teamCode,
          password: issued.password,
          attemptKey: `198.51.100.${index + 1}`
        })
      )
    );

    const attempts = await Promise.allSettled(
      members.map((member, index) =>
        invitationService.completeJoin({
          userId: member.id,
          joinToken: grants[index]?.joinToken ?? "",
          idempotencyKey: randomUUID()
        })
      )
    );
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(1);
    const rejection: unknown = rejected[0]?.reason;
    expect(rejection).toBeInstanceOf(AppError);
    if (!(rejection instanceof AppError)) {
      throw new Error("Expected the rejected join to return an AppError");
    }
    expect(rejection).toMatchObject({ statusCode: 409 });
    expect(["INVITATION_EXHAUSTED", "JOIN_TRANSACTION_CONFLICT"]).toContain(
      rejection.code
    );

    await expect(
      database.teamMembership.count({
        where: { teamId: team.teamId, role: "MEMBER", status: "ACTIVE" }
      })
    ).resolves.toBe(5);
    await expect(
      database.invitation.findUnique({
        where: { id: issued.invitation.id },
        select: { status: true, maxUses: true, usedCount: true }
      })
    ).resolves.toEqual({ status: "EXHAUSTED", maxUses: 5, usedCount: 5 });
  });
});

function assertDedicatedTestDatabase(value: string): void {
  let databaseName: string;
  try {
    databaseName = new URL(value).pathname.replace(/^\//, "");
  } catch {
    throw new Error("DATABASE_URL must identify a dedicated test database");
  }
  if (!/(?:test|acceptance)/i.test(databaseName)) {
    throw new Error(
      "PostgreSQL integration tests require a database name containing test or acceptance"
    );
  }
}
