import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  GmailConnectionRecord,
  GmailConnectionRepository,
  GmailDisconnectResult,
  GmailGrantPersistenceResult,
  GmailOAuthChallengeRecord,
  GmailOAuthIntent
} from "./gmail-connection-repository.js";
import type { StoredEncryptedToken } from "./token-encryption.js";

export class PrismaGmailConnectionRepository implements GmailConnectionRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createOAuthChallenge(input: {
    readonly userId: string;
    readonly teamId: string;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly intent: GmailOAuthIntent;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(
      async (transaction) => {
        await transaction.authChallenge.updateMany({
          where: {
            userId: input.userId,
            kind: "GMAIL_OAUTH",
            consumedAt: null
          },
          data: { consumedAt: input.now }
        });
        await transaction.authChallenge.create({
          data: {
            userId: input.userId,
            kind: "GMAIL_OAUTH",
            secretHash: input.secretHash,
            payload: {
              teamId: input.teamId,
              codeVerifier: input.codeVerifier,
              nonce: input.nonce,
              intent: input.intent
            },
            expiresAt: input.expiresAt,
            maxAttempts: 1
          }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public consumeOAuthChallenge(
    secretHash: string,
    expectedUserId: string,
    now: Date
  ): Promise<GmailOAuthChallengeRecord | null> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash }
            });
            if (
              !challenge ||
              challenge.kind !== "GMAIL_OAUTH" ||
              challenge.userId !== expectedUserId ||
              challenge.consumedAt ||
              challenge.expiresAt <= now ||
              challenge.attemptCount >= challenge.maxAttempts
            ) {
              return null;
            }
            const payload = parseChallengePayload(challenge.payload);
            if (!payload) {
              return null;
            }
            const consumed = await transaction.authChallenge.updateMany({
              where: {
                id: challenge.id,
                userId: expectedUserId,
                consumedAt: null,
                expiresAt: { gt: now },
                attemptCount: { lt: challenge.maxAttempts }
              },
              data: { consumedAt: now, attemptCount: { increment: 1 } }
            });
            return consumed.count === 1
              ? { userId: expectedUserId, ...payload }
              : null;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "GMAIL_AUTHORIZATION_CONFLICT",
          "Gmail連携が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async findConnection(
    teamId: string,
    ownerUserId: string
  ): Promise<GmailConnectionRecord | null> {
    await this.assertOwner(this.database, teamId, ownerUserId);
    const connection = await this.database.gmailConnection.findUnique({
      where: { teamId },
      include: { gmailAuthorization: true }
    });
    return connection ? mapConnection(connection) : null;
  }

  public saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: GmailOAuthIntent;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<GmailGrantPersistenceResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await this.assertOwner(
              transaction,
              input.teamId,
              input.ownerUserId
            );
            const existingAuthorization =
              await transaction.gmailAuthorization.findUnique({
                where: { userId: input.ownerUserId }
              });
            const subjectOwner =
              await transaction.gmailAuthorization.findUnique({
                where: {
                  provider_providerSubject: {
                    provider: "GOOGLE",
                    providerSubject: input.providerSubject
                  }
                },
                select: { userId: true }
              });
            if (subjectOwner && subjectOwner.userId !== input.ownerUserId) {
              throw new AppError(
                "GMAIL_ACCOUNT_ALREADY_IN_USE",
                "このGmailアカウントは別のCall Now利用者に接続されています。",
                409
              );
            }

            const previousConnection =
              await transaction.gmailConnection.findUnique({
                where: { teamId: input.teamId },
                include: { gmailAuthorization: true }
              });
            const obsoleteTokens: StoredEncryptedToken[] = [];
            const previousToken = toStoredToken(existingAuthorization);
            if (previousToken) {
              obsoleteTokens.push(previousToken);
            }

            const accountChanged =
              Boolean(existingAuthorization) &&
              existingAuthorization?.providerSubject !== input.providerSubject;
            const authorization = existingAuthorization
              ? await transaction.gmailAuthorization.update({
                  where: { id: existingAuthorization.id },
                  data: {
                    providerSubject: input.providerSubject,
                    email: input.email,
                    encryptedRefreshToken: input.encryptedToken.ciphertext,
                    encryptionProvider: input.encryptedToken.provider,
                    encryptionKeyVersion: input.encryptedToken.keyVersion,
                    grantedScopes: [...input.grantedScopes],
                    status: "ACTIVE",
                    lastVerifiedAt: input.now,
                    revokedAt: null
                  }
                })
              : await transaction.gmailAuthorization.create({
                  data: {
                    userId: input.ownerUserId,
                    provider: "GOOGLE",
                    providerSubject: input.providerSubject,
                    email: input.email,
                    encryptedRefreshToken: input.encryptedToken.ciphertext,
                    encryptionProvider: input.encryptedToken.provider,
                    encryptionKeyVersion: input.encryptedToken.keyVersion,
                    grantedScopes: [...input.grantedScopes],
                    status: "ACTIVE",
                    lastVerifiedAt: input.now
                  }
                });

            const restoredConnections =
              await transaction.gmailConnection.findMany({
                where: {
                  gmailAuthorizationId: authorization.id,
                  teamId: { not: input.teamId },
                  status: "REAUTH_REQUIRED"
                },
                select: { id: true, teamId: true }
              });
            if (restoredConnections.length > 0) {
              await transaction.gmailConnection.updateMany({
                where: {
                  id: { in: restoredConnections.map(({ id }) => id) },
                  status: "REAUTH_REQUIRED"
                },
                data: {
                  status: "ACTIVE",
                  lastErrorCode: null,
                  revokedAt: null
                }
              });
              for (const restoredConnection of restoredConnections) {
                await transaction.auditEvent.create({
                  data: {
                    teamId: restoredConnection.teamId,
                    actorUserId: input.ownerUserId,
                    action: "GMAIL_REAUTHORIZED",
                    targetType: "GmailConnection",
                    targetId: restoredConnection.id,
                    requestId: input.requestId,
                    metadata: {
                      authorizationStatus: "ACTIVE",
                      restoredBySharedAuthorization: true
                    }
                  }
                });
              }
            }

            const connection = await transaction.gmailConnection.upsert({
              where: { teamId: input.teamId },
              create: {
                teamId: input.teamId,
                gmailAuthorizationId: authorization.id,
                status: "ACTIVE"
              },
              update: {
                gmailAuthorizationId: authorization.id,
                status: "ACTIVE",
                historyId: null,
                lastSyncAt: null,
                lastErrorCode: null,
                revokedAt: null
              },
              include: { gmailAuthorization: true }
            });

            const oldAuthorization = previousConnection?.gmailAuthorization;
            if (oldAuthorization && oldAuthorization.id !== authorization.id) {
              const activeReferences = await transaction.gmailConnection.count({
                where: {
                  gmailAuthorizationId: oldAuthorization.id,
                  status: { not: "REVOKED" }
                }
              });
              if (activeReferences === 0) {
                const oldToken = toStoredToken(oldAuthorization);
                if (oldToken) {
                  obsoleteTokens.push(oldToken);
                }
                await transaction.gmailAuthorization.update({
                  where: { id: oldAuthorization.id },
                  data: {
                    status: "REVOKED",
                    encryptedRefreshToken: null,
                    encryptionProvider: null,
                    encryptionKeyVersion: null,
                    revokedAt: input.now
                  }
                });
              }
            }

            const action = accountChanged
              ? "GMAIL_ACCOUNT_CHANGED"
              : input.intent === "REAUTHORIZE" || previousConnection
                ? "GMAIL_REAUTHORIZED"
                : "GMAIL_CONNECTED";
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.ownerUserId,
                action,
                targetType: "GmailConnection",
                targetId: connection.id,
                requestId: input.requestId,
                metadata: {
                  authorizationStatus: "ACTIVE",
                  grantedScopeCount: input.grantedScopes.length
                }
              }
            });
            return {
              connection: mapConnection(connection),
              obsoleteTokens: deduplicateTokens(obsoleteTokens)
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "GMAIL_CONNECTION_CONFLICT",
          "Gmail連携が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<GmailDisconnectResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await this.assertOwner(
              transaction,
              input.teamId,
              input.ownerUserId
            );
            const connection = await transaction.gmailConnection.findUnique({
              where: { teamId: input.teamId },
              include: { gmailAuthorization: true }
            });
            if (!connection) {
              throw new AppError(
                "GMAIL_CONNECTION_NOT_FOUND",
                "Gmail監視アカウントは接続されていません。",
                404
              );
            }
            if (connection.status === "REVOKED") {
              return { tokenToRevoke: null };
            }
            await transaction.gmailConnection.update({
              where: { id: connection.id },
              data: {
                status: "REVOKED",
                historyId: null,
                lastErrorCode: null,
                revokedAt: input.now
              }
            });
            const remainingConnections =
              await transaction.gmailConnection.count({
                where: {
                  gmailAuthorizationId: connection.gmailAuthorizationId,
                  status: { not: "REVOKED" }
                }
              });
            let tokenToRevoke: StoredEncryptedToken | null = null;
            if (remainingConnections === 0) {
              tokenToRevoke = toStoredToken(connection.gmailAuthorization);
              await transaction.gmailAuthorization.update({
                where: { id: connection.gmailAuthorizationId },
                data: {
                  status: "REVOKED",
                  encryptedRefreshToken: null,
                  encryptionProvider: null,
                  encryptionKeyVersion: null,
                  revokedAt: input.now
                }
              });
            }
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.ownerUserId,
                action: "GMAIL_CONNECTION_DISCONNECTED",
                targetType: "GmailConnection",
                targetId: connection.id,
                requestId: input.requestId,
                metadata: { credentialDisabled: remainingConnections === 0 }
              }
            });
            return { tokenToRevoke };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "GMAIL_DISCONNECT_CONFLICT",
          "Gmail接続解除が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async markAuthorizationRequiresReauth(input: {
    readonly authorizationId: string;
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.gmailAuthorization.updateMany({
        where: { id: input.authorizationId, status: { not: "REVOKED" } },
        data: { status: "REAUTH_REQUIRED" }
      });
      const connections = await transaction.gmailConnection.findMany({
        where: {
          gmailAuthorizationId: input.authorizationId,
          status: { not: "REVOKED" }
        },
        select: { id: true, teamId: true }
      });
      await transaction.gmailConnection.updateMany({
        where: {
          gmailAuthorizationId: input.authorizationId,
          status: { not: "REVOKED" }
        },
        data: {
          status: "REAUTH_REQUIRED",
          lastErrorCode: input.errorCode
        }
      });
      for (const connection of connections) {
        await transaction.auditEvent.create({
          data: {
            teamId: connection.teamId,
            action: "GMAIL_CREDENTIAL_REAUTH_REQUIRED",
            targetType: "GmailConnection",
            targetId: connection.id,
            metadata: { errorCode: input.errorCode }
          }
        });
      }
    });
  }

  private async assertOwner(
    database: DatabaseClient | Prisma.TransactionClient,
    teamId: string,
    userId: string
  ): Promise<void> {
    const owner = await database.teamMembership.findFirst({
      where: {
        teamId,
        userId,
        role: "OWNER",
        status: "ACTIVE",
        team: { status: "ACTIVE" }
      },
      select: { id: true }
    });
    if (!owner) {
      throw new AppError(
        "OWNER_REQUIRED",
        "この操作はチームの代表者だけが実行できます。",
        403
      );
    }
  }
}

