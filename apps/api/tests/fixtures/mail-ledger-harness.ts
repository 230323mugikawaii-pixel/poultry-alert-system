import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../src/db/client.js";
import { AlertService } from "../../src/modules/alerts/alert-service.js";
import { PrismaAlertRepository } from "../../src/modules/alerts/prisma-alert-repository.js";
import {
  GmailApiRequestError,
  type GmailApiClient,
  type GmailMessage
} from "../../src/modules/mail/gmail/gmail-api-client.js";
import { GmailMonitoringService } from "../../src/modules/mail/gmail/gmail-monitoring-service.js";
import type { GmailMonitoringRepository } from "../../src/modules/mail/gmail/gmail-monitoring-repository.js";
import type { MailProviderAdapter } from "../../src/modules/mail/mail-provider.js";
import { PrismaMailLedger } from "../../src/modules/mail/reliability/prisma-mail-ledger.js";
import { mailReliabilityOptions } from "../../src/modules/mail/reliability/mail-reliability-options.js";

export const fixtureNow = new Date("2026-09-23T00:00:00.000Z");
export const syntheticBody = "SYNTHETIC_BODY_MUST_NOT_BE_PERSISTED 停電";

export function assertTestDatabase(value: string): void {
  let valid = false;
  try {
    const url = new URL(value);
    valid =
      ["localhost", "127.0.0.1", "postgres"].includes(url.hostname) &&
      /^\/callnow_(?:ledger_test|test|pr01_migration_test_[a-f0-9]+|pr03[ab]_test_[a-f0-9]+)$/.test(
        url.pathname
      );
  } catch {
    /* No URL in diagnostics. */
  }
  if (!valid || process.env.PR01_TEST_ISOLATION_ACK !== "disposable-postgres") {
    throw new Error(
      "PR01 requires an explicitly acknowledged disposable local PostgreSQL database"
    );
  }
}

