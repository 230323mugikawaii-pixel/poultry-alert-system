import type { DatabaseClient } from "../../db/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  calculateAnnualPriceYen,
  calculateSeatSummary
} from "./seat-policy.js";
import type {
  CreateTeamInput,
  SeatLimitChangeResult,
  TeamContextRecord,
  TeamMemberRecord,
  TeamRepository
} from "./team-repository.js";

export class PrismaTeamRepository implements TeamRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createTeam(input: CreateTeamInput): Promise<TeamContextRecord> {
    try {
      return await this.database.$transaction(
        async (transaction) => {
          const team = await transaction.team.create({
            data: {
              publicCode: input.publicCode,
              name: input.name,
              memberships: {
                create: {
                  userId: input.ownerUserId,
                  role: "OWNER",
                  status: "ACTIVE"
                }
              },
              subscription: {
                create: {
                  seatLimit: input.seatLimit,
                  currentTermAmountYen: input.currentTermAmountYen,
                  currentTermStartedAt: input.currentTermStartedAt,
                  currentTermEndsAt: input.currentTermEndsAt
                }
              },
              keywords: {
                create: input.keywords.map((keyword) => ({
                  keyword,
                  normalized: keyword.normalize("NFKC").toLowerCase()
                }))
              }
            },
            include: {
              memberships: {
                where: { userId: input.ownerUserId, status: "ACTIVE" }
              },
              subscription: true
            }
          });

          await transaction.auditEvent.create({
            data: {
              teamId: team.id,
              actorUserId: input.ownerUserId,
              action: "TEAM_CREATED",
              targetType: "Team",
              targetId: team.id,
              metadata: {
                seatLimit: input.seatLimit,
                keywordCount: input.keywords.length
              }
            }
          });

          const membership = team.memberships[0];
          if (!membership || !team.subscription) {
            throw new Error("team_creation_invariant_failed");
          }

          return mapTeamContext({
            team,
            membership,
            subscription: team.subscription,
            activeMemberCount: 0
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError("TEAM_CODE_CONFLICT", "Team code collision.", 409);
      }
      throw error;
    }
  }

  public async findCurrentTeam(
    userId: string
  ): Promise<TeamContextRecord | null> {
    const membership = await this.database.teamMembership.findFirst({
      where: {
        userId,
        status: "ACTIVE",
        team: { status: "ACTIVE" }
      },
      include: {
        team: { include: { subscription: true } }
      },
      orderBy: { joinedAt: "asc" }
    });
    if (!membership?.team.subscription) {
      return null;
    }

    const activeMemberCount = await this.database.teamMembership.count({
      where: {
        teamId: membership.teamId,
        role: "MEMBER",
        status: "ACTIVE"
      }
    });

    return mapTeamContext({
      team: membership.team,
      membership,
      subscription: membership.team.subscription,
      activeMemberCount
    });
  }

  public async listActiveMembers(
    teamId: string
  ): Promise<readonly TeamMemberRecord[]> {
    const memberships = await this.database.teamMembership.findMany({
      where: { teamId, status: "ACTIVE" },
      include: { user: true },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }]
    });

    return memberships.map((membership) => ({
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      displayName: membership.user.displayName,
      role: membership.role,
      joinedAt: membership.joinedAt
    }));
  }

