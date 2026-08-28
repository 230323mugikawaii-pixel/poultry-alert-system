import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { countOccupiedAdditionalSeats } from "../notification-members/prisma-notification-member-repository.js";
import {
  calculateAnnualPriceYen,
  calculateSeatSummary
} from "./seat-policy.js";
import type {
  CreateTeamInput,
  InvitationDraft,
  IssuedInvitationRecord,
  SeatLimitChangeResult,
  TeamCreationResult,
  TeamContextRecord,
  TeamMemberRecord,
  TeamRepository
} from "./team-repository.js";

export class PrismaTeamRepository implements TeamRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createTeam(input: CreateTeamInput): Promise<TeamCreationResult> {
    if (input.seatLimit > 0 && !input.initialInvitation) {
      throw new Error("initial_invitation_required");
    }
    try {
      return await this.database.$transaction(
        (transaction) => createTeamInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError("TEAM_CODE_CONFLICT", "Team code collision.", 409);
      }
      throw error;
    }
  }

  public async ensureInitialTeam(
    input: CreateTeamInput
  ): Promise<TeamContextRecord> {
    if (input.seatLimit !== 0 || input.initialInvitation) {
      throw new Error("initial_team_must_not_include_member_capacity");
    }
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const lockedUsers = await transaction.$queryRaw<
                Array<{ id: string }>
              >(
                Prisma.sql`SELECT id FROM users WHERE id = ${input.ownerUserId}::uuid FOR UPDATE`
              );
              if (lockedUsers.length !== 1) {
                throw new AppError(
                  "USER_NOT_FOUND",
                  "利用者情報が見つかりません。",
                  404
                );
              }

              const existing = await findCurrentTeam(
                transaction,
                input.ownerUserId
              );
              if (existing) {
                return existing;
              }

              const previousMemberships =
                await transaction.teamMembership.count({
                  where: { userId: input.ownerUserId }
                });
              if (previousMemberships > 0) {
                throw new AppError(
                  "INITIAL_TEAM_NOT_AVAILABLE",
                  "現在利用できる契約がありません。管理者へお問い合わせください。",
                  409
                );
              }

              return (await createTeamInTransaction(transaction, input)).team;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "INITIAL_TEAM_BOOTSTRAP_CONFLICT",
            "初期設定が競合しました。もう一度お試しください。",
            409
          )
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
    return findCurrentTeam(this.database, userId);
  }

  public async findTeamForUser(
    userId: string,
    teamId: string
  ): Promise<TeamContextRecord | null> {
    const membership = await this.database.teamMembership.findFirst({
      where: {
        userId,
        teamId,
        status: "ACTIVE",
        team: { status: "ACTIVE" }
      },
      include: {
        team: { include: { subscription: true } }
      }
    });
    if (!membership?.team.subscription) {
      return null;
    }

    const activeMemberCount = await countOccupiedAdditionalSeats(
      this.database,
      teamId
    );
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
    readonly replacementInvitation: InvitationDraft | null;
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
        const activeMemberCount = await countOccupiedAdditionalSeats(
          transaction,
          input.teamId
        );

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
        let invitation: IssuedInvitationRecord | null = null;

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
          const availableSeats = Math.max(
            input.requestedSeatLimit - activeMemberCount,
            0
          );
          if (availableSeats > 0 && !input.replacementInvitation) {
            throw new Error("replacement_invitation_required");
          }
          if (availableSeats > 0 && input.replacementInvitation) {
            invitation = await createInvitation(transaction, {
              teamId: input.teamId,
              actorUserId: input.requestedByUserId,
              maxUses: availableSeats,
              draft: input.replacementInvitation,
              now: input.now,
              auditAction: "INVITATION_ISSUED_AFTER_SEAT_CHANGE"
            });
          }
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
            status === "PENDING_CAPACITY" ? 0 : summary.availableSeats,
          invitation
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly paymentEventId: string;
    readonly now: Date;
    readonly invitation: InvitationDraft;
  }): Promise<SeatLimitChangeResult> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const changeIdentity =
                await transaction.subscriptionChange.findUnique({
                  where: { id: input.changeId },
                  select: { subscriptionId: true }
                });
              if (!changeIdentity) {
                throw seatIncreaseNotPayableError();
              }

              await transaction.$queryRaw(
                Prisma.sql`SELECT id FROM subscriptions WHERE id = ${changeIdentity.subscriptionId}::uuid FOR UPDATE`
              );
              const change =
                await transaction.subscriptionChange.findUniqueOrThrow({
                  where: { id: input.changeId },
                  include: {
                    subscription: true,
                    issuedInvitation: true
                  }
                });
              const subscription = change.subscription;
              const activeMemberCount = await countOccupiedAdditionalSeats(
                transaction,
                subscription.teamId
              );

              if (change.status === "APPLIED") {
                if (
                  change.paymentEventId !== input.paymentEventId ||
                  !change.issuedInvitation
                ) {
                  throw new AppError(
                    "PAYMENT_EVENT_CONFLICT",
                    "この決済イベントは別の増員処理に使用されています。",
                    409
                  );
                }
                const summary = calculateSeatSummary(
                  subscription.seatLimit,
                  activeMemberCount
                );
                return {
                  changeId: change.id,
                  status: "APPLIED" as const,
                  previousSeatLimit: change.previousSeatLimit,
                  requestedSeatLimit: change.requestedSeatLimit,
                  activeMemberCount,
                  availableSeats: summary.availableSeats,
                  invitation: publicIssuedInvitation(change.issuedInvitation)
                };
              }
              if (change.status !== "AWAITING_PAYMENT") {
                throw seatIncreaseNotPayableError();
              }

              const eventOwner =
                await transaction.subscriptionChange.findUnique({
                  where: { paymentEventId: input.paymentEventId },
                  select: { id: true }
                });
              if (eventOwner && eventOwner.id !== change.id) {
                throw new AppError(
                  "PAYMENT_EVENT_CONFLICT",
                  "この決済イベントは別の増員処理に使用されています。",
                  409
                );
              }
              if (change.requestedSeatLimit <= subscription.seatLimit) {
                throw new AppError(
                  "SEAT_INCREASE_STALE",
                  "この増員申請は現在の契約へ適用できません。",
                  409
                );
              }

              const keywordCount = await transaction.teamKeyword.count({
                where: { teamId: subscription.teamId }
              });
              const summary = calculateSeatSummary(
                change.requestedSeatLimit,
                activeMemberCount
              );
              await replaceActiveInvitations(
                transaction,
                subscription.teamId,
                input.now
              );
              const invitation = await createInvitation(transaction, {
                teamId: subscription.teamId,
                actorUserId: change.requestedByUserId,
                maxUses: summary.availableSeats,
                draft: input.invitation,
                now: input.now,
                auditAction: "INVITATION_ISSUED_AFTER_PAID_INCREASE"
              });
              await transaction.subscription.update({
                where: { id: subscription.id },
                data: {
                  seatLimit: change.requestedSeatLimit,
                  pendingSeatLimit: null,
                  currentTermAmountYen: calculateAnnualPriceYen(
                    change.requestedSeatLimit,
                    keywordCount
                  )
                }
              });
              await transaction.subscriptionChange.update({
                where: { id: change.id },
                data: {
                  status: "APPLIED",
                  appliedAt: input.now,
                  paymentEventId: input.paymentEventId,
                  issuedInvitationId: invitation.id
                }
              });
              await transaction.auditEvent.create({
                data: {
                  teamId: subscription.teamId,
                  actorUserId: change.requestedByUserId,
                  action: "SEAT_LIMIT_INCREASE_APPLIED",
                  targetType: "SubscriptionChange",
                  targetId: change.id,
                  metadata: {
                    paymentEventId: input.paymentEventId,
                    previousSeatLimit: subscription.seatLimit,
                    requestedSeatLimit: change.requestedSeatLimit,
                    activeMemberCount,
                    invitationId: invitation.id,
                    invitationMaxUses: invitation.maxUses
                  }
                }
              });

              return {
                changeId: change.id,
                status: "APPLIED" as const,
                previousSeatLimit: subscription.seatLimit,
                requestedSeatLimit: change.requestedSeatLimit,
                activeMemberCount,
                availableSeats: summary.availableSeats,
                invitation
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "SEAT_INCREASE_TRANSACTION_CONFLICT",
            "増員処理が競合しました。決済イベントを再送してください。",
            409
          )
      );
    } catch (error) {
      if (isPaymentEventUniqueConstraintError(error)) {
        throw new AppError(
          "PAYMENT_EVENT_CONFLICT",
          "この決済イベントは別の増員処理に使用されています。",
          409
        );
      }
      throw error;
    }
  }
}

