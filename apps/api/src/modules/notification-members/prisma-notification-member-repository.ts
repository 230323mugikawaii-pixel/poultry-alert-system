import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  NotificationMemberAuthentication,
  NotificationMemberListResult,
  NotificationMemberRecord,
  NotificationMemberRepository,
  NotificationMemberSeatSummary,
  NotificationMemberSessionRecord
} from "./notification-member-repository.js";

export class PrismaNotificationMemberRepository implements NotificationMemberRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(teamId: string): Promise<NotificationMemberListResult> {
    const [members, subscription, occupied] = await Promise.all([
      this.database.notificationMember.findMany({
        where: { teamId },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }]
      }),
      this.database.subscription.findUnique({ where: { teamId } }),
      countOccupiedAdditionalSeats(this.database, teamId)
    ]);
    if (!subscription) throw subscriptionNotFoundError();
    return {
      members: members.map(mapMember),
      seats: mapSeatSummary(subscription, occupied, members)
    };
  }

  public async create(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly callNowId: string;
    readonly displayName: string | null;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<NotificationMemberRecord> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              await requireOwner(transaction, input.teamId, input.actorUserId);
              const subscription = await lockSubscription(
                transaction,
                input.teamId
              );
              if (subscription.pendingSeatLimit !== null) {
                throw new AppError(
                  "SEAT_REDUCTION_PENDING",
                  "契約人数の変更中は通知メンバーを追加できません。",
                  409
                );
              }
              const occupied = await countOccupiedAdditionalSeats(
                transaction,
                input.teamId
              );
              if (occupied >= subscription.seatLimit) {
                throw new AppError(
                  "MEMBER_CAPACITY_REACHED",
                  "現在の利用人数上限に達しています。",
                  409
                );
              }
              const member = await transaction.notificationMember.create({
                data: {
                  teamId: input.teamId,
                  callNowId: input.callNowId,
                  displayName: input.displayName,
                  passwordHash: input.passwordHash,
                  passwordUpdatedAt: input.now
                }
              });
              await transaction.auditEvent.create({
                data: {
                  teamId: input.teamId,
                  actorUserId: input.actorUserId,
                  action: "NOTIFICATION_MEMBER_CREATED",
                  targetType: "NotificationMember",
                  targetId: member.id,
                  metadata: { callNowId: member.callNowId }
                }
              });
              return mapMember(member);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "MEMBER_CAPACITY_CONFLICT",
            "現在の利用人数上限に達しました。最新の状態を確認してください。",
            409
          )
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(
          "CALL_NOW_ID_CONFLICT",
          "Call Now IDの発行が競合しました。",
          409
        );
      }
      throw error;
    }
  }

  public async replacePassword(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<NotificationMemberRecord> {
    return this.database.$transaction(async (transaction) => {
      await requireOwner(transaction, input.teamId, input.actorUserId);
      const member = await transaction.notificationMember.findFirst({
        where: { id: input.memberId, teamId: input.teamId, status: "ACTIVE" }
      });
      if (!member) throw memberNotFoundError();
      const updated = await transaction.notificationMember.update({
        where: { id: member.id },
        data: { passwordHash: input.passwordHash, passwordUpdatedAt: input.now }
      });
      await transaction.notificationMemberSession.updateMany({
        where: { notificationMemberId: member.id, revokedAt: null },
        data: { revokedAt: input.now }
      });
      await transaction.auditEvent.create({
        data: {
          teamId: input.teamId,
          actorUserId: input.actorUserId,
          action: "NOTIFICATION_MEMBER_PASSWORD_RESET",
          targetType: "NotificationMember",
          targetId: member.id
        }
      });
      return mapMember(updated);
    });
  }

  public async disable(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<NotificationMemberListResult> {
    return this.database.$transaction(
      async (transaction) => {
        await requireOwner(transaction, input.teamId, input.actorUserId);
        const subscription = await lockSubscription(transaction, input.teamId);
        const member = await transaction.notificationMember.findFirst({
          where: { id: input.memberId, teamId: input.teamId, status: "ACTIVE" }
        });
        if (!member) throw memberNotFoundError();
        await transaction.notificationMember.update({
          where: { id: member.id },
          data: { status: "DISABLED", disabledAt: input.now }
        });
        await transaction.notificationMemberSession.updateMany({
          where: { notificationMemberId: member.id, revokedAt: null },
          data: { revokedAt: input.now }
        });
        const occupied = await countOccupiedAdditionalSeats(
          transaction,
          input.teamId
        );
        let seatLimit = subscription.seatLimit;
        let pendingSeatLimit = subscription.pendingSeatLimit;
        let pendingSeatLimitApplied = false;
        if (pendingSeatLimit !== null && occupied <= pendingSeatLimit) {
          seatLimit = pendingSeatLimit;
          pendingSeatLimit = null;
          pendingSeatLimitApplied = true;
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { seatLimit, pendingSeatLimit: null }
          });
          await transaction.subscriptionChange.updateMany({
            where: {
              subscriptionId: subscription.id,
              status: "PENDING_CAPACITY",
              requestedSeatLimit: seatLimit
            },
            data: { status: "APPLIED", appliedAt: input.now }
          });
        }
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.actorUserId,
            action: "NOTIFICATION_MEMBER_DISABLED",
            targetType: "NotificationMember",
            targetId: member.id,
            metadata: { pendingSeatLimitApplied }
          }
        });
        const members = await transaction.notificationMember.findMany({
          where: { teamId: input.teamId },
          orderBy: [{ status: "asc" }, { createdAt: "asc" }]
        });
        return {
          members: members.map(mapMember),
          seats: mapSeatSummary(
            { seatLimit, pendingSeatLimit },
            occupied,
            members
          )
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async findByCallNowId(
    callNowId: string
  ): Promise<NotificationMemberRecord | null> {
    const member = await this.database.notificationMember.findUnique({
      where: { callNowId }
    });
    return member ? mapMember(member) : null;
  }

  public async createSession(input: {
    readonly memberId: string;
    readonly tokenHash: string;
    readonly ipHash: string | null;
    readonly userAgentHash: string | null;
    readonly idleExpiresAt: Date;
    readonly expiresAt: Date;
    readonly maxActiveSessions: number;
    readonly now: Date;
  }): Promise<NotificationMemberSessionRecord> {
    return this.database.$transaction(async (transaction) => {
      const member = await transaction.notificationMember.findFirst({
        where: { id: input.memberId, status: "ACTIVE" },
        select: { id: true }
      });
      if (!member) throw unauthenticatedError();
      const session = await transaction.notificationMemberSession.create({
        data: {
          notificationMemberId: member.id,
          tokenHash: input.tokenHash,
          ipHash: input.ipHash,
          userAgentHash: input.userAgentHash,
          createdAt: input.now,
          lastSeenAt: input.now,
          idleExpiresAt: input.idleExpiresAt,
          expiresAt: input.expiresAt
        }
      });
      const retained = await transaction.notificationMemberSession.findMany({
        where: {
          notificationMemberId: member.id,
          revokedAt: null,
          expiresAt: { gt: input.now }
        },
        orderBy: { createdAt: "desc" },
        take: input.maxActiveSessions,
        select: { id: true }
      });
      await transaction.notificationMemberSession.updateMany({
        where: {
          notificationMemberId: member.id,
          revokedAt: null,
          id: { notIn: retained.map(({ id }) => id) }
        },
        data: { revokedAt: input.now }
      });
      return mapSession(session);
    });
  }

  public async findActiveSession(
    tokenHash: string,
    now: Date
  ): Promise<NotificationMemberAuthentication | null> {
    const session = await this.database.notificationMemberSession.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        expiresAt: { gt: now },
        notificationMember: { status: "ACTIVE", team: { status: "ACTIVE" } }
      },
      include: { notificationMember: { include: { team: true } } }
    });
    if (!session) return null;
    return {
      member: mapMember(session.notificationMember),
      session: mapSession(session),
      team: {
        id: session.notificationMember.team.id,
        publicCode: session.notificationMember.team.publicCode,
        name: session.notificationMember.team.name
      }
    };
  }

  public async touchSession(
    sessionId: string,
    lastSeenAt: Date,
    idleExpiresAt: Date
  ): Promise<void> {
    await this.database.notificationMemberSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt, idleExpiresAt }
    });
  }

  public async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.database.notificationMemberSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now }
    });
  }
}

