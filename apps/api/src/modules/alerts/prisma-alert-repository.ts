import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult,
  NotificationCenterDeletionItem,
  NotificationCenterDeletionResult
} from "./alert-repository.js";

const alertInclude = {
  sourceMailConnection: {
    select: { mailAuthorization: { select: { provider: true } } }
  },
  acknowledgedByUser: { select: { displayName: true } },
  acknowledgedByNotificationMember: { select: { displayName: true } },
  _count: { select: { recipients: true } }
} satisfies Prisma.AlertInclude;

type AlertWithSource = Prisma.AlertGetPayload<{ include: typeof alertInclude }>;

export class PrismaAlertRepository implements AlertRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly kind: "REAL" | "TEST";
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly actorUserId?: string;
    readonly notificationTestId?: string;
    readonly now: Date;
  }): Promise<AlertIngestionResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const connections = await transaction.$queryRaw<
              Array<{ id: string }>
            >(
              Prisma.sql`
                SELECT mail_connection.id
                FROM mail_connections AS mail_connection
                JOIN teams AS team ON team.id = mail_connection."teamId"
                JOIN mail_authorizations AS mail_authorization
                  ON mail_authorization.id = mail_connection."mailAuthorizationId"
                WHERE mail_connection.id = ${input.sourceMailConnectionId}::uuid
                  AND mail_connection."teamId" = ${input.teamId}::uuid
                  AND mail_connection.status = 'ACTIVE'
                  AND mail_authorization.status = 'ACTIVE'
                  AND team.status = 'ACTIVE'
                FOR UPDATE OF mail_connection
              `
            );
            if (connections.length !== 1) {
              throw new AppError(
                "MAIL_CONNECTION_NOT_ACTIVE",
                "有効なメール監視接続が見つかりません。",
                409
              );
            }

            const existing = await transaction.alert.findUnique({
              where: {
                sourceMailConnectionId_sourceEventId: {
                  sourceMailConnectionId: input.sourceMailConnectionId,
                  sourceEventId: input.sourceEventId
                }
              },
              include: alertInclude
            });
            if (existing) {
              return { alert: mapAlert(existing, null), created: false };
            }

            const [owners, members] = await Promise.all([
              transaction.teamMembership.findMany({
                where: {
                  teamId: input.teamId,
                  role: "OWNER",
                  status: "ACTIVE"
                },
                select: { userId: true }
              }),
              transaction.notificationMember.findMany({
                where: {
                  teamId: input.teamId,
                  status: "ACTIVE",
                  deletedAt: null
                },
                select: { id: true }
              })
            ]);
            if (owners.length !== 1) {
              throw new AppError(
                "TEAM_OWNER_UNAVAILABLE",
                "通知先を準備できませんでした。",
                409
              );
            }

            const created = await transaction.alert.create({
              data: {
                teamId: input.teamId,
                sourceMailConnectionId: input.sourceMailConnectionId,
                sourceEventId: input.sourceEventId,
                kind: input.kind,
                matchedKeyword: input.matchedKeyword,
                detectedAt: input.detectedAt,
                recipients: {
                  create: [
                    {
                      kind: "OWNER",
                      userId: owners[0]!.userId,
                      channel: "IN_APP"
                    },
                    ...members.map(({ id }) => ({
                      kind: "NOTIFICATION_MEMBER" as const,
                      notificationMemberId: id,
                      channel: "IN_APP" as const
                    }))
                  ]
                }
              },
              include: alertInclude
            });
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                ...(input.actorUserId
                  ? { actorUserId: input.actorUserId }
                  : {}),
                action:
                  input.kind === "TEST"
                    ? "TEST_ALERT_CREATED"
                    : "ALERT_CREATED",
                targetType: "Alert",
                targetId: created.id,
                metadata: {
                  sourceMailConnectionId: input.sourceMailConnectionId,
                  ...(input.notificationTestId
                    ? { notificationTestId: input.notificationTestId }
                    : {}),
                  recipientCount: created._count.recipients
                }
              }
            });
            return { alert: mapAlert(created, null), created: true };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "ALERT_INGESTION_CONFLICT",
          "検知イベントの登録が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async listForOwner(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly AlertRecord[]> {
    const alerts = await this.database.alert.findMany({
      where: {
        teamId: input.teamId,
        recipients: {
          some: {
            kind: "OWNER",
            userId: input.userId,
            channel: "IN_APP",
            dismissedAt: null
          }
        }
      },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      include: alertInclude
    });
    const recipients = await this.database.alertRecipient.findMany({
      where: {
        alertId: { in: alerts.map(({ id }) => id) },
        kind: "OWNER",
        userId: input.userId,
        channel: "IN_APP",
        dismissedAt: null
      },
      select: { alertId: true, readAt: true }
    });
    const readAtByAlertId = new Map(
      recipients.map(({ alertId, readAt }) => [alertId, readAt])
    );
    return alerts.map((alert) =>
      mapAlert(alert, readAtByAlertId.get(alert.id) ?? null)
    );
  }

  public async listForNotificationMember(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly limit: number;
  }): Promise<readonly AlertRecord[]> {
    const alerts = await this.database.alert.findMany({
      where: {
        teamId: input.teamId,
        recipients: {
          some: {
            kind: "NOTIFICATION_MEMBER",
            notificationMemberId: input.memberId,
            channel: "IN_APP",
            dismissedAt: null
          }
        }
      },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      include: alertInclude
    });
    const recipients = await this.database.alertRecipient.findMany({
      where: {
        alertId: { in: alerts.map(({ id }) => id) },
        kind: "NOTIFICATION_MEMBER",
        notificationMemberId: input.memberId,
        channel: "IN_APP",
        dismissedAt: null
      },
      select: { alertId: true, readAt: true }
    });
    const readAtByAlertId = new Map(
      recipients.map(({ alertId, readAt }) => [alertId, readAt])
    );
    return alerts.map((alert) =>
      mapAlert(alert, readAtByAlertId.get(alert.id) ?? null)
    );
  }

  public acknowledgeByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertAcknowledgementResult> {
    return this.acknowledge({ ...input, kind: "OWNER" });
  }

  public acknowledgeByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
    readonly now: Date;
  }): Promise<AlertAcknowledgementResult> {
    return this.acknowledge({ ...input, kind: "NOTIFICATION_MEMBER" });
  }

  public markReadByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertRecord> {
    return this.markRead({ ...input, kind: "OWNER" });
  }

  public markReadByNotificationMember(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly memberId: string;
    readonly now: Date;
  }): Promise<AlertRecord> {
    return this.markRead({ ...input, kind: "NOTIFICATION_MEMBER" });
  }

  public dismissOwnerNotifications(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly items: readonly NotificationCenterDeletionItem[];
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<NotificationCenterDeletionResult> {
    return this.database.$transaction(async (transaction) => {
      const alertIds = input.items
        .filter(({ type }) => type === "ALERT")
        .map(({ id }) => id);
      const notificationIds = input.items
        .filter(({ type }) => type === "USER_NOTIFICATION")
        .map(({ id }) => id);

      const [alertRecipients, notifications] = await Promise.all([
        alertIds.length
          ? transaction.alertRecipient.findMany({
              where: {
                alertId: { in: alertIds },
                kind: "OWNER",
                userId: input.userId,
                channel: "IN_APP",
                alert: { teamId: input.teamId }
              },
              select: {
                id: true,
                alertId: true,
                dismissedAt: true
              }
            })
          : Promise.resolve([]),
        notificationIds.length
          ? transaction.userNotification.findMany({
              where: { id: { in: notificationIds }, userId: input.userId },
              select: { id: true, deletedAt: true }
            })
          : Promise.resolve([])
      ]);

      if (
        alertRecipients.length !== alertIds.length ||
        notifications.length !== notificationIds.length
      ) {
        throw notificationNotFoundError();
      }
      const [dismissedAlerts, deletedNotifications] = await Promise.all([
        transaction.alertRecipient.updateMany({
          where: {
            id: { in: alertRecipients.map(({ id }) => id) },
            dismissedAt: null
          },
          data: { dismissedAt: input.now }
        }),
        transaction.userNotification.updateMany({
          where: {
            id: { in: notifications.map(({ id }) => id) },
            deletedAt: null
          },
          data: { deletedAt: input.now }
        })
      ]);
      const deletedCount = dismissedAlerts.count + deletedNotifications.count;
      if (deletedCount > 0) {
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.userId,
            action: "NOTIFICATION_CENTER_ITEMS_DISMISSED",
            targetType: "NotificationCenter",
            requestId: input.requestId,
            metadata: {
              actorType: "OWNER",
              alertCount: dismissedAlerts.count,
              userNotificationCount: deletedNotifications.count,
              totalCount: deletedCount
            }
          }
        });
      }
      return {
        items: input.items,
        deletedCount,
        alreadyDeletedCount: input.items.length - deletedCount
      };
    });
  }

  public dismissNotificationMemberAlerts(input: {
    readonly teamId: string;
    readonly memberId: string;
    readonly alertIds: readonly string[];
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<NotificationCenterDeletionResult> {
    return this.database.$transaction(async (transaction) => {
      const recipients = await transaction.alertRecipient.findMany({
        where: {
          alertId: { in: [...input.alertIds] },
          kind: "NOTIFICATION_MEMBER",
          notificationMemberId: input.memberId,
          channel: "IN_APP",
          alert: { teamId: input.teamId }
        },
        select: {
          id: true,
          alertId: true,
          dismissedAt: true
        }
      });
      if (recipients.length !== input.alertIds.length) {
        throw notificationNotFoundError();
      }
      const dismissed = await transaction.alertRecipient.updateMany({
        where: {
          id: { in: recipients.map(({ id }) => id) },
          dismissedAt: null
        },
        data: { dismissedAt: input.now }
      });
      if (dismissed.count > 0) {
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            action: "NOTIFICATION_CENTER_ITEMS_DISMISSED",
            targetType: "NotificationCenter",
            requestId: input.requestId,
            metadata: {
              actorType: "NOTIFICATION_MEMBER",
              alertCount: dismissed.count,
              userNotificationCount: 0,
              totalCount: dismissed.count
            }
          }
        });
      }
      return {
        items: input.alertIds.map((id) => ({ type: "ALERT", id })),
        deletedCount: dismissed.count,
        alreadyDeletedCount: input.alertIds.length - dismissed.count
      };
    });
  }

  public async resolveByOwner(input: {
    readonly teamId: string;
    readonly alertId: string;
    readonly userId: string;
    readonly now: Date;
  }): Promise<AlertResolutionResult> {
    return this.database.$transaction(async (transaction) => {
      const recipient = await transaction.alertRecipient.findFirst({
        where: {
          alertId: input.alertId,
          kind: "OWNER",
          userId: input.userId,
          alert: { teamId: input.teamId }
        },
        select: { id: true, readAt: true }
      });
      if (!recipient) throw alertNotFoundError();
      const resolved = await transaction.alert.updateMany({
        where: {
          id: input.alertId,
          teamId: input.teamId,
          status: { not: "RESOLVED" }
        },
        data: { status: "RESOLVED", resolvedAt: input.now }
      });
      if (resolved.count === 1) {
        await transaction.alertRecipient.updateMany({
          where: { alertId: input.alertId, status: { not: "CLOSED" } },
          data: { status: "CLOSED" }
        });
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.userId,
            action: "ALERT_RESOLVED",
            targetType: "Alert",
            targetId: input.alertId
          }
        });
      }
      return {
        alert: await findAlertOrThrow(
          transaction,
          input.alertId,
          input.teamId,
          recipient.readAt
        ),
        alreadyResolved: resolved.count === 0
      };
    });
  }

  private markRead(
    input:
      | {
          readonly kind: "OWNER";
          readonly teamId: string;
          readonly alertId: string;
          readonly userId: string;
          readonly now: Date;
        }
      | {
          readonly kind: "NOTIFICATION_MEMBER";
          readonly teamId: string;
          readonly alertId: string;
          readonly memberId: string;
          readonly now: Date;
        }
  ): Promise<AlertRecord> {
    return this.database.$transaction(async (transaction) => {
      const actorWhere =
        input.kind === "OWNER"
          ? { kind: "OWNER" as const, userId: input.userId }
          : {
              kind: "NOTIFICATION_MEMBER" as const,
              notificationMemberId: input.memberId
            };
      const recipient = await transaction.alertRecipient.findFirst({
        where: {
          alertId: input.alertId,
          ...actorWhere,
          channel: "IN_APP",
          dismissedAt: null,
          alert: { teamId: input.teamId }
        },
        select: { id: true, readAt: true }
      });
      if (!recipient) throw alertNotFoundError();

      if (!recipient.readAt) {
        await transaction.alertRecipient.update({
          where: { id: recipient.id },
          data: { readAt: input.now }
        });
      }
      return findAlertOrThrow(
        transaction,
        input.alertId,
        input.teamId,
        recipient.readAt ?? input.now
      );
    });
  }

  private acknowledge(
    input:
      | {
          readonly kind: "OWNER";
          readonly teamId: string;
          readonly alertId: string;
          readonly userId: string;
          readonly now: Date;
        }
      | {
          readonly kind: "NOTIFICATION_MEMBER";
          readonly teamId: string;
          readonly alertId: string;
          readonly memberId: string;
          readonly now: Date;
        }
  ): Promise<AlertAcknowledgementResult> {
    return this.database.$transaction(async (transaction) => {
      const actorWhere =
        input.kind === "OWNER"
          ? { kind: "OWNER" as const, userId: input.userId }
          : {
              kind: "NOTIFICATION_MEMBER" as const,
              notificationMemberId: input.memberId
            };
      const recipient = await transaction.alertRecipient.findFirst({
        where: {
          alertId: input.alertId,
          ...actorWhere,
          alert: { teamId: input.teamId }
        },
        select: { id: true, readAt: true }
      });
      if (!recipient) throw alertNotFoundError();

      const acknowledged = await transaction.alert.updateMany({
        where: {
          id: input.alertId,
          teamId: input.teamId,
          status: "ACTIVE"
        },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedAt: input.now,
          ...(input.kind === "OWNER"
            ? { acknowledgedByUserId: input.userId }
            : { acknowledgedByNotificationMemberId: input.memberId })
        }
      });
      if (acknowledged.count === 1) {
        await transaction.alertRecipient.updateMany({
          where: { alertId: input.alertId, status: "PENDING" },
          data: { status: "ACKNOWLEDGED" }
        });
        await transaction.alertRecipient.update({
          where: { id: recipient.id },
          data: { acknowledgedAt: input.now }
        });
        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            ...(input.kind === "OWNER" ? { actorUserId: input.userId } : {}),
            action: "ALERT_ACKNOWLEDGED",
            targetType: "Alert",
            targetId: input.alertId,
            metadata:
              input.kind === "OWNER"
                ? { actorKind: "OWNER" }
                : {
                    actorKind: "NOTIFICATION_MEMBER",
                    notificationMemberId: input.memberId
                  }
          }
        });
      }
      return {
        alert: await findAlertOrThrow(
          transaction,
          input.alertId,
          input.teamId,
          recipient.readAt
        ),
        alreadyAcknowledged: acknowledged.count === 0
      };
    });
  }
}

