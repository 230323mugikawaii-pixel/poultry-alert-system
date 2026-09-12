import { describe, expect, it } from "vitest";
import { AlertService } from "../src/modules/alerts/alert-service.js";
import type {
  AlertIngestionResult,
  AlertRepository
} from "../src/modules/alerts/alert-repository.js";
import {
  GmailApiRequestError,
  type GmailApiClient,
  type GmailHistoryPage,
  type GmailMessage,
  type GmailMessageListPage,
  type GmailWatchResult
} from "../src/modules/mail/gmail/gmail-api-client.js";
import {
  GmailMonitoringService,
  GmailMonitoringTransientError,
  compareDecimalStrings
} from "../src/modules/mail/gmail/gmail-monitoring-service.js";
import type {
  GmailCursorUpdate,
  GmailMonitoringConnection,
  GmailMonitoringRepository
} from "../src/modules/mail/gmail/gmail-monitoring-repository.js";
import { maximumDecimalString } from "../src/modules/mail/gmail/prisma-gmail-monitoring-repository.js";
import type {
  MailProviderAdapter,
  MailProviderErrorKind
} from "../src/modules/mail/mail-provider.js";
import type {
  StoredEncryptedToken,
  TokenEncryptionProvider
} from "../src/modules/mail/token-encryption.js";

const now = new Date("2026-09-03T12:00:00.000Z");

describe("Gmail watch reconciliation", () => {
  it("stores the first cursor and never overwrites it during renewal", async () => {
    const fixture = createFixture({ cursor: null });
    fixture.api.watchResults.push(watch("100"), watch("999"));

    expect(await fixture.service.renewEligibleWatches()).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fixture.repository.connection.providerCursor).toBe("100");

    fixture.repository.connection = {
      ...fixture.repository.connection,
      providerSubscriptionExpiresAt: new Date(0)
    };
    await fixture.service.renewEligibleWatches();
    expect(fixture.repository.connection.providerCursor).toBe("100");
    expect(fixture.repository.connection.providerSubscriptionExpiresAt).toEqual(
      watch("999").expiration
    );
  });

  it("marks invalid credentials for reauthorization without infinite retry", async () => {
    const fixture = createFixture({ cursor: null });
    fixture.provider.refreshError = Object.assign(new Error("invalid"), {
      status: 401
    });
    const result = await fixture.service.renewEligibleWatches();
    expect(result.reauthorizationRequired).toBe(1);
    expect(fixture.repository.reauthorizationRequired).toBe(true);
    expect(fixture.api.startWatchCalls).toBe(0);
  });

  it("records exhausted rate limits as transient without revoking authorization", async () => {
    const fixture = createFixture({ cursor: null });
    fixture.api.startWatchError = new GmailApiRequestError(
      429,
      "GMAIL_HTTP_429"
    );
    const result = await fixture.service.renewEligibleWatches();
    expect(result.failed).toBe(1);
    expect(fixture.repository.reauthorizationRequired).toBe(false);
    expect(fixture.repository.connection.providerCursor).toBeNull();
  });
});

