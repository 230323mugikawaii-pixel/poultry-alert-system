import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type {
  MailConnectionRecord,
  MailConnectionRepository,
  MailDisconnectResult,
  MailGrantPersistenceResult,
  MailOAuthChallengeRecord,
  MailOAuthIntent,
  ProviderToken
} from "./mail-connection-repository.js";
import type { MailProviderId } from "./mail-provider.js";
import type { StoredEncryptedToken } from "./token-encryption.js";

export class PrismaMailConnectionRepository implements MailConnectionRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createOAuthChallenge(input: {
    readonly userId: string;
    readonly teamId: string;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly intent: MailOAuthIntent;
    readonly provider: MailProviderId;
    readonly connectionId: string | null;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(
      async (transaction) => {
        await transaction.authChallenge.updateMany({
          where: {
            userId: input.userId,
            kind: challengeKindFor(input.provider),
            consumedAt: null
          },
          data: { consumedAt: input.now }
        });
        await transaction.authChallenge.create({
          data: {
            userId: input.userId,
            kind:
              input.provider === "GOOGLE"
                ? "GMAIL_OAUTH"
                : "MICROSOFT_MAIL_OAUTH",
            secretHash: input.secretHash,
            payload: {
              teamId: input.teamId,
              codeVerifier: input.codeVerifier,
              nonce: input.nonce,
              intent: input.intent,
              provider: input.provider,
              connectionId: input.connectionId
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
  ): Promise<MailOAuthChallengeRecord | null> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash }
            });
            if (
              !challenge ||
              !isMailChallengeKind(challenge.kind) ||
              challenge.userId !== expectedUserId ||
              challenge.consumedAt ||
              challenge.expiresAt <= now ||
              challenge.attemptCount >= challenge.maxAttempts
            ) {
              return null;
            }
            const payload = parseChallengePayload(challenge.payload);
            if (
              !payload ||
              challengeKindFor(payload.provider) !== challenge.kind
            ) {
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
          "MAIL_AUTHORIZATION_CONFLICT",
          "メール連携が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async listConnections(
    teamId: string,
    ownerUserId: string
  ): Promise<readonly MailConnectionRecord[]> {
    await this.assertOwner(this.database, teamId, ownerUserId);
    const connections = await this.database.mailConnection.findMany({
      where: { teamId, status: { not: "REVOKED" } },
      include: { mailAuthorization: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    return connections.map(mapConnection);
  }

  public async findConnectionById(
    teamId: string,
    ownerUserId: string,
    connectionId: string
  ): Promise<MailConnectionRecord | null> {
    await this.assertOwner(this.database, teamId, ownerUserId);
    const connection = await this.database.mailConnection.findFirst({
      where: { id: connectionId, teamId, status: { not: "REVOKED" } },
      include: { mailAuthorization: true }
    });
    return connection ? mapConnection(connection) : null;
  }

  public saveGrant(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly intent: MailOAuthIntent;
    readonly connectionId: string | null;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailGrantPersistenceResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await this.assertOwner(
              transaction,
              input.teamId,
              input.ownerUserId
            );
            const subjectOwner = await transaction.mailAuthorization.findUnique(
              {
                where: {
                  provider_providerSubject: {
                    provider: input.provider,
                    providerSubject: input.providerSubject
                  }
                }
              }
            );
            if (subjectOwner && subjectOwner.userId !== input.ownerUserId) {
              throw new AppError(
                "MAIL_ACCOUNT_ALREADY_IN_USE",
                "このメールアカウントは別のCall Now利用者に接続されています。",
                409
              );
            }
            const targetConnection = input.connectionId
              ? await transaction.mailConnection.findFirst({
                  where: {
                    id: input.connectionId,
                    teamId: input.teamId,
                    status: { not: "REVOKED" }
                  },
                  include: { mailAuthorization: true }
                })
              : null;
            if (input.intent === "REAUTHORIZE" && !targetConnection) {
              throw new AppError(
                "MAIL_CONNECTION_NOT_FOUND",
                "再認証するメール監視アカウントが見つかりません。",
                404
              );
            }
            if (
              targetConnection &&
              (targetConnection.mailAuthorization.provider !== input.provider ||
                targetConnection.mailAuthorization.providerSubject !==
                  input.providerSubject)
            ) {
              throw new AppError(
                "MAIL_REAUTH_ACCOUNT_MISMATCH",
                "再認証では同じメールアカウントを選択してください。別のアカウントは新しく追加できます。",
                409
              );
            }

            const existingAuthorization =
              targetConnection?.mailAuthorization ?? subjectOwner;
            const obsoleteTokens: ProviderToken[] = [];
            const previousToken = toProviderToken(existingAuthorization);
            if (previousToken) obsoleteTokens.push(previousToken);

            const authorization = existingAuthorization
              ? await transaction.mailAuthorization.update({
                  where: { id: existingAuthorization.id },
                  data: {
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
              : await transaction.mailAuthorization.create({
                  data: {
                    userId: input.ownerUserId,
                    provider: input.provider,
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
              await transaction.mailConnection.findMany({
                where: {
                  mailAuthorizationId: authorization.id,
                  teamId: { not: input.teamId },
                  status: "REAUTH_REQUIRED"
                },
                select: { id: true, teamId: true }
              });
            if (restoredConnections.length > 0) {
              await transaction.mailConnection.updateMany({
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
                    action: "MAIL_REAUTHORIZED",
                    targetType: "MailConnection",
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

            const connection = await transaction.mailConnection.upsert({
              where: {
                teamId_mailAuthorizationId: {
                  teamId: input.teamId,
                  mailAuthorizationId: authorization.id
                }
              },
              create: {
                teamId: input.teamId,
                mailAuthorizationId: authorization.id,
                status: "ACTIVE"
              },
              update: {
                status: "ACTIVE",
                providerCursor: null,
                lastSyncAt: null,
                lastErrorCode: null,
                revokedAt: null
              },
              include: { mailAuthorization: true }
            });

            const action =
              input.intent === "REAUTHORIZE" || targetConnection
                ? "MAIL_REAUTHORIZED"
                : "MAIL_CONNECTED";
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.ownerUserId,
                action,
                targetType: "MailConnection",
                targetId: connection.id,
                requestId: input.requestId,
                metadata: {
                  authorizationStatus: "ACTIVE",
                  provider: input.provider,
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
          "MAIL_CONNECTION_CONFLICT",
          "メール連携が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public disconnect(input: {
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly connectionId?: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<MailDisconnectResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            await this.assertOwner(
              transaction,
              input.teamId,
              input.ownerUserId
            );
            const connection = await transaction.mailConnection.findFirst({
              where: {
                teamId: input.teamId,
                ...(input.connectionId ? { id: input.connectionId } : {}),
                status: { not: "REVOKED" }
              },
              include: { mailAuthorization: true }
            });
            if (!connection) {
              throw new AppError(
                "MAIL_CONNECTION_NOT_FOUND",
                "メール監視アカウントは接続されていません。",
                404
              );
            }
            if (connection.status === "REVOKED") {
              return { tokenToRevoke: null };
            }
            await transaction.mailConnection.update({
              where: { id: connection.id },
              data: {
                status: "REVOKED",
                providerCursor: null,
                lastErrorCode: null,
                revokedAt: input.now
              }
            });
            const remainingConnections = await transaction.mailConnection.count(
              {
                where: {
                  mailAuthorizationId: connection.mailAuthorizationId,
                  status: { not: "REVOKED" }
                }
              }
            );
            let tokenToRevoke: ProviderToken | null = null;
            if (remainingConnections === 0) {
              tokenToRevoke = toProviderToken(connection.mailAuthorization);
              await transaction.mailAuthorization.update({
                where: { id: connection.mailAuthorizationId },
                data: {
                  status: "REVOKED",
                  encryptedRefreshToken: null,
                  encryptionProvider: null,
                  encryptionKeyVersion: null,
                  revokedAt: input.now
                }
              });
              await transaction.auditEvent.create({
                data: {
                  teamId: input.teamId,
                  actorUserId: input.ownerUserId,
                  action: "MAIL_AUTHORIZATION_REVOKED",
                  targetType: "MailAuthorization",
                  targetId: connection.mailAuthorizationId,
                  requestId: input.requestId,
                  metadata: {
                    provider: connection.mailAuthorization.provider,
                    reason: "LAST_CONNECTION_DISCONNECTED"
                  }
                }
              });
            }
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.ownerUserId,
                action: "MAIL_CONNECTION_DISCONNECTED",
                targetType: "MailConnection",
                targetId: connection.id,
                requestId: input.requestId,
                metadata: {
                  provider: connection.mailAuthorization.provider,
                  credentialDisabled: remainingConnections === 0
                }
              }
            });
            return { tokenToRevoke };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "MAIL_DISCONNECT_CONFLICT",
          "メール接続解除が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async markAuthorizationFailure(input: {
    readonly authorizationId: string;
    readonly status: "REAUTH_REQUIRED" | "ERROR";
    readonly errorCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.mailAuthorization.updateMany({
        where: { id: input.authorizationId, status: { not: "REVOKED" } },
        data: { status: input.status }
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
          status: input.status,
          lastErrorCode: input.errorCode
        }
      });
      for (const connection of connections) {
        await transaction.auditEvent.create({
          data: {
            teamId: connection.teamId,
            action:
              input.status === "REAUTH_REQUIRED"
                ? "MAIL_AUTHORIZATION_REAUTH_REQUIRED"
                : "MAIL_AUTHORIZATION_ERROR",
            targetType: "MailConnection",
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
): Omit<MailOAuthChallengeRecord, "userId"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const teamId = readString(value.teamId);
  const codeVerifier = readString(value.codeVerifier);
  const nonce = readString(value.nonce);
  const intent = value.intent;
  const provider = value.provider;
  const connectionIdValue = value.connectionId;
  const connectionId =
    connectionIdValue === null || connectionIdValue === undefined
      ? null
      : readString(connectionIdValue);
  if (
    !teamId ||
    !codeVerifier ||
    !nonce ||
    (provider !== "GOOGLE" && provider !== "MICROSOFT") ||
    (intent !== "CONNECT" && intent !== "REAUTHORIZE") ||
    (connectionIdValue !== null &&
      connectionIdValue !== undefined &&
      !connectionId)
  ) {
    return null;
  }
  return { teamId, codeVerifier, nonce, intent, provider, connectionId };
}

function readString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

function toProviderToken(
  value: {
    readonly provider: MailProviderId;
    readonly encryptedRefreshToken: string | null;
    readonly encryptionProvider: string | null;
    readonly encryptionKeyVersion: string | null;
  } | null
): ProviderToken | null {
  return value?.encryptedRefreshToken &&
    value.encryptionProvider &&
    value.encryptionKeyVersion
    ? {
        provider: value.provider,
        token: {
          ciphertext: value.encryptedRefreshToken,
          provider: value.encryptionProvider,
          keyVersion: value.encryptionKeyVersion
        }
      }
    : null;
}

function deduplicateTokens(
  tokens: readonly ProviderToken[]
): readonly ProviderToken[] {
  return [
    ...new Map(
      tokens.map((token) => [
        `${token.provider}:${token.token.ciphertext}`,
        token
      ])
    ).values()
  ];
}

function mapConnection(connection: {
  readonly id: string;
  readonly teamId: string;
  readonly mailAuthorizationId: string;
  readonly status: MailConnectionRecord["connectionStatus"];
  readonly lastSyncAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly mailAuthorization: {
    readonly provider: MailProviderId;
    readonly email: string;
    readonly status: MailConnectionRecord["authorizationStatus"];
    readonly grantedScopes: readonly string[];
    readonly lastVerifiedAt: Date | null;
  };
}): MailConnectionRecord {
  return {
    id: connection.id,
    teamId: connection.teamId,
    authorizationId: connection.mailAuthorizationId,
    provider: connection.mailAuthorization.provider,
    email: connection.mailAuthorization.email,
    authorizationStatus: connection.mailAuthorization.status,
    connectionStatus: connection.status,
    grantedScopes: connection.mailAuthorization.grantedScopes,
    lastVerifiedAt: connection.mailAuthorization.lastVerifiedAt,
    lastSyncAt: connection.lastSyncAt,
    lastErrorCode: connection.lastErrorCode
  };
}

function isMailChallengeKind(
  value: string
): value is "GMAIL_OAUTH" | "MICROSOFT_MAIL_OAUTH" {
  return value === "GMAIL_OAUTH" || value === "MICROSOFT_MAIL_OAUTH";
}

function challengeKindFor(
  provider: MailProviderId
): "GMAIL_OAUTH" | "MICROSOFT_MAIL_OAUTH" {
  return provider === "GOOGLE" ? "GMAIL_OAUTH" : "MICROSOFT_MAIL_OAUTH";
}