export async function seedLedgerFixture(database: DatabaseClient) {
  const suffix = randomUUID();
  const owner = await database.user.create({
    data: { email: `${suffix}@example.invalid` }
  });
  // Deterministic free code in this isolated, serially-seeded test database.
  const usedCodes = new Set(
    (await database.team.findMany({ select: { publicCode: true } })).map(
      (row) => row.publicCode
    )
  );
  let code = 100000;
  while (usedCodes.has(String(code))) code += 1;
  const team = await database.team.create({
    data: {
      publicCode: String(code),
      memberships: { create: { userId: owner.id, role: "OWNER" } },
      subscription: {
        create: {
          seatLimit: 3,
          currentTermStartedAt: fixtureNow,
          currentTermEndsAt: new Date("2027-09-23T00:00:00Z")
        }
      }
    }
  });
  const authorization = await database.mailAuthorization.create({
    data: {
      userId: owner.id,
      provider: "GOOGLE",
      providerSubject: suffix,
      email: `${suffix}@example.invalid`
    }
  });
  const connection = await database.mailConnection.create({
    data: {
      teamId: team.id,
      mailAuthorizationId: authorization.id,
      provider: "GOOGLE",
      keywords: ["停電"],
      monitoringStartedAt: new Date(fixtureNow.getTime() - 60_000),
      providerCursor: "100"
    }
  });
  const member = await database.notificationMember.create({
    data: {
      teamId: team.id,
      callNowId: `CN-${suffix.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      displayName: "Synthetic PR01 recipient",
      passwordHash: "synthetic-non-login-hash"
    }
  });
  return { owner, team, authorization, connection, member };
}

export async function ledgerHarness(
  database: DatabaseClient,
  connectionId: string,
  options: {
    readonly mode?: "off" | "legacy" | "legacy-outbox";
    readonly reliabilityDatabase?: DatabaseClient;
    readonly messageId?: string;
    readonly message404?: boolean;
    readonly history404?: boolean;
    readonly getError?: Error;
    readonly message?: Partial<GmailMessage>;
    readonly beforeFetch?: () => Promise<void>;
    readonly afterAlert?: () => Promise<void>;
    readonly monitoringRepository?: GmailMonitoringRepository;
  } = {}
) {
  const row = await database.mailConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { mailAuthorization: true }
  });
  const connection = {
    id: row.id,
    teamId: row.teamId,
    authorizationId: row.mailAuthorizationId,
    email: row.mailAuthorization.email,
    keywords: row.keywords,
    providerCursor: "100",
    monitoringStartedAt: row.monitoringStartedAt,
    lastSyncAt: null,
    providerSubscriptionExpiresAt: null,
    refreshToken: {
      provider: "test",
      keyVersion: "test",
      ciphertext: "synthetic"
    }
  };
  const messageId = options.messageId ?? "18abcdef12345678";
  const calls = {
    fetch: 0,
    startWatch: 0,
    cursor: 0,
    alertsCreated: 0,
    sseWakeups: 0
  };
  const repository = new PrismaAlertRepository(database);
  const originalIngest = repository.ingest.bind(repository);
  repository.ingest = async (input) => {
    const result = await originalIngest(input);
    if (result.created) calls.alertsCreated += 1;
    await options.afterAlert?.();
    return result;
  };
  const alertService = new AlertService({ repository, now: () => fixtureNow });
  alertService.subscribeToIngestion(row.teamId, () => {
    calls.sseWakeups += 1;
  });
  // Deliberately admit 100 concurrent message deliveries: the production sync
  // lease normally serializes a connection, but PR01 must not depend on it.
  const monitoring: GmailMonitoringRepository = {
    findEligibleByEmail: async () => [connection],
    findEligibleById: async () => connection,
    listWatchCandidates: async () => [],
    acquireSyncLease: async () => connection,
    releaseSyncLease: async () => undefined,
    recordWatch: async () => true,
    advanceCursor: async () => {
      calls.cursor += 1;
      return true;
    },
    recordTransientFailure: async () => undefined,
    markReauthorizationRequired: async () => undefined,
    updateRefreshToken: async () => undefined
  };
  const api: GmailApiClient = {
    startWatch: async () => {
      calls.startWatch += 1;
      return { historyId: "300", expiration: fixtureNow };
    },
    stopWatch: async () => undefined,
    listHistory: async () => {
      if (options.history404)
        throw new GmailApiRequestError(404, "GMAIL_HTTP_404");
      return {
        history: [
          {
            id: "200",
            messagesAdded: [{ message: { id: messageId, labelIds: ["INBOX"] } }]
          }
        ],
        nextPageToken: null,
        currentHistoryId: "200"
      };
    },
    listRecentInboxMessages: async () => ({
      messageIds: [messageId],
      nextPageToken: null
    }),
    getMessage: async () => {
      calls.fetch += 1;
      await options.beforeFetch?.();
      if (options.message404)
        throw new GmailApiRequestError(404, "GMAIL_HTTP_404");
      if (options.getError) throw options.getError;
      return {
        id: messageId,
        internalDate: String(fixtureNow.getTime()),
        labelIds: ["INBOX"],
        snippet: "",
        payload: {
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: {
            size: 50,
            data: Buffer.from(syntheticBody).toString("base64url"),
            attachmentId: null
          },
          parts: []
        },
        ...options.message
      };
    }
  };
  const googleProvider = {
    provider: "GOOGLE",
    refreshAccessToken: async () => ({
      accessToken: "synthetic-only",
      rotatedRefreshToken: null
    }),
    classifyProviderError: () => "TRANSIENT"
  } as unknown as MailProviderAdapter;
  const reliability = mailReliabilityOptions(
    options.reliabilityDatabase ?? database,
    options.mode ?? "legacy"
  );
  const ledger = reliability.mailLedger ?? new PrismaMailLedger(database);
  if (reliability.atomicMailIngestion) {
    const atomic = reliability.atomicMailIngestion;
    const original = atomic.ingestMatched.bind(atomic);
    atomic.ingestMatched = async (entry, input) => {
      const result = await original(entry, input);
      if (result.created) calls.alertsCreated += 1;
      await options.afterAlert?.();
      return result;
    };
  }
  const service = new GmailMonitoringService({
    repository: options.monitoringRepository ?? monitoring,
    api,
    googleProvider,
    tokenEncryption: {
      encrypt: async () => connection.refreshToken,
      decrypt: async () => "synthetic-only"
    },
    alertService,
    topicName: "projects/synthetic/topics/synthetic",
    renewBeforeHours: 48,
    historyRecoveryLookbackHours: 72,
    now: () => fixtureNow,
    ...reliability
  });
  return {
    service,
    run: () => service.syncConnectionById(row.id, "200"),
    calls,
    ledger,
    connection,
    messageId
  };
}
