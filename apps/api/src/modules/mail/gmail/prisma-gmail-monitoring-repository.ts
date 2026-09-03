import type { DatabaseClient } from "../../../db/client.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { StoredEncryptedToken } from "../token-encryption.js";
import type {
  GmailCursorUpdate,
  GmailMonitoringConnection,
  GmailMonitoringRepository
} from "./gmail-monitoring-repository.js";

const eligibleWhere = {
  status: "ACTIVE" as const,
  team: {
    status: "ACTIVE" as const,
    subscription: { is: { status: "ACTIVE" as const } }
  },
  mailAuthorization: {
    provider: "GOOGLE" as const,
    status: "ACTIVE" as const,
    encryptedRefreshToken: { not: null },
    encryptionProvider: { not: null },
    encryptionKeyVersion: { not: null }
  }
};

const monitoringInclude = {
  mailAuthorization: true
} satisfies Prisma.MailConnectionInclude;

export class PrismaGmailMonitoringRepository implements GmailMonitoringRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async findEligibleByEmail(
    email: string
  ): Promise<readonly GmailMonitoringConnection[]> {
    const connections = await this.database.mailConnection.findMany({
      where: {
        ...eligibleWhere,
        mailAuthorization: { ...eligibleWhere.mailAuthorization, email }
      },
      include: monitoringInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    return connections.map(mapConnection).filter(isPresent);
  }

  public async findEligibleById(
    connectionId: string
  ): Promise<GmailMonitoringConnection | null> {
    const connection = await this.database.mailConnection.findFirst({
      where: { id: connectionId, ...eligibleWhere },
      include: monitoringInclude
    });
    return connection ? mapConnection(connection) : null;
  }

  public async listWatchCandidates(
    renewBefore: Date,
    limit: number
  ): Promise<readonly GmailMonitoringConnection[]> {
    const connections = await this.database.mailConnection.findMany({
      where: {
        ...eligibleWhere,
        OR: [
          { providerSubscriptionExpiresAt: null },
          { providerSubscriptionExpiresAt: { lte: renewBefore } }
        ]
      },
      include: monitoringInclude,
      orderBy: [{ providerSubscriptionExpiresAt: "asc" }, { createdAt: "asc" }],
      take: Math.min(Math.max(limit, 1), 1_000)
    });
    return connections.map(mapConnection).filter(isPresent);
  }

  public async acquireSyncLease(input: {
    readonly connectionId: string;
    readonly leaseToken: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<GmailMonitoringConnection | null> {
    const claimed = await this.database.mailConnection.updateMany({
      where: {
        id: input.connectionId,
        ...eligibleWhere,
        OR: [
          { syncLeaseToken: null },
          { syncLeaseExpiresAt: null },
          { syncLeaseExpiresAt: { lte: input.now } }
        ]
      },
      data: {
        syncLeaseToken: input.leaseToken,
        syncLeaseExpiresAt: input.expiresAt
      }
    });
    if (claimed.count !== 1) return null;
    const connection = await this.database.mailConnection.findFirst({
      where: {
        id: input.connectionId,
        syncLeaseToken: input.leaseToken,
        ...eligibleWhere
      },
      include: monitoringInclude
    });
    return connection ? mapConnection(connection) : null;
  }

  public async releaseSyncLease(
    connectionId: string,
    leaseToken: string
  ): Promise<void> {
    await this.database.mailConnection.updateMany({
      where: { id: connectionId, syncLeaseToken: leaseToken },
      data: { syncLeaseToken: null, syncLeaseExpiresAt: null }
    });
  }

  public async recordWatch(input: {
    readonly connectionId: string;
    readonly initialCursor: string;
    readonly expiration: Date;
    readonly renewedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const connection = await transaction.mailConnection.findFirst({
        where: { id: input.connectionId, ...eligibleWhere },
        select: { id: true, teamId: true, providerCursor: true }
      });
      if (!connection) return false;
      const started = connection.providerCursor === null;
      if (started) {
        await transaction.mailConnection.updateMany({
          where: { id: connection.id, providerCursor: null },
          data: { providerCursor: input.initialCursor }
        });
      }
      await transaction.mailConnection.update({
        where: { id: connection.id },
        data: {
          providerSubscriptionExpiresAt: input.expiration,
          providerSubscriptionRenewedAt: input.renewedAt,
          lastErrorCode: null
        }
      });
      await transaction.auditEvent.create({
        data: {
          teamId: connection.teamId,
          action: started ? "GMAIL_WATCH_STARTED" : "GMAIL_WATCH_RENEWED",
          targetType: "MailConnection",
          targetId: connection.id,
          metadata: { cursorInitialized: started }
        }
      });
      return true;
    });
  }

  public async advanceCursor(input: GmailCursorUpdate): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{
          id: string;
          teamId: string;
          providerCursor: string | null;
          syncLeaseToken: string | null;
        }>
      >(Prisma.sql`
        SELECT connection.id,
               connection."teamId",
               connection."providerCursor",
               connection."syncLeaseToken"
        FROM mail_connections AS connection
        JOIN mail_authorizations AS mail_authorization
          ON mail_authorization.id = connection."mailAuthorizationId"
        JOIN teams AS team ON team.id = connection."teamId"
        JOIN subscriptions AS subscription ON subscription."teamId" = team.id
        WHERE connection.id = ${input.connectionId}::uuid
          AND connection.status = 'ACTIVE'
          AND mail_authorization.provider = 'GOOGLE'
          AND mail_authorization.status = 'ACTIVE'
          AND team.status = 'ACTIVE'
          AND subscription.status = 'ACTIVE'
        FOR UPDATE OF connection
      `);
      const connection = locked[0];
      if (!connection || connection.syncLeaseToken !== input.leaseToken) {
        return false;
      }
      const cursor = maximumDecimalString(
        connection.providerCursor,
        input.cursor
      );
      await transaction.mailConnection.update({
        where: { id: connection.id },
        data: {
          providerCursor: cursor,
          lastSyncAt: input.now,
          lastErrorCode: null,
          syncLeaseToken: null,
          syncLeaseExpiresAt: null,
          ...(input.watch
            ? {
                providerSubscriptionExpiresAt: input.watch.expiration,
                providerSubscriptionRenewedAt: input.watch.renewedAt
              }
            : {})
        }
      });
      if (input.recovered) {
        await transaction.auditEvent.create({
          data: {
            teamId: connection.teamId,
            action: "GMAIL_HISTORY_RECOVERED",
            targetType: "MailConnection",
            targetId: connection.id
          }
        });
      }
      return true;
    });
  }

  public async recordTransientFailure(input: {
    readonly connectionId: string;
    readonly leaseToken?: string;
    readonly errorCode: string;
    readonly now: Date;
    readonly watchFailure?: boolean;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const connection = await transaction.mailConnection.findUnique({
        where: { id: input.connectionId },
        select: { id: true, teamId: true, syncLeaseToken: true }
      });
      if (!connection) return;
      if (
        input.leaseToken !== undefined &&
        connection.syncLeaseToken !== input.leaseToken
      ) {
        return;
      }
      await transaction.mailConnection.update({
        where: { id: connection.id },
        data: {
          lastErrorCode: input.errorCode.slice(0, 100),
          ...(input.leaseToken
            ? { syncLeaseToken: null, syncLeaseExpiresAt: null }
            : {})
        }
      });
      if (input.watchFailure) {
        await transaction.auditEvent.create({
          data: {
            teamId: connection.teamId,
            action: "GMAIL_WATCH_FAILED",
            targetType: "MailConnection",
            targetId: connection.id,
            metadata: { errorCode: input.errorCode.slice(0, 100) }
          }
        });
      }
    });
  }

  public async markReauthorizationRequired(input: {
    readonly authorizationId: string;
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.mailAuthorization.updateMany({
        where: { id: input.authorizationId, status: { not: "REVOKED" } },
        data: { status: "REAUTH_REQUIRED" }
      });
      const connections = await transaction.mailConnection.findMany({
        where: {
          mailAuthorizationId: input.authorizationId,
          status: { not: "REVOKED" }
        },
        select: { id: true, teamId: true }
      });
      await transaction.mailConnection.updateMany({
        where: {
          mailAuthorizationId: input.authorizationId,
          status: { not: "REVOKED" }
        },
        data: {
          status: "REAUTH_REQUIRED",
          lastErrorCode: input.errorCode.slice(0, 100),
          providerSubscriptionExpiresAt: null,
          providerSubscriptionRenewedAt: null,
          syncLeaseToken: null,
          syncLeaseExpiresAt: null
        }
      });
      for (const connection of connections) {
        await transaction.auditEvent.create({
          data: {
            teamId: connection.teamId,
            action: "GMAIL_REAUTH_REQUIRED",
            targetType: "MailConnection",
            targetId: connection.id,
            metadata: { errorCode: input.errorCode.slice(0, 100) }
          }
        });
      }
    });
  }

  public async updateRefreshToken(input: {
    readonly authorizationId: string;
    readonly refreshToken: StoredEncryptedToken;
    readonly now: Date;
  }): Promise<void> {
    await this.database.mailAuthorization.updateMany({
      where: { id: input.authorizationId, status: "ACTIVE" },
      data: {
        encryptedRefreshToken: input.refreshToken.ciphertext,
        encryptionProvider: input.refreshToken.provider,
        encryptionKeyVersion: input.refreshToken.keyVersion,
        lastVerifiedAt: input.now
      }
    });
  }
}

