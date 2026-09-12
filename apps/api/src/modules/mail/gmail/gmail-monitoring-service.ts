import { randomBytes } from "node:crypto";
import type { AlertService } from "../../alerts/alert-service.js";
import type { MailProviderAdapter } from "../mail-provider.js";
import type { TokenEncryptionProvider } from "../token-encryption.js";
import {
  GmailApiRequestError,
  type GmailApiClient,
  type GmailMessage
} from "./gmail-api-client.js";
import { findFirstMatchingKeyword } from "./gmail-keyword-matcher.js";
import { extractGmailMatchContent } from "./gmail-message-content.js";
import type {
  GmailMonitoringConnection,
  GmailMonitoringRepository
} from "./gmail-monitoring-repository.js";
import { maximumDecimalString } from "./prisma-gmail-monitoring-repository.js";

const SYNC_LEASE_MILLISECONDS = 2 * 60 * 1_000;
const MAX_HISTORY_PAGES = 100;
const MAX_RECOVERY_MESSAGES = 500;
const HISTORY_RECOVERY_OVERLAP_MILLISECONDS = 5 * 60 * 1_000;

export interface GmailMonitoringLogger {
  info(
    event: string,
    metadata?: Readonly<Record<string, number | boolean>>
  ): void;
  warn(
    event: string,
    metadata?: Readonly<Record<string, number | boolean>>
  ): void;
}

export interface GmailWatchRenewalResult {
  readonly attempted: number;
  readonly succeeded: number;
  readonly reauthorizationRequired: number;
  readonly failed: number;
  readonly busy: number;
}

export class GmailMonitoringTransientError extends Error {
  public constructor(public readonly errorCode: string) {
    super("gmail_monitoring_temporarily_unavailable");
    this.name = "GmailMonitoringTransientError";
  }
}

export class GmailMonitoringService {
  private readonly now: () => Date;
  private readonly logger: GmailMonitoringLogger;

  public constructor(
    private readonly options: {
      readonly repository: GmailMonitoringRepository;
      readonly api: GmailApiClient;
      readonly googleProvider: MailProviderAdapter;
      readonly tokenEncryption: TokenEncryptionProvider;
      readonly alertService: AlertService;
      readonly topicName: string;
      readonly renewBeforeHours: number;
      readonly historyRecoveryLookbackHours: number;
      readonly now?: () => Date;
      readonly logger?: GmailMonitoringLogger;
    }
  ) {
    if (options.googleProvider.provider !== "GOOGLE") {
      throw new Error("gmail_monitoring_requires_google_provider");
    }
    this.now = options.now ?? (() => new Date());
    this.logger =
      options.logger ??
      ({
        info: () => undefined,
        warn: () => undefined
      } satisfies GmailMonitoringLogger);
  }

  public async renewEligibleWatches(
    limit = 500
  ): Promise<GmailWatchRenewalResult> {
    const now = this.now();
    const renewBefore = new Date(
      now.getTime() + this.options.renewBeforeHours * 60 * 60 * 1_000
    );
    const candidates = await this.options.repository.listWatchCandidates(
      renewBefore,
      limit
    );
    const result = {
      attempted: candidates.length,
      succeeded: 0,
      reauthorizationRequired: 0,
      failed: 0,
      busy: 0
    };
    for (const candidate of candidates) {
      const leaseToken = randomBytes(24).toString("base64url");
      let leaseAcquired = false;
      try {
        const connection = await this.options.repository.acquireSyncLease({
          connectionId: candidate.id,
          leaseToken,
          now,
          expiresAt: new Date(now.getTime() + SYNC_LEASE_MILLISECONDS)
        });
        if (!connection) {
          result.busy += 1;
          continue;
        }
        leaseAcquired = true;
        const accessToken = await this.getAccessToken(connection);
        const watch = await this.options.api.startWatch(
          accessToken,
          this.options.topicName
        );
        const persisted = await this.options.repository.recordWatch({
          connectionId: connection.id,
          initialCursor: watch.historyId,
          expiration: watch.expiration,
          renewedAt: now
        });
        if (persisted) {
          result.succeeded += 1;
          this.logger.info(
            connection.providerCursor
              ? "gmail_watch_renewed"
              : "gmail_watch_started"
          );
        } else {
          result.busy += 1;
        }
      } catch (error) {
        const classification =
          this.options.googleProvider.classifyProviderError(error);
        if (
          classification === "REAUTHORIZATION_REQUIRED" ||
          classification === "CONSENT_REQUIRED" ||
          classification === "FORBIDDEN"
        ) {
          await this.options.repository.markReauthorizationRequired({
            authorizationId: candidate.authorizationId,
            errorCode: classification,
            now
          });
          result.reauthorizationRequired += 1;
          this.logger.warn("gmail_reauth_required");
          continue;
        }
        await this.options.repository.recordTransientFailure({
          connectionId: candidate.id,
          ...(leaseAcquired ? { leaseToken } : {}),
          errorCode: monitoringErrorCode(error),
          now,
          watchFailure: true
        });
        result.failed += 1;
        this.logger.warn("gmail_transient_error");
      } finally {
        if (leaseAcquired) {
          await this.options.repository.releaseSyncLease(
            candidate.id,
            leaseToken
          );
        }
      }
    }
    return result;
  }