async function requireOwner(
  transaction: Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<void> {
  const owner = await transaction.teamMembership.findFirst({
    where: { teamId, userId, role: "OWNER", status: "ACTIVE" },
    select: { id: true }
  });
  if (!owner) {
    throw new AppError(
      "OWNER_REQUIRED",
      "この操作は代表者だけが実行できます。",
      403
    );
  }
}

async function lockSubscription(
  transaction: Prisma.TransactionClient,
  teamId: string
) {
  const identity = await transaction.subscription.findUnique({
    where: { teamId },
    select: { id: true }
  });
  if (!identity) throw subscriptionNotFoundError();
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM subscriptions WHERE id = ${identity.id}::uuid FOR UPDATE`
  );
  return transaction.subscription.findUniqueOrThrow({
    where: { id: identity.id }
  });
}

export async function countOccupiedAdditionalSeats(
  database: Pick<DatabaseClient, "teamMembership" | "notificationMember">,
  teamId: string
): Promise<number> {
  const [accountMembers, notificationMembers] = await Promise.all([
    database.teamMembership.count({
      where: { teamId, role: "MEMBER", status: "ACTIVE" }
    }),
    database.notificationMember.count({ where: { teamId, status: "ACTIVE" } })
  ]);
  return accountMembers + notificationMembers;
}

function mapSeatSummary(
  subscription: {
    readonly seatLimit: number;
    readonly pendingSeatLimit: number | null;
  },
  occupiedAdditionalSeats: number,
  members: readonly { readonly status: "ACTIVE" | "DISABLED" }[]
): NotificationMemberSeatSummary {
  return {
    seatCount: 1 + subscription.seatLimit,
    additionalSeatLimit: subscription.seatLimit,
    activeNotificationMemberCount: members.filter(
      ({ status }) => status === "ACTIVE"
    ).length,
    occupiedAdditionalSeats,
    availableSeats: Math.max(
      subscription.seatLimit - occupiedAdditionalSeats,
      0
    ),
    pendingSeatCount:
      subscription.pendingSeatLimit === null
        ? null
        : 1 + subscription.pendingSeatLimit
  };
}

function mapMember(member: {
  readonly id: string;
  readonly teamId: string;
  readonly callNowId: string;
  readonly displayName: string | null;
  readonly passwordHash: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}): NotificationMemberRecord {
  return { ...member };
}

function mapSession(session: {
  readonly id: string;
  readonly notificationMemberId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}): NotificationMemberSessionRecord {
  return { ...session };
}

function subscriptionNotFoundError(): AppError {
  return new AppError("SUBSCRIPTION_NOT_FOUND", "契約が見つかりません。", 404);
}

function memberNotFoundError(): AppError {
  return new AppError(
    "NOTIFICATION_MEMBER_NOT_FOUND",
    "通知メンバーが見つかりません。",
    404
  );
}

function unauthenticatedError(): AppError {
  return new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}
