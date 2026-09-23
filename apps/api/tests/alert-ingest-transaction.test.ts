import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { AlertRepository } from "../src/modules/alerts/alert-repository.js";
import { AlertService } from "../src/modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "../src/modules/alerts/prisma-alert-repository.js";

const expectedInclude = {
  sourceMailConnection: {
    select: { mailAuthorization: { select: { provider: true } } }
  },
  acknowledgedByUser: { select: { displayName: true } },
  acknowledgedByNotificationMember: { select: { displayName: true } },
  _count: { select: { recipients: true } }
};

function fixture(kind: "REAL" | "TEST" = "REAL") {
  const now = new Date("2026-09-23T00:00:00Z");
  const input: Parameters<AlertRepository["ingest"]>[0] = {
    teamId: randomUUID(),
    sourceMailConnectionId: randomUUID(),
    sourceEventId: "synthetic-message",
    kind,
    matchedKeyword: "停電",
    detectedAt: now,
    now,
    ...(kind === "TEST"
      ? { actorUserId: randomUUID(), notificationTestId: randomUUID() }
      : {})
  };
  const ownerId = input.actorUserId ?? randomUUID();
  const memberId = randomUUID();
  const row = {
    ...input,
    id: randomUUID(),
    status: "ACTIVE",
    sourceMailConnection: { mailAuthorization: { provider: "GOOGLE" } },
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    acknowledgedByNotificationMemberId: null,
    acknowledgedByUser: null,
    acknowledgedByNotificationMember: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    _count: { recipients: 2 }
  };
  const order: string[] = [];
  const operation = <T>(name: string, value: T) =>
    vi.fn(async () => {
      order.push(name);
      return value;
    });
  const tx = {
    $queryRaw: operation("lock", [{ id: input.sourceMailConnectionId }]),
    alert: {
      findUnique: operation("lookup", null as typeof row | null),
      create: operation("alert+recipients", row)
    },
    teamMembership: { findMany: operation("owners", [{ userId: ownerId }]) },
    notificationMember: { findMany: operation("members", [{ id: memberId }]) },
    auditEvent: { create: operation("audit", {}) }
  };
  const transaction = tx as unknown as Prisma.TransactionClient;
  const database = {
    $transaction: vi.fn(
      async (body: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const result = await body(transaction);
        order.push("commit");
        return result;
      }
    )
  };
  const repository = new PrismaAlertRepository(
    database as unknown as DatabaseClient
  );
  return {
    input,
    ownerId,
    memberId,
    row,
    order,
    tx,
    transaction,
    database,
    repository
  };
}

it.each(["REAL", "TEST"] as const)(
  "PR02a: preserves %s payloads, recipient order and audit-before-commit-before-SSE",
  async (kind) => {
    const f = fixture(kind);
    const service = new AlertService({
      repository: f.repository,
      now: () => f.input.now
    });
    service.subscribeToIngestion(f.input.teamId, () => f.order.push("sse"));
    const result = await service.ingest(f.input);
    expect(f.order).toEqual([
      "lock",
      "lookup",
      "owners",
      "members",
      "alert+recipients",
      "audit",
      "commit",
      "sse"
    ]);
    expect(f.database.$transaction).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    expect(f.tx.alert.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: {
        sourceMailConnectionId_sourceEventId: {
          sourceMailConnectionId: f.input.sourceMailConnectionId,
          sourceEventId: f.input.sourceEventId
        }
      },
      include: expectedInclude
    });
    expect(f.tx.alert.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        teamId: f.input.teamId,
        sourceMailConnectionId: f.input.sourceMailConnectionId,
        sourceEventId: f.input.sourceEventId,
        kind,
        matchedKeyword: f.input.matchedKeyword,
        detectedAt: f.input.detectedAt,
        recipients: {
          create: [
            { kind: "OWNER", userId: f.ownerId, channel: "IN_APP" },
            {
              kind: "NOTIFICATION_MEMBER",
              notificationMemberId: f.memberId,
              channel: "IN_APP"
            }
          ]
        }
      },
      include: expectedInclude
    });
    expect(f.tx.auditEvent.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        teamId: f.input.teamId,
        ...(kind === "TEST" ? { actorUserId: f.ownerId } : {}),
        action: kind === "TEST" ? "TEST_ALERT_CREATED" : "ALERT_CREATED",
        targetType: "Alert",
        targetId: result.alert.id,
        metadata: {
          sourceMailConnectionId: f.input.sourceMailConnectionId,
          ...(kind === "TEST"
            ? { notificationTestId: f.input.notificationTestId }
            : {}),
          recipientCount: 2
        }
      }
    });
  }
);

it("PR02a: supplied transaction returns an existing Alert without writes or nested transaction", async () => {
  const f = fixture();
  f.tx.alert.findUnique.mockImplementationOnce(async () => {
    f.order.push("lookup");
    return f.row;
  });
  const result = await f.repository.ingestWithinTransaction(
    f.transaction,
    f.input
  );
  expect(result).toMatchObject({
    created: false,
    alert: { id: f.row.id, recipientCount: 2 }
  });
  expect(f.order).toEqual(["lock", "lookup"]);
  expect(f.database.$transaction).not.toHaveBeenCalled();
});

it("PR02a: retains active connection and single owner guards before writes", async () => {
  const f = fixture();
  f.tx.$queryRaw.mockImplementationOnce(async () => {
    f.order.push("lock");
    return [];
  });
  await expect(
    f.repository.ingestWithinTransaction(f.transaction, f.input)
  ).rejects.toMatchObject({
    code: "MAIL_CONNECTION_NOT_ACTIVE",
    statusCode: 409
  });
  expect(f.order).toEqual(["lock"]);
  f.order.length = 0;
  f.tx.teamMembership.findMany.mockImplementationOnce(async () => {
    f.order.push("owners");
    return [];
  });
  await expect(
    f.repository.ingestWithinTransaction(f.transaction, f.input)
  ).rejects.toMatchObject({ code: "TEAM_OWNER_UNAVAILABLE", statusCode: 409 });
  expect(f.order).toEqual(["lock", "lookup", "owners", "members"]);
  expect(f.tx.alert.create).not.toHaveBeenCalled();
  expect(f.tx.auditEvent.create).not.toHaveBeenCalled();
});

it("PR02a: wrapper retries SERIALIZABLE conflicts but wakes readers only once after commit", async () => {
  const f = fixture();
  f.database.$transaction.mockRejectedValueOnce({ code: "P2034" });
  const service = new AlertService({
    repository: f.repository,
    now: () => f.input.now
  });
  const wake = vi.fn();
  service.subscribeToIngestion(f.input.teamId, wake);
  await expect(service.ingest(f.input)).resolves.toMatchObject({
    created: true
  });
  expect(f.database.$transaction).toHaveBeenCalledTimes(2);
  expect(wake).toHaveBeenCalledTimes(1);
  expect(f.order.at(-1)).toBe("commit");
});

it("PR02a: exhausted retries preserve conflict error and never wake SSE", async () => {
  const f = fixture();
  f.database.$transaction.mockRejectedValue({ code: "40001" });
  const service = new AlertService({
    repository: f.repository,
    now: () => f.input.now
  });
  const wake = vi.fn();
  service.subscribeToIngestion(f.input.teamId, wake);
  await expect(service.ingest(f.input)).rejects.toMatchObject({
    code: "ALERT_INGESTION_CONFLICT",
    statusCode: 409
  });
  expect(f.database.$transaction).toHaveBeenCalledTimes(5);
  expect(wake).not.toHaveBeenCalled();
});