  public async processPushNotification(input: {
    readonly emailAddress: string;
    readonly historyId: string;
  }): Promise<void> {
    const email = normalizeEmail(input.emailAddress);
    assertHistoryId(input.historyId);
    this.logger.info("gmail_push_received");
    const connections =
      await this.options.repository.findEligibleByEmail(email);
    const errors: GmailMonitoringTransientError[] = [];
    for (const connection of connections) {
      try {
        await this.syncConnection(connection.id, input.historyId);
      } catch (error) {
        if (error instanceof GmailMonitoringTransientError) errors.push(error);
        else throw error;
      }
    }
    const firstError = errors[0];
    if (firstError) throw firstError;
  }

  public async syncConnectionById(
    connectionId: string,
    targetHistoryId: string
  ): Promise<void> {
    assertHistoryId(targetHistoryId);
    const connection =
      await this.options.repository.findEligibleById(connectionId);
    if (!connection) return;
    await this.syncConnection(connection.id, targetHistoryId);
  }

  private async syncConnection(
    connectionId: string,
    targetHistoryId: string
  ): Promise<void> {
    const now = this.now();
    const leaseToken = randomBytes(24).toString("base64url");
    const connection = await this.options.repository.acquireSyncLease({
      connectionId,
      leaseToken,
      now,
      expiresAt: new Date(now.getTime() + SYNC_LEASE_MILLISECONDS)
    });
    if (!connection) {
      throw new GmailMonitoringTransientError("GMAIL_SYNC_BUSY");
    }

    try {
      const accessToken = await this.getAccessToken(connection);
      if (!connection.providerCursor) {
        throw new GmailMonitoringTransientError("GMAIL_CURSOR_NOT_INITIALIZED");
      }
      if (
        compareDecimalStrings(targetHistoryId, connection.providerCursor) <= 0
      ) {
        return;
      }
      try {
        await this.processHistory(
          connection,
          accessToken,
          leaseToken,
          targetHistoryId,
          now
        );
      } catch (error) {
        if (error instanceof GmailApiRequestError && error.status === 404) {
          await this.recoverHistory(connection, accessToken, leaseToken, now);
          return;
        }
        throw error;
      }
    } catch (error) {
      const classification =
        this.options.googleProvider.classifyProviderError(error);
      if (
        classification === "REAUTHORIZATION_REQUIRED" ||
        classification === "CONSENT_REQUIRED" ||
        classification === "FORBIDDEN"
      ) {
        await this.options.repository.markReauthorizationRequired({
          authorizationId: connection.authorizationId,
          errorCode: classification,
          now
        });
        this.logger.warn("gmail_reauth_required");
        return;
      }
      const errorCode = monitoringErrorCode(error);
      await this.options.repository.recordTransientFailure({
        connectionId: connection.id,
        leaseToken,
        errorCode,
        now
      });
      this.logger.warn("gmail_transient_error");
      throw new GmailMonitoringTransientError(errorCode);
    } finally {
      await this.options.repository.releaseSyncLease(connection.id, leaseToken);
    }
  }