async function findAlertOrThrow(
  transaction: Prisma.TransactionClient,
  alertId: string,
  teamId: string,
  readAt: Date | null = null
): Promise<AlertRecord> {
  const alert = await transaction.alert.findFirst({
    where: { id: alertId, teamId },
    include: alertInclude
  });
  if (!alert) throw alertNotFoundError();
  return mapAlert(alert, readAt);
}

function mapAlert(alert: AlertWithSource, readAt: Date | null): AlertRecord {
  return {
    id: alert.id,
    teamId: alert.teamId,
    sourceMailConnectionId: alert.sourceMailConnectionId,
    sourceProvider: alert.sourceMailConnection.mailAuthorization.provider,
    kind: alert.kind,
    status: alert.status,
    detectedAt: alert.detectedAt,
    matchedKeyword: alert.matchedKeyword,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedBy: alert.acknowledgedByUserId
      ? "OWNER"
      : alert.acknowledgedByNotificationMemberId
        ? "NOTIFICATION_MEMBER"
        : null,
    acknowledgedByName: alert.acknowledgedByUserId
      ? alert.acknowledgedByUser?.displayName || "代表者"
      : alert.acknowledgedByNotificationMemberId
        ? alert.acknowledgedByNotificationMember?.displayName || "通知メンバー"
        : null,
    readAt,
    resolvedAt: alert.resolvedAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    recipientCount: alert._count.recipients
  };
}

function alertNotFoundError(): AppError {
  return new AppError("ALERT_NOT_FOUND", "通知が見つかりません。", 404);
}

function notificationNotFoundError(): AppError {
  return new AppError(
    "NOTIFICATION_NOT_FOUND",
    "削除するお知らせが見つかりません。",
    404
  );
}