function mapConnection(connection: {
  readonly id: string;
  readonly teamId: string;
  readonly mailAuthorizationId: string;
  readonly keywords: readonly string[];
  readonly providerCursor: string | null;
  readonly lastSyncAt: Date | null;
  readonly providerSubscriptionExpiresAt: Date | null;
  readonly mailAuthorization: {
    readonly email: string;
    readonly encryptedRefreshToken: string | null;
    readonly encryptionProvider: string | null;
    readonly encryptionKeyVersion: string | null;
  };
}): GmailMonitoringConnection | null {
  const authorization = connection.mailAuthorization;
  if (
    !authorization.encryptedRefreshToken ||
    !authorization.encryptionProvider ||
    !authorization.encryptionKeyVersion
  ) {
    return null;
  }
  return {
    id: connection.id,
    teamId: connection.teamId,
    authorizationId: connection.mailAuthorizationId,
    email: authorization.email,
    keywords: [...connection.keywords],
    providerCursor: connection.providerCursor,
    lastSyncAt: connection.lastSyncAt,
    providerSubscriptionExpiresAt: connection.providerSubscriptionExpiresAt,
    refreshToken: {
      ciphertext: authorization.encryptedRefreshToken,
      provider: authorization.encryptionProvider,
      keyVersion: authorization.encryptionKeyVersion
    }
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export function maximumDecimalString(
  first: string | null,
  second: string
): string {
  if (!/^\d+$/u.test(second)) throw new Error("gmail_cursor_invalid");
  if (!first) return second;
  if (!/^\d+$/u.test(first)) throw new Error("gmail_cursor_invalid");
  const normalizedFirst = first.replace(/^0+(?=\d)/u, "");
  const normalizedSecond = second.replace(/^0+(?=\d)/u, "");
  if (normalizedFirst.length !== normalizedSecond.length) {
    return normalizedFirst.length > normalizedSecond.length
      ? normalizedFirst
      : normalizedSecond;
  }
  return normalizedFirst >= normalizedSecond
    ? normalizedFirst
    : normalizedSecond;
}
