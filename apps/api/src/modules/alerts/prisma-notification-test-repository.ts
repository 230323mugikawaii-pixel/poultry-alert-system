import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  NotificationTestDetectionResult,
  NotificationTestRecord,
  NotificationTestRepository,
  NotificationTestStartResult
} from "./notification-test-repository.js";

export class PrismaNotificationTestRepository implements NotificationTestRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public start(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
    readonly requestId: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<NotificationTestStartResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await lockTeam(transaction, input.teamId);
            await requireOwner(transaction, input.teamId, input.actorUserId);
            await requireEligibleConnection(transaction, {
              teamId: input.teamId,
              sourceMailConnectionId: input.sourceMailConnectionId,
              keyword: input.keyword,
              now: input.now
            });

            const openTest = await transaction.notificationTest.findFirst({
              where: {
                teamId: input.teamId,
                status: { in: ["PENDING", "DETECTED"] }
              },
              orderBy: { createdAt: "desc" }
            });
            if (openTest && openTest.expiresAt <= input.now) {
              await expireTest(transaction, openTest, input.now);
            } else if (openTest) {
              if (
                openTest.actorUserId === input.actorUserId &&
                openTest.sourceMailConnectionId ===
                  input.sourceMailConnectionId &&
                comparableKeyword(openTest.keyword) ===
                  comparableKeyword(input.keyword)
              ) {
                return { test: mapTest(openTest), created: false };
              }
              throw new AppError(
                "NOTIFICATION_TEST_IN_PROGRESS",
                "別の通知テストを確認中です。完了後にもう一度お試しください。",
                409
              );
            }

            const created = await transaction.notificationTest.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                sourceMailConnectionId: input.sourceMailConnectionId,
                keyword: input.keyword,
                requestId: input.requestId,
                expiresAt: input.expiresAt
              }
            });
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                action: "NOTIFICATION_TEST_STARTED",
                targetType: "NotificationTest",
                targetId: created.id,
                requestId: input.requestId,
                metadata: {
                  sourceMailConnectionId: input.sourceMailConnectionId,
                  keyword: input.keyword
                }
              }
            });
            return { test: mapTest(created), created: true };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "NOTIFICATION_TEST_START_CONFLICT",
          "通知テストの開始が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public prepareDetection(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<NotificationTestDetectionResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await requireOwner(transaction, input.teamId, input.actorUserId);
            const test = await lockTest(
              transaction,
              input.teamId,
              input.testId
            );
            requireMatchingRequestId(test.requestId, input.requestId);
            if (test.status === "ALERT_CREATED") {
              return { test: mapTest(test), expired: false };
            }
            if (test.status === "EXPIRED") {
              return { test: mapTest(test), expired: true };
            }
            if (test.status === "FAILED") {
              throw new AppError(
                "NOTIFICATION_TEST_FAILED",
                "この通知テストは完了できません。もう一度テストしてください。",
                409
              );
            }
            if (test.expiresAt <= input.now) {
              const expired = await expireTest(transaction, test, input.now);
              return { test: mapTest(expired), expired: true };
            }
            await requireEligibleConnection(transaction, {
              teamId: test.teamId,
              sourceMailConnectionId: test.sourceMailConnectionId,
              keyword: test.keyword,
              now: input.now
            });
            if (test.status === "DETECTED") {
              return { test: mapTest(test), expired: false };
            }
            const detected = await transaction.notificationTest.update({
              where: { id: test.id },
              data: { status: "DETECTED", detectedAt: input.now }
            });
            await transaction.auditEvent.create({
              data: {
                teamId: test.teamId,
                actorUserId: input.actorUserId,
                action: "NOTIFICATION_TEST_DETECTED",
                targetType: "NotificationTest",
                targetId: test.id,
                requestId: test.requestId,
                metadata: {
                  sourceMailConnectionId: test.sourceMailConnectionId,
                  keyword: test.keyword
                }
              }
            });
            return { test: mapTest(detected), expired: false };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "NOTIFICATION_TEST_CONFIRM_CONFLICT",
          "通知テストの確定が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public markAlertCreated(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly alertId: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord> {
    return this.database.$transaction(async (transaction) => {
      const test = await lockTest(transaction, input.teamId, input.testId);
      if (test.status === "ALERT_CREATED" && test.alertId === input.alertId) {
        return mapTest(test);
      }
      if (test.status !== "DETECTED") {
        throw invalidTestStateError();
      }
      const alert = await transaction.alert.findFirst({
        where: {
          id: input.alertId,
          teamId: input.teamId,
          sourceMailConnectionId: test.sourceMailConnectionId,
          sourceEventId: `notification-test:${test.id}`,
          kind: "TEST"
        },
        select: { id: true }
      });
      if (!alert) {
        throw new AppError(
          "TEST_ALERT_NOT_FOUND",
          "テスト通知を確認できませんでした。",
          409
        );
      }
      return mapTest(
        await transaction.notificationTest.update({
          where: { id: test.id },
          data: {
            status: "ALERT_CREATED",
            alertId: alert.id,
            completedAt: input.now
          }
        })
      );
    });
  }

  public markFailed(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord> {
    return this.database.$transaction(async (transaction) => {
      await requireOwner(transaction, input.teamId, input.actorUserId);
      const test = await lockTest(transaction, input.teamId, input.testId);
      requireMatchingRequestId(test.requestId, input.requestId);
      if (["ALERT_CREATED", "FAILED", "EXPIRED"].includes(test.status)) {
        return mapTest(test);
      }
      const failed = await transaction.notificationTest.update({
        where: { id: test.id },
        data: { status: "FAILED", completedAt: input.now }
      });
      await transaction.auditEvent.create({
        data: {
          teamId: test.teamId,
          actorUserId: input.actorUserId,
          action: "TEST_ALERT_FAILED",
          targetType: "NotificationTest",
          targetId: test.id,
          requestId: test.requestId,
          metadata: { reasonCode: input.reasonCode }
        }
      });
      return mapTest(failed);
    });
  }

  public markExpired(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<NotificationTestRecord> {
    return this.database.$transaction(async (transaction) => {
      await requireOwner(transaction, input.teamId, input.actorUserId);
      const test = await lockTest(transaction, input.teamId, input.testId);
      requireMatchingRequestId(test.requestId, input.requestId);
      if (["ALERT_CREATED", "FAILED", "EXPIRED"].includes(test.status)) {
        return mapTest(test);
      }
      if (test.expiresAt > input.now) {
        throw new AppError(
          "NOTIFICATION_TEST_STILL_PENDING",
          "通知テストはまだ検知確認中です。",
          409
        );
      }
      return mapTest(await expireTest(transaction, test, input.now));
    });
  }

  public async getForOwner(input: {
    readonly teamId: string;
    readonly testId: string;
    readonly actorUserId: string;
  }): Promise<NotificationTestRecord> {
    await requireOwner(this.database, input.teamId, input.actorUserId);
    const test = await this.database.notificationTest.findFirst({
      where: { id: input.testId, teamId: input.teamId }
    });
    if (!test) throw notificationTestNotFoundError();
    return mapTest(test);
  }

  public expireOpen(now: Date): Promise<number> {
    return this.database.$transaction(async (transaction) => {
      const tests = await transaction.notificationTest.findMany({
        where: {
          status: { in: ["PENDING", "DETECTED"] },
          expiresAt: { lte: now }
        }
      });
      let expiredCount = 0;
      for (const test of tests) {
        const updated = await transaction.notificationTest.updateMany({
          where: {
            id: test.id,
            status: { in: ["PENDING", "DETECTED"] }
          },
          data: { status: "EXPIRED", completedAt: now }
        });
        if (updated.count === 0) continue;
        expiredCount += 1;
        await createExpiredAudit(transaction, test, now);
      }
      return expiredCount;
    });
  }
}

async function lockTeam(
  transaction: Prisma.TransactionClient,
  teamId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`
  );
  if (rows.length !== 1) {
    throw new AppError("TEAM_NOT_FOUND", "所属チームが見つかりません。", 404);
  }
}

async function requireOwner(
  database: DatabaseClient | Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<void> {
  const membership = await database.teamMembership.findFirst({
    where: {
      teamId,
      userId,
      role: "OWNER",
      status: "ACTIVE",
      team: { status: "ACTIVE" }
    },
    select: { id: true }
  });
  if (!membership) {
    throw new AppError(
      "OWNER_REQUIRED",
      "この操作はチームの代表者だけが実行できます。",
      403
    );
  }
}

async function requireEligibleConnection(
  transaction: Prisma.TransactionClient,
  input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
    readonly now: Date;
  }
): Promise<void> {
  const [subscription, connection] = await Promise.all([
    transaction.subscription.findFirst({
      where: {
        teamId: input.teamId,
        status: "ACTIVE",
        currentTermEndsAt: { gt: input.now }
      },
      select: { id: true }
    }),
    transaction.mailConnection.findFirst({
      where: {
        id: input.sourceMailConnectionId,
        teamId: input.teamId,
        status: "ACTIVE",
        mailAuthorization: { status: "ACTIVE" }
      },
      select: { id: true, keywords: true }
    })
  ]);
  if (!subscription) {
    throw new AppError(
      "SUBSCRIPTION_NOT_ACTIVE",
      "有効な契約が必要です。契約内容を確認してください。",
      409
    );
  }
  if (!connection) {
    throw new AppError(
      "MAIL_CONNECTION_NOT_ACTIVE",
      "有効なメール監視アカウントが見つかりません。",
      409
    );
  }
  if (
    !connection.keywords.some(
      (keyword) =>
        comparableKeyword(keyword) === comparableKeyword(input.keyword)
    )
  ) {
    throw new AppError(
      "NOTIFICATION_TEST_KEYWORD_NOT_CONFIGURED",
      "この監視アカウントには選択したキーワードが設定されていません。",
      409
    );
  }
}

async function lockTest(
  transaction: Prisma.TransactionClient,
  teamId: string,
  testId: string
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT id
      FROM notification_tests
      WHERE id = ${testId}::uuid AND "teamId" = ${teamId}::uuid
      FOR UPDATE
    `
  );
  if (rows.length !== 1) throw notificationTestNotFoundError();
  return transaction.notificationTest.findUniqueOrThrow({
    where: { id: testId }
  });
}

