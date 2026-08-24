import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { calculateSeatSummary } from "../teams/seat-policy.js";
import type {
  AuditEventRecord,
  InvitationLinkRecord,
  InvitationRecord,
  InvitationRepository,
  JoinResult,
  MemberRemovalResult,
  PublicInvitationRecord
} from "./invitation-repository.js";

export class PrismaInvitationRepository implements InvitationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async issuePasswordInvitation(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly passwordHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationRecord> {
    return this.database.$transaction(
      async (transaction) => {
        await requireOwner(transaction, input.teamId, input.actorUserId);
        const subscription = await lockSubscription(transaction, input.teamId);
        const activeMemberCount = await countActiveMembers(
          transaction,
          input.teamId
        );
        const summary = calculateSeatSummary(
          subscription.seatLimit,
          activeMemberCount
        );
        if (subscription.pendingSeatLimit !== null) {
          throw new AppError(
            "INVITATIONS_SUSPENDED",
            "契約人数の変更処理中のため、招待を発行できません。",
            409
          );
        }
        if (summary.availableSeats === 0) {
          throw invitationExhaustedError();
        }

        await expireStaleInvitations(transaction, input.teamId, input.now);
        await replaceActiveInvitations(transaction, input.teamId, input.now);
        const invitation = await transaction.invitation.create({
          data: {
            teamId: input.teamId,
            createdByUserId: input.actorUserId,
            passwordHash: input.passwordHash,
            maxUses: summary.availableSeats,
            usedCount: 0,
            expiresAt: input.expiresAt
          },
          include: { team: true }
        });
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.actorUserId,
            action: "INVITATION_ISSUED",
            targetType: "Invitation",
            targetId: invitation.id,
            metadata: { maxUses: summary.availableSeats }
          }
        });

        return mapInvitation({
          invitation,
          teamCode: invitation.team.publicCode,
          seatLimit: subscription.seatLimit,
          activeMemberCount,
          pendingSeatLimit: subscription.pendingSeatLimit
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async findPasswordInvitation(
    teamCode: string,
    now: Date
  ): Promise<InvitationRecord | null> {
    const teamIdentity = await this.database.team.findUnique({
      where: { publicCode: teamCode },
      select: { id: true, status: true }
    });
    if (!teamIdentity || teamIdentity.status !== "ACTIVE") {
      return null;
    }
    await this.database.$transaction((transaction) =>
      expireStaleInvitations(transaction, teamIdentity.id, now)
    );

    const team = await this.database.team.findUnique({
      where: { publicCode: teamCode },
      include: {
        subscription: true,
        invitations: {
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    });
    const invitation = team?.invitations[0];
    if (!team?.subscription || !invitation || team.status !== "ACTIVE") {
      return null;
    }
    const activeMemberCount = await this.database.teamMembership.count({
      where: { teamId: team.id, role: "MEMBER", status: "ACTIVE" }
    });
    return mapInvitation({
      invitation,
      teamCode: team.publicCode,
      seatLimit: team.subscription.seatLimit,
      activeMemberCount,
      pendingSeatLimit: team.subscription.pendingSeatLimit
    });
  }

  public async createInvitationLink(input: {
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<InvitationLinkRecord> {
    return this.database.$transaction(
      async (transaction) => {
        const invitationIdentity = await transaction.invitation.findUnique({
          where: { id: input.invitationId },
          include: { team: { include: { subscription: true } } }
        });
        if (!invitationIdentity?.team.subscription) {
          throw new AppError(
            "INVITATION_NOT_FOUND",
            "招待が見つかりません。",
            404
          );
        }
        await requireOwner(
          transaction,
          invitationIdentity.teamId,
          input.actorUserId
        );
        await expireStaleInvitations(
          transaction,
          invitationIdentity.teamId,
          input.now
        );
        const invitation = await transaction.invitation.findUniqueOrThrow({
          where: { id: input.invitationId },
          include: { team: { include: { subscription: true } } }
        });
        const subscription = await lockSubscription(
          transaction,
          invitation.teamId
        );
        const activeMemberCount = await countActiveMembers(
          transaction,
          invitation.teamId
        );
        if (
          invitation.status !== "ACTIVE" ||
          invitation.expiresAt <= input.now ||
          invitation.usedCount >= invitation.maxUses ||
          activeMemberCount >= subscription.seatLimit ||
          subscription.pendingSeatLimit !== null
        ) {
          throw invitationExhaustedError();
        }

        const link = await transaction.invitationLink.create({
          data: {
            invitationId: invitation.id,
            tokenHash: input.tokenHash,
            maxUses: 1,
            usedCount: 0,
            expiresAt: input.expiresAt
          }
        });
        await transaction.auditEvent.create({
          data: {
            teamId: invitation.teamId,
            actorUserId: input.actorUserId,
            action: "INVITATION_LINK_ISSUED",
            targetType: "InvitationLink",
            targetId: link.id,
            metadata: { expiresAt: link.expiresAt.toISOString(), maxUses: 1 }
          }
        });

        return {
          id: link.id,
          invitationId: invitation.id,
          status: link.status,
          maxUses: link.maxUses,
          usedCount: link.usedCount,
          expiresAt: link.expiresAt,
          invitation: mapInvitation({
            invitation,
            teamCode: invitation.team.publicCode,
            seatLimit: subscription.seatLimit,
            activeMemberCount,
            pendingSeatLimit: subscription.pendingSeatLimit
          })
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async findInvitationLink(
    tokenHash: string,
    now: Date
  ): Promise<InvitationLinkRecord | null> {
    const linkIdentity = await this.database.invitationLink.findUnique({
      where: { tokenHash },
      select: { invitation: { select: { teamId: true } } }
    });
    if (!linkIdentity) {
      return null;
    }
    await this.database.$transaction((transaction) =>
      expireStaleInvitations(transaction, linkIdentity.invitation.teamId, now)
    );

    const link = await this.database.invitationLink.findUnique({
      where: { tokenHash },
      include: {
        invitation: { include: { team: { include: { subscription: true } } } }
      }
    });
    if (!link?.invitation.team.subscription) {
      return null;
    }
    const activeMemberCount = await this.database.teamMembership.count({
      where: {
        teamId: link.invitation.teamId,
        role: "MEMBER",
        status: "ACTIVE"
      }
    });
    return {
      id: link.id,
      invitationId: link.invitationId,
      status: link.status,
      maxUses: link.maxUses,
      usedCount: link.usedCount,
      expiresAt: link.expiresAt,
      invitation: mapInvitation({
        invitation: link.invitation,
        teamCode: link.invitation.team.publicCode,
        seatLimit: link.invitation.team.subscription.seatLimit,
        activeMemberCount,
        pendingSeatLimit: link.invitation.team.subscription.pendingSeatLimit
      })
    };
  }

  public async createJoinGrant(input: {
    readonly secretHash: string;
    readonly invitationId: string;
    readonly linkId: string | null;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.database.authChallenge.create({
      data: {
        kind: "JOIN_GRANT",
        secretHash: input.secretHash,
        payload: {
          invitationId: input.invitationId,
          linkId: input.linkId
        },
        maxAttempts: 1,
        expiresAt: input.expiresAt
      }
    });
  }

  public async redeemJoinGrant(input: {
    readonly secretHash: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<JoinResult> {
    await expireJoinGrantInvitation(this.database, input.secretHash, input.now);
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const existingRedemption =
              await transaction.invitationRedemption.findUnique({
                where: { idempotencyKey: input.idempotencyKey },
                include: {
                  membership: {
                    include: { team: { include: { subscription: true } } }
                  }
                }
              });
            if (existingRedemption) {
              if (
                existingRedemption.userId !== input.userId ||
                existingRedemption.status !== "COMPLETED" ||
                !existingRedemption.membership?.team.subscription
              ) {
                throw new AppError(
                  "IDEMPOTENCY_KEY_CONFLICT",
                  "この参加処理は再利用できません。",
                  409
                );
              }
              const activeMemberCount = await countActiveMembers(
                transaction,
                existingRedemption.membership.teamId
              );
              return joinResult(
                existingRedemption.membership.team,
                existingRedemption.membership.id,
                activeMemberCount
              );
            }

            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash: input.secretHash }
            });
            const payload = parseJoinGrantPayload(challenge?.payload);
            if (
              !challenge ||
              challenge.kind !== "JOIN_GRANT" ||
              !payload ||
              challenge.consumedAt ||
              challenge.expiresAt <= input.now
            ) {
              throw invalidInvitationError();
            }

            const invitationBeforeLock =
              await transaction.invitation.findUnique({
                where: { id: payload.invitationId }
              });
            if (!invitationBeforeLock) {
              throw invalidInvitationError();
            }
            const subscription = await lockSubscription(
              transaction,
              invitationBeforeLock.teamId
            );
            const invitation = await transaction.invitation.findUniqueOrThrow({
              where: { id: payload.invitationId },
              include: { team: true }
            });
            const activeMemberCount = await countActiveMembers(
              transaction,
              invitation.teamId
            );
            if (
              invitation.status !== "ACTIVE" ||
              invitation.expiresAt <= input.now ||
              invitation.usedCount >= invitation.maxUses ||
              subscription.pendingSeatLimit !== null ||
              activeMemberCount >= subscription.seatLimit
            ) {
              throw invitationExhaustedError();
            }

            const link = payload.linkId
              ? await transaction.invitationLink.findUnique({
                  where: { id: payload.linkId }
                })
              : null;
            if (
              payload.linkId &&
              (!link ||
                link.invitationId !== invitation.id ||
                link.status !== "ACTIVE" ||
                link.expiresAt <= input.now ||
                link.usedCount >= link.maxUses)
            ) {
              throw invalidInvitationError();
            }

            const existingMembership =
              await transaction.teamMembership.findUnique({
                where: {
                  teamId_userId: {
                    teamId: invitation.teamId,
                    userId: input.userId
                  }
                }
              });
            if (existingMembership?.status === "ACTIVE") {
              throw new AppError(
                "ALREADY_TEAM_MEMBER",
                "すでにこのチームへ参加しています。",
                409
              );
            }

            const membership = await transaction.teamMembership.upsert({
              where: {
                teamId_userId: {
                  teamId: invitation.teamId,
                  userId: input.userId
                }
              },
              create: {
                teamId: invitation.teamId,
                userId: input.userId,
                role: "MEMBER",
                status: "ACTIVE",
                joinedAt: input.now
              },
              update: {
                role: "MEMBER",
                status: "ACTIVE",
                joinedAt: input.now,
                leftAt: null,
                removedAt: null,
                removedByUserId: null
              }
            });

            const nextUsedCount = invitation.usedCount + 1;
            const nextActiveMemberCount = activeMemberCount + 1;
            const invitationExhausted =
              nextUsedCount >= invitation.maxUses ||
              nextActiveMemberCount >= subscription.seatLimit;
            await transaction.invitation.update({
              where: { id: invitation.id },
              data: {
                usedCount: nextUsedCount,
                ...(invitationExhausted
                  ? {
                      status: "EXHAUSTED",
                      invalidatedAt: input.now,
                      invalidationNote: "CAPACITY_REACHED"
                    }
                  : {})
              }
            });
            if (link) {
              await transaction.invitationLink.update({
                where: { id: link.id },
                data: {
                  usedCount: 1,
                  status: "EXHAUSTED",
                  invalidatedAt: input.now
                }
              });
            }
            if (invitationExhausted) {
              await transaction.invitationLink.updateMany({
                where: { invitationId: invitation.id, status: "ACTIVE" },
                data: { status: "EXHAUSTED", invalidatedAt: input.now }
              });
            }

            await transaction.authChallenge.update({
              where: { id: challenge.id },
              data: { consumedAt: input.now, attemptCount: { increment: 1 } }
            });
            await transaction.invitationRedemption.create({
              data: {
                invitationId: invitation.id,
                linkId: link?.id ?? null,
                userId: input.userId,
                membershipId: membership.id,
                status: "COMPLETED",
                idempotencyKey: input.idempotencyKey,
                completedAt: input.now
              }
            });
            await transaction.auditEvent.create({
              data: {
                teamId: invitation.teamId,
                actorUserId: input.userId,
                action: "MEMBER_JOINED",
                targetType: "TeamMembership",
                targetId: membership.id,
                metadata: {
                  invitationId: invitation.id,
                  linkId: link?.id ?? null,
                  activeMemberCount: nextActiveMemberCount,
                  seatLimit: subscription.seatLimit
                }
              }
            });

            return joinResult(
              { ...invitation.team, subscription },
              membership.id,
              nextActiveMemberCount
            );
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "JOIN_TRANSACTION_CONFLICT",
          "参加処理が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async listInvitations(
    teamId: string,
    now: Date
  ): Promise<readonly PublicInvitationRecord[]> {
    await this.database.$transaction((transaction) =>
      expireStaleInvitations(transaction, teamId, now)
    );
    const invitations = await this.database.invitation.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    return invitations.map(publicInvitation);
  }

  public async revokeInvitation(input: {
    readonly teamId: string;
    readonly invitationId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await requireOwner(transaction, input.teamId, input.actorUserId);
      const result = await transaction.invitation.updateMany({
        where: {
          id: input.invitationId,
          teamId: input.teamId,
          status: "ACTIVE"
        },
        data: {
          status: "REVOKED",
          invalidatedAt: input.now,
          invalidationNote: "OWNER_REVOKED"
        }
      });
      if (result.count === 1) {
        await transaction.invitationLink.updateMany({
          where: { invitationId: input.invitationId, status: "ACTIVE" },
          data: { status: "REVOKED", invalidatedAt: input.now }
        });
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.actorUserId,
            action: "INVITATION_REVOKED",
            targetType: "Invitation",
            targetId: input.invitationId
          }
        });
      }
      return result.count === 1;
    });
  }

  public async revokeInvitationLink(input: {
    readonly teamId: string;
    readonly linkId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await requireOwner(transaction, input.teamId, input.actorUserId);
      const link = await transaction.invitationLink.findFirst({
        where: {
          id: input.linkId,
          status: "ACTIVE",
          invitation: { teamId: input.teamId }
        }
      });
      if (!link) {
        return false;
      }
      await transaction.invitationLink.update({
        where: { id: link.id },
        data: { status: "REVOKED", invalidatedAt: input.now }
      });
      await transaction.auditEvent.create({
        data: {
          teamId: input.teamId,
          actorUserId: input.actorUserId,
          action: "INVITATION_LINK_REVOKED",
          targetType: "InvitationLink",
          targetId: link.id
        }
      });
      return true;
    });
  }

  public async removeMemberAndReconcile(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly membershipId: string;
    readonly replacementPasswordHash: string;
    readonly invitationExpiresAt: Date;
    readonly now: Date;
  }): Promise<MemberRemovalResult> {
    return this.removeMembership({
      ...input,
      status: "REMOVED"
    });
  }

  public async leaveTeamAndReconcile(input: {
    readonly userId: string;
    readonly now: Date;
  }): Promise<MemberRemovalResult> {
    const membership = await this.database.teamMembership.findFirst({
      where: { userId: input.userId, status: "ACTIVE" }
    });
    if (!membership) {
      throw new AppError("TEAM_NOT_FOUND", "所属チームが見つかりません。", 404);
    }
    if (membership.role === "OWNER") {
      throw new AppError(
        "OWNER_TRANSFER_REQUIRED",
        "代表者は、代表者変更またはチーム解約を行ってから退会してください。",
        409
      );
    }
    return this.removeMembership({
      teamId: membership.teamId,
      actorUserId: input.userId,
      membershipId: membership.id,
      replacementPasswordHash: null,
      invitationExpiresAt: null,
      now: input.now,
      status: "LEFT"
    });
  }

  public async listAuditEvents(
    teamId: string
  ): Promise<readonly AuditEventRecord[]> {
    return this.database.auditEvent.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        action: true,
        actorUserId: true,
        targetType: true,
        targetId: true,
        metadata: true,
        createdAt: true
      }
    });
  }

  private async removeMembership(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly membershipId: string;
    readonly replacementPasswordHash: string | null;
    readonly invitationExpiresAt: Date | null;
    readonly now: Date;
    readonly status: "REMOVED" | "LEFT";
  }): Promise<MemberRemovalResult> {
    return this.database.$transaction(
      async (transaction) => {
        if (input.status === "REMOVED") {
          await requireOwner(transaction, input.teamId, input.actorUserId);
        }
        const subscription = await lockSubscription(transaction, input.teamId);
        const membership = await transaction.teamMembership.findFirst({
          where: {
            id: input.membershipId,
            teamId: input.teamId,
            role: "MEMBER",
            status: "ACTIVE"
          }
        });
        if (!membership) {
          throw new AppError(
            "MEMBER_NOT_FOUND",
            "削除できる追加メンバーが見つかりません。",
            404
          );
        }

        await transaction.teamMembership.update({
          where: { id: membership.id },
          data:
            input.status === "REMOVED"
              ? {
                  status: "REMOVED",
                  removedAt: input.now,
                  removedByUserId: input.actorUserId,
                  leftAt: null
                }
              : {
                  status: "LEFT",
                  leftAt: input.now,
                  removedAt: null,
                  removedByUserId: null
                }
        });
        await transaction.session.updateMany({
          where: { userId: membership.userId, revokedAt: null },
          data: { revokedAt: input.now }
        });
        await transaction.notificationTarget.updateMany({
          where: { membershipId: membership.id, status: "ACTIVE" },
          data: { status: "DISABLED", disabledAt: input.now }
        });

        const activeMemberCount = await countActiveMembers(
          transaction,
          input.teamId
        );
        let seatLimit = subscription.seatLimit;
        let pendingSeatLimitApplied = false;
        if (
          subscription.pendingSeatLimit !== null &&
          activeMemberCount <= subscription.pendingSeatLimit
        ) {
          seatLimit = subscription.pendingSeatLimit;
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

        await replaceActiveInvitations(transaction, input.teamId, input.now);
        const summary = calculateSeatSummary(seatLimit, activeMemberCount);
        let invitation = null;
        if (
          input.replacementPasswordHash &&
          input.invitationExpiresAt &&
          summary.availableSeats > 0
        ) {
          invitation = await transaction.invitation.create({
            data: {
              teamId: input.teamId,
              createdByUserId: input.actorUserId,
              passwordHash: input.replacementPasswordHash,
              maxUses: summary.availableSeats,
              expiresAt: input.invitationExpiresAt
            }
          });
        }

        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.actorUserId,
            action:
              input.status === "REMOVED" ? "MEMBER_REMOVED" : "MEMBER_LEFT",
            targetType: "TeamMembership",
            targetId: membership.id,
            metadata: {
              removedUserId: membership.userId,
              activeMemberCount,
              seatLimit,
              availableSeats: summary.availableSeats,
              pendingSeatLimitApplied
            }
          }
        });

        return {
          removedUserId: membership.userId,
          activeMemberCount,
          seatLimit,
          availableSeats: summary.availableSeats,
          pendingSeatLimitApplied,
          invitation: invitation ? publicInvitation(invitation) : null
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
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
      "この操作はチームの代表者だけが実行できます。",
      403
    );
  }
}