describe("Gmail history processing", () => {
  it("retries an early initial push until watch reconciliation has persisted its cursor", async () => {
    const fixture = createFixture({ cursor: null });
    await expect(
      fixture.service.processPushNotification({
        emailAddress: "monitor@example.com",
        historyId: "10"
      })
    ).rejects.toMatchObject({
      errorCode: "GMAIL_CURSOR_NOT_INITIALIZED"
    });
    expect(fixture.api.startWatchCalls).toBe(0);
    expect(fixture.repository.connection.providerCursor).toBeNull();
  });

  it("handles pagination and duplicate history records, then creates one REAL Alert per message", async () => {
    const fixture = createFixture({ cursor: "90071992547409930000" });
    fixture.api.historyPages.push(
      historyPage({
        current: "90071992547409930002",
        next: "next-page",
        records: [
          { id: "90071992547409930001", messageIds: ["message-a", "message-a"] }
        ]
      }),
      historyPage({
        current: "90071992547409930003",
        records: [{ id: "90071992547409930003", messageIds: ["message-b"] }]
      })
    );
    fixture.api.messages.set(
      "message-a",
      message("message-a", "通常連絡", "停電のお知らせです")
    );
    fixture.api.messages.set(
      "message-b",
      message("message-b", "CALL NOW", "起動しました")
    );

    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "90071992547409930003"
    });
    expect(fixture.alerts.created).toEqual([
      expect.objectContaining({
        sourceEventId: "message-a",
        kind: "REAL",
        matchedKeyword: "停電"
      }),
      expect.objectContaining({
        sourceEventId: "message-b",
        kind: "REAL",
        matchedKeyword: "Call Now"
      })
    ]);
    expect(fixture.repository.connection.providerCursor).toBe(
      "90071992547409930003"
    );
    expect(fixture.api.getMessageCalls).toBe(2);

    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "90071992547409930002"
    });
    expect(fixture.api.getMessageCalls).toBe(2);
  });

  it("does not advance the cursor after a partial failure and safely deduplicates on retry", async () => {
    const fixture = createFixture({ cursor: "10" });
    fixture.api.historyPages.push(
      historyPage({
        current: "12",
        records: [{ id: "12", messageIds: ["message-a", "message-b"] }]
      })
    );
    fixture.api.messages.set("message-a", message("message-a", "停電", ""));
    fixture.api.messageErrors.set(
      "message-b",
      new GmailApiRequestError(503, "GMAIL_HTTP_503")
    );
    await expect(
      fixture.service.processPushNotification({
        emailAddress: "monitor@example.com",
        historyId: "12"
      })
    ).rejects.toBeInstanceOf(GmailMonitoringTransientError);
    expect(fixture.repository.connection.providerCursor).toBe("10");
    expect(fixture.alerts.created).toHaveLength(1);

    fixture.api.historyPages.push(
      historyPage({
        current: "12",
        records: [{ id: "12", messageIds: ["message-a", "message-b"] }]
      })
    );
    fixture.api.messageErrors.delete("message-b");
    fixture.api.messages.set("message-b", message("message-b", "Call Now", ""));
    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "12"
    });
    expect(fixture.repository.connection.providerCursor).toBe("12");
    expect(
      fixture.alerts.created.map(({ sourceEventId }) => sourceEventId)
    ).toEqual(["message-a", "message-b"]);
  });

  it("recovers a stale history cursor with a bounded recent-INBOX scan", async () => {
    const fixture = createFixture({ cursor: "1" });
    fixture.repository.connection = {
      ...fixture.repository.connection,
      lastSyncAt: new Date(now.getTime() - 60 * 60 * 1_000)
    };
    fixture.api.historyErrors.push(
      new GmailApiRequestError(404, "GMAIL_HTTP_404")
    );
    fixture.api.watchResults.push(watch("500"));
    fixture.api.recentPages.push({
      messageIds: ["recent-message"],
      nextPageToken: null
    });
    fixture.api.messages.set(
      "recent-message",
      message("recent-message", "東京　電力", "")
    );

    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "450"
    });
    expect(fixture.repository.connection.providerCursor).toBe("500");
    expect(fixture.repository.recovered).toBe(true);
    expect(fixture.alerts.created[0]?.matchedKeyword).toBe("東京 電力");
    expect(fixture.api.recentAfter).toEqual([
      new Date(now.getTime() - 65 * 60 * 1_000)
    ]);
  });

  it("ignores sent, draft, spam, and trash messages even if a keyword matches", async () => {
    const fixture = createFixture({ cursor: "10" });
    fixture.api.historyPages.push(
      historyPage({
        current: "11",
        records: [{ id: "11", messageIds: ["sent-message"] }]
      })
    );
    fixture.api.messages.set(
      "sent-message",
      message("sent-message", "停電", "", ["INBOX", "SENT"])
    );
    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "11"
    });
    expect(fixture.alerts.created).toHaveLength(0);
    expect(fixture.repository.connection.providerCursor).toBe("11");
  });

  it("does not persist or log the transient message subject or body", async () => {
    const fixture = createFixture({ cursor: "10" });
    fixture.api.historyPages.push(
      historyPage({
        current: "11",
        records: [{ id: "11", messageIds: ["private-message"] }]
      })
    );
    fixture.api.messages.set(
      "private-message",
      message(
        "private-message",
        "private-subject-not-for-storage",
        "停電 private-body-not-for-storage"
      )
    );
    await fixture.service.processPushNotification({
      emailAddress: "monitor@example.com",
      historyId: "11"
    });
    const storedAndLogged = JSON.stringify({
      alerts: fixture.alerts.created,
      logs: fixture.logs
    });
    expect(storedAndLogged).not.toContain("private-subject-not-for-storage");
    expect(storedAndLogged).not.toContain("private-body-not-for-storage");
  });
});

describe("decimal Gmail history IDs", () => {
  it("compares values without converting them to unsafe JavaScript numbers", () => {
    expect(
      compareDecimalStrings("90071992547409930001", "90071992547409930000")
    ).toBe(1);
    expect(
      maximumDecimalString("99999999999999999999", "100000000000000000000")
    ).toBe("100000000000000000000");
  });
});