async function expireTest(
  transaction: Prisma.TransactionClient,
  test: {
    readonly id: string;
    readonly teamId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
  },
  now: Date
) {
  const expired = await transaction.notificationTest.update({
    where: { id: test.id },
    data: { status: "EXPIRED", completedAt: now }
  });
  await createExpiredAudit(transaction, test, now);
  return expired;
}

async function createExpiredAudit(
  transaction: Prisma.TransactionClient,
  test: {
    readonly id: string;
    readonly teamId: string;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly sourceMailConnectionId: string;
    readonly keyword: string;
  },
  now: Date
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      teamId: test.teamId,
      actorUserId: test.actorUserId,
      action: "TEST_ALERT_EXPIRED",
      targetType: "NotificationTest",
      targetId: test.id,
      requestId: test.requestId,
      metadata: {
        sourceMailConnectionId: test.sourceMailConnectionId,
        keyword: test.keyword,
        expiredAt: now.toISOString()
      }
    }
  });
}

function requireMatchingRequestId(expected: string, actual: string): void {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new AppError(
      "NOTIFICATION_TEST_REQUEST_MISMATCH",
      "通知テストの確認情報が一致しません。",
      403
    );
  }
}

function comparableKeyword(value: string): string {
  return value
    .trim()
    .replace(/[ \u00a0\u3000]+/gu, " ")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP");
}

function mapTest(input: {
  readonly id: string;
  readonly teamId: string;
  readonly actorUserId: string;
  readonly sourceMailConnectionId: string;
  readonly keyword: string;
  readonly requestId: string;
  readonly status:
    "PENDING" | "DETECTED" | "ALERT_CREATED" | "EXPIRED" | "FAILED";
  readonly expiresAt: Date;
  readonly detectedAt: Date | null;
  readonly alertId: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): NotificationTestRecord {
  return { ...input };
}

function notificationTestNotFoundError(): AppError {
  return new AppError(
    "NOTIFICATION_TEST_NOT_FOUND",
    "通知テストが見つかりません。",
    404
  );
}

function invalidTestStateError(): AppError {
  return new AppError(
    "NOTIFICATION_TEST_STATE_INVALID",
    "通知テストの状態を更新できませんでした。",
    409
  );
}
