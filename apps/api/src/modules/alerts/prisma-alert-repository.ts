import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult
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
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
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
              return { alert: mapAlert(existing), created: false };
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
                action: "ALERT_CREATED",
                targetType: "Alert",
                targetId: created.id,
                metadata: {
                  sourceMailConnectionId: input.sourceMailConnectionId,
                  recipientCount: created._count.recipients
                }
              }
            });
            return { alert: mapAlert(created), created: true };
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
          some: { kind: "OWNER", userId: input.userId, channel: "IN_APP" }
        }
      },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      include: alertInclude
    });
    return alerts.map(mapAlert);
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
            channel: "IN_APP"
          }
        }
      },
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      include: alertInclude
    });
    return alerts.map(mapAlert);
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
        select: { id: true }
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
        alert: await findAlertOrThrow(transaction, input.alertId, input.teamId),
        alreadyResolved: resolved.count === 0
      };
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
        select: { id: true }
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
        alert: await findAlertOrThrow(transaction, input.alertId, input.teamId),
        alreadyAcknowledged: acknowledged.count === 0
      };
    });
  }
}

async function findAlertOrThrow(
  transaction: Prisma.TransactionClient,
  alertId: string,
  teamId: string
): Promise<AlertRecord> {
  const alert = await transaction.alert.findFirst({
    where: { id: alertId, teamId },
    include: alertInclude
  });
  if (!alert) throw alertNotFoundError();
  return mapAlert(alert);
}

function mapAlert(alert: AlertWithSource): AlertRecord {
  return {
    id: alert.id,
    teamId: alert.teamId,
    sourceMailConnectionId: alert.sourceMailConnectionId,
    sourceProvider: alert.sourceMailConnection.mailAuthorization.provider,
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
    resolvedAt: alert.resolvedAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    recipientCount: alert._count.recipients
  };
}

function alertNotFoundError(): AppError {
  return new AppError("ALERT_NOT_FOUND", "通知が見つかりません。", 404);
}