function parseChallengePayload(
  value: Prisma.JsonValue | null
): Omit<GmailOAuthChallengeRecord, "userId"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const teamId = readString(value.teamId);
  const codeVerifier = readString(value.codeVerifier);
  const nonce = readString(value.nonce);
  const intent = value.intent;
  if (
    !teamId ||
    !codeVerifier ||
    !nonce ||
    (intent !== "CONNECT" && intent !== "REAUTHORIZE")
  ) {
    return null;
  }
  return { teamId, codeVerifier, nonce, intent };
}

function readString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

function toStoredToken(
  value: {
    readonly encryptedRefreshToken: string | null;
    readonly encryptionProvider: string | null;
    readonly encryptionKeyVersion: string | null;
  } | null
): StoredEncryptedToken | null {
  return value?.encryptedRefreshToken &&
    value.encryptionProvider &&
    value.encryptionKeyVersion
    ? {
        ciphertext: value.encryptedRefreshToken,
        provider: value.encryptionProvider,
        keyVersion: value.encryptionKeyVersion
      }
    : null;
}

function deduplicateTokens(
  tokens: readonly StoredEncryptedToken[]
): readonly StoredEncryptedToken[] {
  return [
    ...new Map(tokens.map((token) => [token.ciphertext, token])).values()
  ];
}

function mapConnection(connection: {
  readonly id: string;
  readonly teamId: string;
  readonly gmailAuthorizationId: string;
  readonly status: GmailConnectionRecord["connectionStatus"];
  readonly lastSyncAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly gmailAuthorization: {
    readonly email: string;
    readonly status: GmailConnectionRecord["authorizationStatus"];
    readonly grantedScopes: readonly string[];
    readonly lastVerifiedAt: Date | null;
  };
}): GmailConnectionRecord {
  return {
    id: connection.id,
    teamId: connection.teamId,
    authorizationId: connection.gmailAuthorizationId,
    email: connection.gmailAuthorization.email,
    authorizationStatus: connection.gmailAuthorization.status,
    connectionStatus: connection.status,
    grantedScopes: connection.gmailAuthorization.grantedScopes,
    lastVerifiedAt: connection.gmailAuthorization.lastVerifiedAt,
    lastSyncAt: connection.lastSyncAt,
    lastErrorCode: connection.lastErrorCode
  };
}