  public async requestSeatLimitChange(input: {
    readonly teamId: string;
    readonly requestedByUserId: string;
    readonly requestedSeatLimit: number;
    readonly now: Date;
  }): Promise<SeatLimitChangeResult> {
    return this.database.$transaction(
      async (transaction) => {
        const owner = await transaction.teamMembership.findFirst({
          where: {
            teamId: input.teamId,
            userId: input.requestedByUserId,
            role: "OWNER",
            status: "ACTIVE"
          },
          select: { id: true }
        });
        if (!owner) {
          throw new AppError(
            "OWNER_REQUIRED",
            "この操作はチームの代表者だけが実行できます。",
            403
          );
        }

        const existingSubscription = await transaction.subscription.findUnique({
          where: { teamId: input.teamId }
        });
        if (!existingSubscription) {
          throw new AppError(
            "SUBSCRIPTION_NOT_FOUND",
            "契約が見つかりません。",
            404
          );
        }

        await transaction.$queryRaw(
          Prisma.sql`SELECT id FROM subscriptions WHERE id = ${existingSubscription.id}::uuid FOR UPDATE`
        );
        const subscription = await transaction.subscription.findUniqueOrThrow({
          where: { id: existingSubscription.id }
        });
        const activeMemberCount = await transaction.teamMembership.count({
          where: {
            teamId: input.teamId,
            role: "MEMBER",
            status: "ACTIVE"
          }
        });

        if (
          input.requestedSeatLimit === subscription.seatLimit &&
          subscription.pendingSeatLimit === null
        ) {
          throw new AppError(
            "SEAT_LIMIT_UNCHANGED",
            "追加メンバー契約数は変更されていません。",
            409
          );
        }

        await transaction.subscriptionChange.updateMany({
          where: {
            subscriptionId: subscription.id,
            status: { in: ["AWAITING_PAYMENT", "PENDING_CAPACITY"] }
          },
          data: { status: "CANCELED", canceledAt: input.now }
        });

        let status: SeatLimitChangeResult["status"];
        let appliedSeatLimit = subscription.seatLimit;

        if (input.requestedSeatLimit > subscription.seatLimit) {
          status = "AWAITING_PAYMENT";
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { pendingSeatLimit: null }
          });
        } else if (input.requestedSeatLimit >= activeMemberCount) {
          status = "APPLIED";
          appliedSeatLimit = input.requestedSeatLimit;
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: {
              seatLimit: input.requestedSeatLimit,
              pendingSeatLimit: null
            }
          });
          await replaceActiveInvitations(transaction, input.teamId, input.now);
        } else {
          status = "PENDING_CAPACITY";
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { pendingSeatLimit: input.requestedSeatLimit }
          });
          await revokeActiveInvitations(
            transaction,
            input.teamId,
            input.now,
            "PENDING_SEAT_REDUCTION"
          );
        }

        const change = await transaction.subscriptionChange.create({
          data: {
            subscriptionId: subscription.id,
            requestedByUserId: input.requestedByUserId,
            previousSeatLimit: subscription.seatLimit,
            requestedSeatLimit: input.requestedSeatLimit,
            status,
            ...(status === "APPLIED" ? { appliedAt: input.now } : {})
          }
        });

        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.requestedByUserId,
            action: "SEAT_LIMIT_CHANGE_REQUESTED",
            targetType: "SubscriptionChange",
            targetId: change.id,
            metadata: {
              previousSeatLimit: subscription.seatLimit,
              requestedSeatLimit: input.requestedSeatLimit,
              activeMemberCount,
              status
            }
          }
        });

        const summary = calculateSeatSummary(
          appliedSeatLimit,
          activeMemberCount
        );
        return {
          changeId: change.id,
          status,
          previousSeatLimit: subscription.seatLimit,
          requestedSeatLimit: input.requestedSeatLimit,
          activeMemberCount,
          availableSeats:
            status === "PENDING_CAPACITY" ? 0 : summary.availableSeats
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly now: Date;
  }): Promise<SeatLimitChangeResult> {
    return this.database.$transaction(
      async (transaction) => {
        const pendingChange = await transaction.subscriptionChange.findUnique({
          where: { id: input.changeId },
          include: { subscription: true }
        });
        if (!pendingChange || pendingChange.status !== "AWAITING_PAYMENT") {
          throw new AppError(
            "SEAT_INCREASE_NOT_PAYABLE",
            "適用できる増員申請が見つかりません。",
            409
          );
        }

        await transaction.$queryRaw(
          Prisma.sql`SELECT id FROM subscriptions WHERE id = ${pendingChange.subscriptionId}::uuid FOR UPDATE`
        );
        const subscription = await transaction.subscription.findUniqueOrThrow({
          where: { id: pendingChange.subscriptionId }
        });
        if (pendingChange.requestedSeatLimit <= subscription.seatLimit) {
          throw new AppError(
            "SEAT_INCREASE_STALE",
            "この増員申請は現在の契約へ適用できません。",
            409
          );
        }

        const [activeMemberCount, keywordCount] = await Promise.all([
          transaction.teamMembership.count({
            where: {
              teamId: subscription.teamId,
              role: "MEMBER",
              status: "ACTIVE"
            }
          }),
          transaction.teamKeyword.count({
            where: { teamId: subscription.teamId }
          })
        ]);

        await transaction.subscription.update({
          where: { id: subscription.id },
          data: {
            seatLimit: pendingChange.requestedSeatLimit,
            pendingSeatLimit: null,
            currentTermAmountYen: calculateAnnualPriceYen(
              pendingChange.requestedSeatLimit,
              keywordCount
            )
          }
        });
        await transaction.subscriptionChange.update({
          where: { id: pendingChange.id },
          data: { status: "APPLIED", appliedAt: input.now }
        });
        await replaceActiveInvitations(
          transaction,
          subscription.teamId,
          input.now
        );
        await transaction.auditEvent.create({
          data: {
            teamId: subscription.teamId,
            actorUserId: pendingChange.requestedByUserId,
            action: "SEAT_LIMIT_INCREASE_APPLIED",
            targetType: "SubscriptionChange",
            targetId: pendingChange.id,
            metadata: {
              previousSeatLimit: subscription.seatLimit,
              requestedSeatLimit: pendingChange.requestedSeatLimit,
              activeMemberCount
            }
          }
        });

        const summary = calculateSeatSummary(
          pendingChange.requestedSeatLimit,
          activeMemberCount
        );
        return {
          changeId: pendingChange.id,
          status: "APPLIED",
          previousSeatLimit: subscription.seatLimit,
          requestedSeatLimit: pendingChange.requestedSeatLimit,
          activeMemberCount,
          availableSeats: summary.availableSeats
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
}

function mapTeamContext(input: {
  readonly team: {
    readonly id: string;
    readonly publicCode: string;
    readonly name: string | null;
  };
  readonly membership: {
    readonly id: string;
    readonly role: "OWNER" | "MEMBER";
  };
  readonly subscription: {
    readonly seatLimit: number;
    readonly pendingSeatLimit: number | null;
    readonly currentTermAmountYen: number;
    readonly currentTermStartedAt: Date;
    readonly currentTermEndsAt: Date;
  };
  readonly activeMemberCount: number;
}): TeamContextRecord {
  return {
    teamId: input.team.id,
    teamCode: input.team.publicCode,
    teamName: input.team.name,
    membershipId: input.membership.id,
    role: input.membership.role,
    seatSummary: calculateSeatSummary(
      input.subscription.seatLimit,
      input.activeMemberCount
    ),
    pendingSeatLimit: input.subscription.pendingSeatLimit,
    currentTermAmountYen: input.subscription.currentTermAmountYen,
    currentTermStartedAt: input.subscription.currentTermStartedAt,
    currentTermEndsAt: input.subscription.currentTermEndsAt
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "P2002"
  ) {
    return false;
  }

  return JSON.stringify(
    (error as { readonly meta?: unknown }).meta ?? {}
  ).includes("publicCode");
}

async function replaceActiveInvitations(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date
): Promise<void> {
  const invitations = await transaction.invitation.findMany({
    where: { teamId, status: "ACTIVE" },
    select: { id: true }
  });
  const invitationIds = invitations.map(({ id }) => id);
  if (invitationIds.length === 0) {
    return;
  }
  await transaction.invitationLink.updateMany({
    where: { invitationId: { in: invitationIds }, status: "ACTIVE" },
    data: { status: "REPLACED", invalidatedAt: now }
  });
  await transaction.invitation.updateMany({
    where: { id: { in: invitationIds }, status: "ACTIVE" },
    data: {
      status: "REPLACED",
      invalidatedAt: now,
      invalidationNote: "SEAT_LIMIT_CHANGED"
    }
  });
}

async function revokeActiveInvitations(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date,
  note: string
): Promise<void> {
  const invitations = await transaction.invitation.findMany({
    where: { teamId, status: "ACTIVE" },
    select: { id: true }
  });
  const invitationIds = invitations.map(({ id }) => id);
  if (invitationIds.length === 0) {
    return;
  }
  await transaction.invitationLink.updateMany({
    where: { invitationId: { in: invitationIds }, status: "ACTIVE" },
    data: { status: "REVOKED", invalidatedAt: now }
  });
  await transaction.invitation.updateMany({
    where: { id: { in: invitationIds }, status: "ACTIVE" },
    data: {
      status: "REVOKED",
      invalidatedAt: now,
      invalidationNote: note
    }
  });
}