function createFixture(input: { readonly cursor: string | null }) {
  const repository = new MemoryGmailMonitoringRepository(input.cursor);
  const api = new FakeGmailApi();
  const provider = new FakeGoogleProvider();
  const alerts = new FakeAlertRepository();
  const logs: Array<{ readonly event: string; readonly metadata?: object }> =
    [];
  const tokenEncryption: TokenEncryptionProvider = {
    encrypt: async (plaintext) => ({
      ciphertext: `encrypted:${plaintext}`,
      provider: "TEST",
      keyVersion: "v1"
    }),
    decrypt: async () => "synthetic-refresh-token"
  };
  const service = new GmailMonitoringService({
    repository,
    api,
    googleProvider: provider,
    tokenEncryption,
    alertService: new AlertService({
      repository: alerts as unknown as AlertRepository,
      now: () => now
    }),
    topicName: "projects/call-now/topics/gmail-push",
    renewBeforeHours: 48,
    historyRecoveryLookbackHours: 72,
    now: () => now,
    logger: {
      info: (event, metadata) =>
        logs.push({ event, ...(metadata ? { metadata } : {}) }),
      warn: (event, metadata) =>
        logs.push({ event, ...(metadata ? { metadata } : {}) })
    }
  });
  return { repository, api, provider, alerts, logs, service };
}

class MemoryGmailMonitoringRepository implements GmailMonitoringRepository {
  public connection: GmailMonitoringConnection;
  public reauthorizationRequired = false;
  public recovered = false;
  private leaseToken: string | null = null;

  public constructor(cursor: string | null) {
    this.connection = {
      id: "10000000-0000-4000-8000-000000000001",
      teamId: "20000000-0000-4000-8000-000000000001",
      authorizationId: "30000000-0000-4000-8000-000000000001",
      email: "monitor@example.com",
      keywords: ["停電", "Call Now", "東京 電力"],
      providerCursor: cursor,
      lastSyncAt: null,
      providerSubscriptionExpiresAt: null,
      refreshToken: {
        ciphertext: "encrypted",
        provider: "TEST",
        keyVersion: "v1"
      }
    };
  }

  public async findEligibleByEmail(email: string) {
    return email === this.connection.email && !this.reauthorizationRequired
      ? [this.connection]
      : [];
  }

  public async findEligibleById(connectionId: string) {
    return connectionId === this.connection.id ? this.connection : null;
  }

  public async listWatchCandidates(renewBefore: Date) {
    const expiration = this.connection.providerSubscriptionExpiresAt;
    return !expiration || expiration <= renewBefore ? [this.connection] : [];
  }

  public async acquireSyncLease(input: {
    readonly connectionId: string;
    readonly leaseToken: string;
  }) {
    if (input.connectionId !== this.connection.id || this.leaseToken)
      return null;
    this.leaseToken = input.leaseToken;
    return this.connection;
  }

  public async releaseSyncLease(_connectionId: string, leaseToken: string) {
    if (this.leaseToken === leaseToken) this.leaseToken = null;
  }

  public async recordWatch(input: {
    readonly initialCursor: string;
    readonly expiration: Date;
  }) {
    this.connection = {
      ...this.connection,
      providerCursor: this.connection.providerCursor ?? input.initialCursor,
      providerSubscriptionExpiresAt: input.expiration
    };
    return true;
  }

  public async advanceCursor(input: GmailCursorUpdate) {
    if (this.leaseToken !== input.leaseToken) return false;
    this.connection = {
      ...this.connection,
      providerCursor: maximumDecimalString(
        this.connection.providerCursor,
        input.cursor
      ),
      lastSyncAt: input.now,
      providerSubscriptionExpiresAt:
        input.watch?.expiration ?? this.connection.providerSubscriptionExpiresAt
    };
    this.recovered = input.recovered ?? false;
    this.leaseToken = null;
    return true;
  }

  public async recordTransientFailure() {
    this.leaseToken = null;
  }

  public async markReauthorizationRequired() {
    this.reauthorizationRequired = true;
    this.leaseToken = null;
  }

  public async updateRefreshToken(input: {
    readonly refreshToken: StoredEncryptedToken;
  }) {
    this.connection = { ...this.connection, refreshToken: input.refreshToken };
  }
}

class FakeGoogleProvider implements MailProviderAdapter {
  public readonly provider = "GOOGLE" as const;
  public refreshError: unknown = null;