type TeamDatabase = DatabaseClient | Prisma.TransactionClient;

async function findCurrentTeam(
  database: TeamDatabase,
  userId: string
): Promise<TeamContextRecord | null> {
  const membership = await database.teamMembership.findFirst({
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

  const activeMemberCount = await countOccupiedAdditionalSeats(
    database,
    membership.teamId
  );

  return mapTeamContext({
    team: membership.team,
    membership,
    subscription: membership.team.subscription,
    activeMemberCount
  });
}

async function createTeamInTransaction(
  transaction: Prisma.TransactionClient,
  input: CreateTeamInput
): Promise<TeamCreationResult> {
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

  const invitation =
    input.initialInvitation && input.seatLimit > 0
      ? await createInvitation(transaction, {
          teamId: team.id,
          actorUserId: input.ownerUserId,
          maxUses: input.seatLimit,
          draft: input.initialInvitation,
          now: input.currentTermStartedAt,
          auditAction: "INITIAL_INVITATION_ISSUED"
        })
      : null;

  return {
    team: mapTeamContext({
      team,
      membership,
      subscription: team.subscription,
      activeMemberCount: 0
    }),
    invitation
  };
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
    readonly status: "ACTIVE" | "PAST_DUE" | "CANCELED";
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
    subscriptionStatus: input.subscription.status,
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

function isPaymentEventUniqueConstraintError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "P2002"
  ) {
    return false;
  }
  return JSON.stringify(
    (error as { readonly meta?: unknown }).meta ?? {}
  ).includes("paymentEventId");
}

function seatIncreaseNotPayableError(): AppError {
  return new AppError(
    "SEAT_INCREASE_NOT_PAYABLE",
    "適用できる増員申請が見つかりません。",
    409
  );
}

async function createInvitation(
  transaction: Prisma.TransactionClient,
  input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly maxUses: number;
    readonly draft: InvitationDraft;
    readonly now: Date;
    readonly auditAction: string;
  }
): Promise<IssuedInvitationRecord> {
  if (input.maxUses < 1) {
    throw new Error("invitation_requires_available_seat");
  }
  const invitation = await transaction.invitation.create({
    data: {
      teamId: input.teamId,
      createdByUserId: input.actorUserId,
      passwordHash: input.draft.passwordHash,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt: input.draft.expiresAt
    }
  });
  await transaction.auditEvent.create({
    data: {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: input.auditAction,
      targetType: "Invitation",
      targetId: invitation.id,
      metadata: { maxUses: input.maxUses }
    }
  });
  return publicIssuedInvitation(invitation);
}

function publicIssuedInvitation(invitation: {
  readonly id: string;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}): IssuedInvitationRecord {
  return {
    id: invitation.id,
    maxUses: invitation.maxUses,
    usedCount: invitation.usedCount,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt
  };
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