async function lockSubscription(
  transaction: Prisma.TransactionClient,
  teamId: string
) {
  const subscription = await transaction.subscription.findUnique({
    where: { teamId }
  });
  if (!subscription) {
    throw new AppError("SUBSCRIPTION_NOT_FOUND", "契約が見つかりません。", 404);
  }
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM subscriptions WHERE id = ${subscription.id}::uuid FOR UPDATE`
  );
  return transaction.subscription.findUniqueOrThrow({
    where: { id: subscription.id }
  });
}

async function countActiveMembers(
  transaction: Prisma.TransactionClient,
  teamId: string
): Promise<number> {
  return transaction.teamMembership.count({
    where: { teamId, role: "MEMBER", status: "ACTIVE" }
  });
}

async function expireJoinGrantInvitation(
  database: DatabaseClient,
  secretHash: string,
  now: Date
): Promise<void> {
  const challenge = await database.authChallenge.findUnique({
    where: { secretHash },
    select: { kind: true, payload: true }
  });
  const payload = parseJoinGrantPayload(challenge?.payload);
  if (challenge?.kind !== "JOIN_GRANT" || !payload) {
    return;
  }
  const invitation = await database.invitation.findUnique({
    where: { id: payload.invitationId },
    select: { teamId: true }
  });
  if (invitation) {
    await database.$transaction((transaction) =>
      expireStaleInvitations(transaction, invitation.teamId, now)
    );
  }
}

async function expireStaleInvitations(
  database: Prisma.TransactionClient,
  teamId: string,
  now: Date
): Promise<void> {
  const expiredInvitations = await database.invitation.findMany({
    where: { teamId, status: "ACTIVE", expiresAt: { lte: now } },
    select: { id: true }
  });
  const expiredInvitationIds = expiredInvitations.map(({ id }) => id);

  if (expiredInvitationIds.length > 0) {
    await database.invitationLink.updateMany({
      where: {
        invitationId: { in: expiredInvitationIds },
        status: "ACTIVE"
      },
      data: { status: "EXPIRED", invalidatedAt: now }
    });
    await database.invitation.updateMany({
      where: { id: { in: expiredInvitationIds }, status: "ACTIVE" },
      data: {
        status: "EXPIRED",
        invalidatedAt: now,
        invalidationNote: "TTL_EXPIRED"
      }
    });
  }

  await database.invitationLink.updateMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lte: now },
      invitation: { teamId }
    },
    data: { status: "EXPIRED", invalidatedAt: now }
  });
}

async function replaceActiveInvitations(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date
): Promise<void> {
  const activeInvitations = await transaction.invitation.findMany({
    where: { teamId, status: "ACTIVE" },
    select: { id: true }
  });
  const ids = activeInvitations.map(({ id }) => id);
  if (ids.length === 0) {
    return;
  }
  await transaction.invitationLink.updateMany({
    where: { invitationId: { in: ids }, status: "ACTIVE" },
    data: { status: "REPLACED", invalidatedAt: now }
  });
  await transaction.invitation.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "REPLACED",
      invalidatedAt: now,
      invalidationNote: "CAPACITY_CHANGED"
    }
  });
}

function mapInvitation(input: {
  readonly invitation: {
    readonly id: string;
    readonly teamId: string;
    readonly status: InvitationRecord["status"];
    readonly passwordHash: string;
    readonly maxUses: number;
    readonly usedCount: number;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  };
  readonly teamCode: string;
  readonly seatLimit: number;
  readonly activeMemberCount: number;
  readonly pendingSeatLimit: number | null;
}): InvitationRecord {
  return {
    id: input.invitation.id,
    teamId: input.invitation.teamId,
    teamCode: input.teamCode,
    status: input.invitation.status,
    passwordHash: input.invitation.passwordHash,
    maxUses: input.invitation.maxUses,
    usedCount: input.invitation.usedCount,
    expiresAt: input.invitation.expiresAt,
    createdAt: input.invitation.createdAt,
    seatLimit: input.seatLimit,
    activeMemberCount: input.activeMemberCount,
    pendingSeatLimit: input.pendingSeatLimit
  };
}

function publicInvitation(invitation: {
  readonly id: string;
  readonly status: PublicInvitationRecord["status"];
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}): PublicInvitationRecord {
  return {
    id: invitation.id,
    status: invitation.status,
    maxUses: invitation.maxUses,
    usedCount: invitation.usedCount,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt
  };
}

function parseJoinGrantPayload(
  value: Prisma.JsonValue | null | undefined
): { readonly invitationId: string; readonly linkId: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const invitationId = value.invitationId;
  const linkId = value.linkId;
  if (
    typeof invitationId !== "string" ||
    !(typeof linkId === "string" || linkId === null)
  ) {
    return null;
  }
  return { invitationId, linkId };
}

function joinResult(
  team: {
    readonly id: string;
    readonly publicCode: string;
    readonly subscription: { readonly seatLimit: number } | null;
  },
  membershipId: string,
  activeMemberCount: number
): JoinResult {
  if (!team.subscription) {
    throw new AppError("SUBSCRIPTION_NOT_FOUND", "契約が見つかりません。", 404);
  }
  const summary = calculateSeatSummary(
    team.subscription.seatLimit,
    activeMemberCount
  );
  return {
    teamId: team.id,
    teamCode: team.publicCode,
    membershipId,
    activeMemberCount,
    seatLimit: team.subscription.seatLimit,
    availableSeats: summary.availableSeats
  };
}

function invitationExhaustedError(): AppError {
  return new AppError(
    "INVITATION_EXHAUSTED",
    "この招待は利用上限に達しました。チームの代表者にお問い合わせください。",
    409
  );
}

function invalidInvitationError(): AppError {
  return new AppError(
    "INVITATION_INVALID_OR_EXPIRED",
    "招待情報が正しくないか、有効期限が切れています。",
    401
  );
}
