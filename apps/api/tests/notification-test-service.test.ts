import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AlertRecord } from "../src/modules/alerts/alert-repository.js";
import type { AlertService } from "../src/modules/alerts/alert-service.js";
import type {
  NotificationTestRecord,
  NotificationTestRepository
} from "../src/modules/alerts/notification-test-repository.js";
import { NotificationTestService } from "../src/modules/alerts/notification-test-service.js";

describe("NotificationTestService", () => {
  it("normalizes the keyword and creates one idempotent TEST alert", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const repository = new MemoryNotificationTestRepository(now);
    const alert = createAlert(repository.record, now);
    const ingest = vi.fn(async () => ({ alert, created: true }));
    const service = new NotificationTestService({
      repository,
      alertService: { ingest } as unknown as AlertService,
      now: () => now,
      requestIdGenerator: () => "server-generated-request-id",
      ttlMilliseconds: 180_000
    });

    const started = await service.start({
      teamId: repository.record.teamId,
      actorUserId: repository.record.actorUserId,
      sourceMailConnectionId: repository.record.sourceMailConnectionId,
      keyword: "  停電   のお知らせ  "
    });
    expect(started.test).toMatchObject({
      keyword: "停電 のお知らせ",
      requestId: "server-generated-request-id",
      status: "PENDING"
    });

    const first = await service.confirm({
      teamId: started.test.teamId,
      testId: started.test.id,
      actorUserId: started.test.actorUserId,
      requestId: started.test.requestId
    });
    const duplicate = await service.confirm({
      teamId: started.test.teamId,
      testId: started.test.id,
      actorUserId: started.test.actorUserId,
      requestId: started.test.requestId
    });

    expect(first).toMatchObject({
      created: true,
      test: { status: "ALERT_CREATED" }
    });
    expect(duplicate).toMatchObject({
      created: false,
      test: { status: "ALERT_CREATED", alertId: alert.id }
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TEST",
        notificationTestId: started.test.id,
        sourceEventId: `notification-test:${started.test.id}`
      })
    );
  });

  it("does not create an alert after the server-side test expires", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const repository = new MemoryNotificationTestRepository(now);
    repository.expired = true;
    const ingest = vi.fn();
    const service = new NotificationTestService({
      repository,
      alertService: { ingest } as unknown as AlertService,
      now: () => now
    });

    await expect(
      service.confirm({
        teamId: repository.record.teamId,
        testId: repository.record.id,
        actorUserId: repository.record.actorUserId,
        requestId: repository.record.requestId
      })
    ).rejects.toMatchObject({
      code: "NOTIFICATION_TEST_EXPIRED",
      statusCode: 410
    });
    expect(ingest).not.toHaveBeenCalled();
  });
});

class MemoryNotificationTestRepository implements NotificationTestRepository {
  public expired = false;
  public record: NotificationTestRecord;

  public constructor(now: Date) {
    this.record = {
      id: randomUUID(),
      teamId: randomUUID(),
      actorUserId: randomUUID(),
      sourceMailConnectionId: randomUUID(),
      keyword: "停電",
      requestId: "initial-request-id",
      status: "PENDING",
      expiresAt: new Date(now.getTime() + 180_000),
      detectedAt: null,
      alertId: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  public start(input: Parameters<NotificationTestRepository["start"]>[0]) {
    this.record = {
      ...this.record,
      ...input,
      keyword: input.keyword,
      requestId: input.requestId,
      expiresAt: input.expiresAt
    };
    return Promise.resolve({ test: this.record, created: true });
  }

  public prepareDetection() {
    if (this.record.status === "ALERT_CREATED") {
      return Promise.resolve({ test: this.record, expired: false });
    }
    if (this.expired) {
      this.record = {
        ...this.record,
        status: "EXPIRED",
        completedAt: new Date()
      };
      return Promise.resolve({ test: this.record, expired: true });
    }
    this.record = {
      ...this.record,
      status: "DETECTED",
      detectedAt: new Date()
    };
    return Promise.resolve({ test: this.record, expired: false });
  }

  public markAlertCreated(
    input: Parameters<NotificationTestRepository["markAlertCreated"]>[0]
  ) {
    this.record = {
      ...this.record,
      status: "ALERT_CREATED",
      alertId: input.alertId,
      completedAt: input.now
    };
    return Promise.resolve(this.record);
  }

  public async markFailed(): Promise<NotificationTestRecord> {
    throw new Error("not implemented");
  }

  public async markExpired(): Promise<NotificationTestRecord> {
    throw new Error("not implemented");
  }

  public getForOwner() {
    return Promise.resolve(this.record);
  }

  public expireOpen() {
    return Promise.resolve(0);
  }
}

function createAlert(test: NotificationTestRecord, now: Date): AlertRecord {
  return {
    id: randomUUID(),
    teamId: test.teamId,
    sourceMailConnectionId: test.sourceMailConnectionId,
    sourceProvider: "GOOGLE",
    kind: "TEST",
    status: "ACTIVE",
    detectedAt: now,
    matchedKeyword: test.keyword,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgedByName: null,
    readAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    recipientCount: 1
  };
}