  private async processHistory(
    connection: GmailMonitoringConnection,
    accessToken: string,
    leaseToken: string,
    targetHistoryId: string,
    now: Date
  ): Promise<void> {
    let pageToken: string | null = null;
    let highestHistoryId = targetHistoryId;
    const messageIds = new Set<string>();
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > MAX_HISTORY_PAGES) {
        throw new GmailMonitoringTransientError("GMAIL_HISTORY_PAGE_LIMIT");
      }
      const page = await this.options.api.listHistory({
        accessToken,
        startHistoryId: connection.providerCursor!,
        pageToken
      });
      highestHistoryId = maximumDecimalString(
        highestHistoryId,
        page.currentHistoryId
      );
      for (const history of page.history) {
        highestHistoryId = maximumDecimalString(highestHistoryId, history.id);
        for (const added of history.messagesAdded) {
          messageIds.add(added.message.id);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    for (const messageId of messageIds) {
      await this.processMessage(connection, accessToken, messageId, now);
    }
    const advanced = await this.options.repository.advanceCursor({
      connectionId: connection.id,
      leaseToken,
      cursor: highestHistoryId,
      now
    });
    if (!advanced) {
      throw new GmailMonitoringTransientError("GMAIL_SYNC_LEASE_LOST");
    }
    this.logger.info("gmail_history_processed", {
      messageCount: messageIds.size,
      pageCount
    });
    this.logger.info("gmail_cursor_advanced");
  }

  private async recoverHistory(
    connection: GmailMonitoringConnection,
    accessToken: string,
    leaseToken: string,
    now: Date
  ): Promise<void> {
    this.logger.warn("gmail_history_recovery_started");
    const watch = await this.options.api.startWatch(
      accessToken,
      this.options.topicName
    );
    const lookbackFloor =
      now.getTime() -
      this.options.historyRecoveryLookbackHours * 60 * 60 * 1_000;
    const lastSyncWithOverlap = connection.lastSyncAt
      ? connection.lastSyncAt.getTime() - HISTORY_RECOVERY_OVERLAP_MILLISECONDS
      : lookbackFloor;
    const after = new Date(Math.max(lookbackFloor, lastSyncWithOverlap));
    let pageToken: string | null = null;
    const messageIds = new Set<string>();
    do {
      const page = await this.options.api.listRecentInboxMessages({
        accessToken,
        after,
        pageToken
      });
      for (const messageId of page.messageIds) messageIds.add(messageId);
      if (
        messageIds.size > MAX_RECOVERY_MESSAGES ||
        (messageIds.size === MAX_RECOVERY_MESSAGES && page.nextPageToken)
      ) {
        throw new GmailMonitoringTransientError("GMAIL_HISTORY_RECOVERY_LIMIT");
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    for (const messageId of messageIds) {
      await this.processMessage(connection, accessToken, messageId, now);
    }
    const advanced = await this.options.repository.advanceCursor({
      connectionId: connection.id,
      leaseToken,
      cursor: watch.historyId,
      now,
      watch: { expiration: watch.expiration, renewedAt: now },
      recovered: true
    });
    if (!advanced) {
      throw new GmailMonitoringTransientError("GMAIL_SYNC_LEASE_LOST");
    }
    this.logger.info("gmail_history_recovered", {
      messageCount: messageIds.size
    });
  }

  private async processMessage(
    connection: GmailMonitoringConnection,
    accessToken: string,
    messageId: string,
    now: Date
  ): Promise<void> {
    let message: GmailMessage;
    try {
      message = await this.options.api.getMessage(accessToken, messageId);
    } catch (error) {
      if (error instanceof GmailApiRequestError && error.status === 404) return;
      throw error;
    }
    if (!isIncomingInboxMessage(message)) return;
    const matchedKeyword = findFirstMatchingKeyword(
      connection.keywords,
      extractGmailMatchContent(message)
    );
    if (!matchedKeyword) {
      this.logger.info("gmail_message_no_match");
      return;
    }
    await this.options.alertService.ingest({
      teamId: connection.teamId,
      sourceMailConnectionId: connection.id,
      sourceEventId: message.id,
      kind: "REAL",
      matchedKeyword,
      detectedAt: now
    });
    this.logger.info("gmail_message_matched");
  }

  private async getAccessToken(
    connection: GmailMonitoringConnection
  ): Promise<string> {
    const refreshToken = await this.options.tokenEncryption.decrypt(
      connection.refreshToken
    );
    const refreshed =
      await this.options.googleProvider.refreshAccessToken(refreshToken);
    if (refreshed.rotatedRefreshToken) {
      const encrypted = await this.options.tokenEncryption.encrypt(
        refreshed.rotatedRefreshToken
      );
      await this.options.repository.updateRefreshToken({
        authorizationId: connection.authorizationId,
        refreshToken: encrypted,
        now: this.now()
      });
    }
    return refreshed.accessToken;
  }
}

function isIncomingInboxMessage(message: GmailMessage): boolean {
  const labels = new Set(message.labelIds.map((label) => label.toUpperCase()));
  return (
    labels.has("INBOX") &&
    !["SENT", "DRAFT", "TRASH", "SPAM"].some((label) => labels.has(label))
  );
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new Error("gmail_push_email_invalid");
  }
  return email;
}

function assertHistoryId(value: string): void {
  if (!/^\d{1,64}$/u.test(value)) {
    throw new Error("gmail_push_history_id_invalid");
  }
}

export function compareDecimalStrings(first: string, second: string): number {
  assertHistoryId(first);
  assertHistoryId(second);
  const normalizedFirst = first.replace(/^0+(?=\d)/u, "");
  const normalizedSecond = second.replace(/^0+(?=\d)/u, "");
  if (normalizedFirst.length !== normalizedSecond.length) {
    return normalizedFirst.length > normalizedSecond.length ? 1 : -1;
  }
  return normalizedFirst === normalizedSecond
    ? 0
    : normalizedFirst > normalizedSecond
      ? 1
      : -1;
}

function monitoringErrorCode(error: unknown): string {
  if (error instanceof GmailMonitoringTransientError) return error.errorCode;
  if (error instanceof GmailApiRequestError) return error.errorCode;
  return "GMAIL_MONITORING_ERROR";
}
