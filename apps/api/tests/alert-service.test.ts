import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AlertAcknowledgementResult,
  AlertIngestionResult,
  AlertRecord,
  AlertRepository,
  AlertResolutionResult
} from "../src/modules/alerts/alert-repository.js";
import { AlertService } from "../src/modules/alerts/alert-service.js";

describe("AlertService", () => {
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
});

class MemoryAlertRepository implements AlertRepository {
  private alert: AlertRecord | null = null;

  public async ingest(input: {
    readonly teamId: string;
    readonly sourceMailConnectionId: string;
    readonly sourceEventId: string;
    readonly matchedKeyword: string;
    readonly detectedAt: Date;
    readonly now: Date;
    readonly kind: "REAL" | "TEST";
  }): Promise<AlertIngestionResult> {
    if (this.alert) return { alert: this.alert, created: false };
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
      resolvedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      recipientCount: 1
    };
    this.alert = created;
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

  public resolveByOwner(): Promise<AlertResolutionResult> {
    throw new Error("not implemented");
  }
}