  public createAuthorizationUrl() {
    return "https://accounts.google.com/o/oauth2/v2/auth";
  }
  public async exchangeCode(): Promise<never> {
    throw new Error("not_used");
  }
  public async refreshAccessToken() {
    if (this.refreshError) throw asError(this.refreshError);
    return {
      accessToken: "synthetic-access-token",
      expiresAt: new Date(now.getTime() + 3_600_000),
      rotatedRefreshToken: null
    };
  }
  public async revokeAuthorization() {}
  public classifyProviderError(error: unknown): MailProviderErrorKind {
    const status = (error as { readonly status?: number })?.status;
    if (status === 401 || status === 403) return "REAUTHORIZATION_REQUIRED";
    if (status === 429) return "RATE_LIMITED";
    if (status && status >= 500) return "TRANSIENT";
    return "UNKNOWN";
  }
}

class FakeGmailApi implements GmailApiClient {
  public watchResults: GmailWatchResult[] = [];
  public historyPages: GmailHistoryPage[] = [];
  public historyErrors: unknown[] = [];
  public recentPages: GmailMessageListPage[] = [];
  public messages = new Map<string, GmailMessage>();
  public messageErrors = new Map<string, unknown>();
  public startWatchError: unknown = null;
  public startWatchCalls = 0;
  public getMessageCalls = 0;
  public recentAfter: Date[] = [];

  public async startWatch() {
    this.startWatchCalls += 1;
    if (this.startWatchError) throw asError(this.startWatchError);
    const result = this.watchResults.shift();
    if (!result) throw new Error("watch_result_missing");
    return result;
  }
  public async stopWatch() {}
  public async listHistory() {
    const error = this.historyErrors.shift();
    if (error) throw asError(error);
    const page = this.historyPages.shift();
    if (!page) throw new Error("history_page_missing");
    return page;
  }
  public async getMessage(_accessToken: string, messageId: string) {
    this.getMessageCalls += 1;
    const error = this.messageErrors.get(messageId);
    if (error) throw asError(error);
    const result = this.messages.get(messageId);
    if (!result) throw new Error("message_missing");
    return result;
  }
  public async listRecentInboxMessages(input: { readonly after: Date }) {
    this.recentAfter.push(input.after);
    const page = this.recentPages.shift();
    if (!page) throw new Error("recent_page_missing");
    return page;
  }
}

class FakeAlertRepository {
  public created: Array<{
    readonly sourceEventId: string;
    readonly kind: string;
    readonly matchedKeyword: string;
  }> = [];
  private readonly eventIds = new Set<string>();

  public async ingest(input: {
    readonly sourceEventId: string;
    readonly kind: "REAL" | "TEST";
    readonly matchedKeyword: string;
  }): Promise<AlertIngestionResult> {
    const created = !this.eventIds.has(input.sourceEventId);
    if (created) {
      this.eventIds.add(input.sourceEventId);
      this.created.push(input);
    }
    return {
      created,
      alert: {
        id: input.sourceEventId,
        teamId: "team",
        sourceMailConnectionId: "connection",
        sourceProvider: "GOOGLE",
        kind: input.kind,
        status: "ACTIVE",
        detectedAt: now,
        matchedKeyword: input.matchedKeyword,
        acknowledgedAt: null,
        acknowledgedBy: null,
        acknowledgedByName: null,
        readAt: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
        recipientCount: 1
      }
    };
  }
}

function historyPage(input: {
  readonly current: string;
  readonly next?: string;
  readonly records: readonly {
    readonly id: string;
    readonly messageIds: readonly string[];
  }[];
}): GmailHistoryPage {
  return {
    currentHistoryId: input.current,
    nextPageToken: input.next ?? null,
    history: input.records.map((record) => ({
      id: record.id,
      messagesAdded: record.messageIds.map((id) => ({
        message: { id, labelIds: ["INBOX"] }
      }))
    }))
  };
}

function message(
  id: string,
  subject: string,
  body: string,
  labelIds: readonly string[] = ["INBOX"]
): GmailMessage {
  return {
    id,
    internalDate: "1788436800000",
    labelIds,
    snippet: "",
    payload: {
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Subject", value: subject }],
      body: {
        size: Buffer.byteLength(body, "utf8"),
        data: body ? Buffer.from(body, "utf8").toString("base64url") : null,
        attachmentId: null
      },
      parts: []
    }
  };
}

function watch(historyId: string): GmailWatchResult {
  return {
    historyId,
    expiration: new Date("2026-09-10T00:00:00.000Z")
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("synthetic_test_error");
}
