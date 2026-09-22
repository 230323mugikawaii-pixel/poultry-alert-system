import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult,
  NotificationCenterDeletionItem,
  NotificationCenterDeletionResult
} from "../src/modules/alerts/alert-repository.js";
import { AlertService } from "../src/modules/alerts/alert-service.js";

describe("AlertService", () => {
  it("wakes only the committed team's readers, once per new Alert, and unsubscribes", async () => {
    const repository = new MemoryAlertRepository();
    const service = new AlertService({ repository });
    const input = {
      teamId: randomUUID(),
      sourceMailConnectionId: randomUUID(),
      sourceEventId: "wake-event",
      matchedKeyword: "停電",
      detectedAt: new Date()
    };
    const owner = vi.fn(),
      member = vi.fn(),
      other = vi.fn();
    const offOwner = service.subscribeToIngestion(input.teamId, owner);
    const offMember = service.subscribeToIngestion(input.teamId, member);
    service.subscribeToIngestion(randomUUID(), other);
    const pending = service.ingest(input);
    expect(owner).not.toHaveBeenCalled();
    await pending;
    expect(owner).toHaveBeenCalledExactlyOnceWith();
    expect(member).toHaveBeenCalledExactlyOnceWith();
    expect(other).not.toHaveBeenCalled();
    await service.ingest(input);
    expect(owner).toHaveBeenCalledTimes(1);
    offOwner();
    offMember();
    const newListener = vi.fn();
    service.subscribeToIngestion(input.teamId, newListener);
    offMember(); // repeated cleanup must not remove a newer subscription set
    await service.ingest({ ...input, sourceEventId: "wake-event-2" });
    expect(owner).toHaveBeenCalledTimes(1);
    expect(member).toHaveBeenCalledTimes(1);
    expect(newListener).toHaveBeenCalledTimes(1);
  });

  it("does not wake on rollback and a broken reader cannot fail a committed ingest", async () => {
    const repository = new MemoryAlertRepository();
    const service = new AlertService({ repository });
    const input = {
      teamId: randomUUID(),
      sourceMailConnectionId: randomUUID(),
      sourceEventId: "commit-event",
      matchedKeyword: "停電",
      detectedAt: new Date()
    };
    const wake = vi.fn();
    service.subscribeToIngestion(input.teamId, () => {
      throw new Error("closed");
    });
    service.subscribeToIngestion(input.teamId, wake);
    const original = repository.ingest.bind(repository);
    repository.ingest = async () => {
      throw new Error("rollback");
    };
    await expect(service.ingest(input)).rejects.toThrow("rollback");
    expect(wake).not.toHaveBeenCalled();
    repository.ingest = original;
    await expect(service.ingest(input)).resolves.toMatchObject({
      created: true
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("normalizes a short matched phrase and preserves one source event", async () => {
    const repository = new MemoryAlertRepository();
    const now = new Date("2026-08-28T09:00:00.000Z");
    const service = new AlertService({ repository, now: () => now });
    const input = {
      teamId: randomUUID(),
      sourceMailConnectionId: randomUUID(),
      sourceEventId: "provider-event-1",
      matchedKeyword: "  停電   のお知らせ  ",
      detectedAt: now
    };

    const first = await service.ingest(input);
    const duplicate = await service.ingest(input);

    expect(first).toMatchObject({
      created: true,
      alert: { matchedKeyword: "停電 のお知らせ" }
    });
    expect(duplicate).toMatchObject({
      created: false,
      alert: { id: first.alert.id }
    });
  });

  it.each(["", "line\nbreak", "x".repeat(101)])(
    "rejects invalid matched keyword %j",
    async (matchedKeyword) => {
      const service = new AlertService({
        repository: new MemoryAlertRepository()
      });
      expect(() =>
        service.ingest({
          teamId: randomUUID(),
          sourceMailConnectionId: randomUUID(),
          sourceEventId: "provider-event-2",
          matchedKeyword,
          detectedAt: new Date()
        })
      ).toThrow(expect.objectContaining({ code: "ALERT_KEYWORD_INVALID" }));
    }
  );

  it("marks an owner recipient read idempotently", async () => {
    const repository = new MemoryAlertRepository();
    const now = new Date("2026-08-31T09:00:00.000Z");
    const service = new AlertService({ repository, now: () => now });
    const created = await service.ingest({
      teamId: randomUUID(),
      sourceMailConnectionId: randomUUID(),
      sourceEventId: "provider-event-read",
      matchedKeyword: "停電",
      detectedAt: now
    });
    const input = {
      teamId: created.alert.teamId,
      alertId: created.alert.id,
      userId: randomUUID()
    };

    const first = await service.markReadByOwner(input);
    const duplicate = await service.markReadByOwner(input);

    expect(first.readAt).toEqual(now);
    expect(duplicate.readAt).toEqual(now);
  });

  it("deduplicates owner notification deletion items before persistence", async () => {
    const repository = new MemoryAlertRepository();
    const service = new AlertService({ repository });
    const alertId = randomUUID();
    const notificationId = randomUUID();

    const result = await service.dismissOwnerNotifications({
      teamId: randomUUID(),
      userId: randomUUID(),
      items: [
        { type: "ALERT", id: alertId },
        { type: "ALERT", id: alertId },
        { type: "USER_NOTIFICATION", id: notificationId }
      ]
    });

    expect(repository.lastOwnerDeletionItems).toEqual([
      { type: "ALERT", id: alertId },
      { type: "USER_NOTIFICATION", id: notificationId }
    ]);
    expect(result.deletedCount).toBe(2);
  });

  it.each([0, 101])(
    "rejects deletion batches containing %s items",
    async (count) => {
      const service = new AlertService({
        repository: new MemoryAlertRepository()
      });
      const items = Array.from({ length: count }, () => ({
        type: "ALERT" as const,
        id: randomUUID()
      }));

      expect(() =>
        service.dismissOwnerNotifications({
          teamId: randomUUID(),
          userId: randomUUID(),
          items
        })
      ).toThrow(
        expect.objectContaining({
          code: "NOTIFICATION_DELETE_LIMIT_EXCEEDED",
          statusCode: 400
        })
      );
    }
  );
});

class MemoryAlertRepository implements AlertRepository {
  private alert: AlertRecord | null = null;
  private sourceEventId: string | null = null;
  public lastOwnerDeletionItems: readonly NotificationCenterDeletionItem[] = [];

  public async ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly now: Date;
    readonly kind: "REAL" | "TEST";
  }): Promise<AlertIngestionResult> {
    if (this.alert && this.sourceEventId === input.sourceEventId)
      return { alert: this.alert, created: false };
    const created: AlertRecord = {
      id: randomUUID(),
      teamId: input.teamId,
      sourceMailConnectionId: input.sourceMailConnectionId,
      sourceProvider: "GOOGLE",
      kind: input.kind,
      status: "ACTIVE",
      detectedAt: input.detectedAt,
      matchedKeyword: input.matchedKeyword,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgedByName: null,
      readAt: null,
      resolvedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      recipientCount: 1
    };
    this.alert = created;
    this.sourceEventId = input.sourceEventId;
    return { alert: created, created: true };
  }

  public listForOwner(): Promise<readonly AlertRecord[]> {
    return Promise.resolve(this.alert ? [this.alert] : []);
  }

  public listForNotificationMember(): Promise<readonly AlertRecord[]> {
    return Promise.resolve(this.alert ? [this.alert] : []);
  }

  public acknowledgeByOwner(): Promise<AlertAcknowledgementResult> {
    throw new Error("not implemented");
  }

  public acknowledgeByNotificationMember(): Promise<AlertAcknowledgementResult> {
    throw new Error("not implemented");
  }

  public markReadByOwner(input: { readonly now: Date }): Promise<AlertRecord> {
    if (!this.alert) throw new Error("not implemented");
    this.alert = { ...this.alert, readAt: this.alert.readAt ?? input.now };
    return Promise.resolve(this.alert);
  }

  public markReadByNotificationMember(input: {
    readonly now: Date;
  }): Promise<AlertRecord> {
    return this.markReadByOwner(input);
  }

  public dismissOwnerNotifications(input: {
    readonly items: readonly NotificationCenterDeletionItem[];
  }): Promise<NotificationCenterDeletionResult> {
    this.lastOwnerDeletionItems = input.items;
    return Promise.resolve({
      items: input.items,
      deletedCount: input.items.length,
      alreadyDeletedCount: 0
    });
  }

  public dismissNotificationMemberAlerts(input: {
    readonly alertIds: readonly string[];
  }): Promise<NotificationCenterDeletionResult> {
    const items = input.alertIds.map((id) => ({ type: "ALERT" as const, id }));
    return Promise.resolve({
      items,
      deletedCount: items.length,
      alreadyDeletedCount: 0
    });
  }

  public resolveByOwner(): Promise<AlertResolutionResult> {
    throw new Error("not implemented");
  }
}
