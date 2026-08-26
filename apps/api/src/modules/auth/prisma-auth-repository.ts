import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { AppError } from "../../lib/app-error.js";
import type {
  AuthRepository,
  AuthSessionRecord,
  AuthUserRecord,
  CreateGoogleOAuthChallengeInput,
  CreateMagicLinkChallengeInput,
  CreateSessionInput,
  ResolveGoogleUserInput
} from "./auth-repository.js";

export class PrismaAuthRepository implements AuthRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createMagicLinkChallenge(
    input: CreateMagicLinkChallengeInput
  ): Promise<void> {
    const now = new Date();
    await this.database.$transaction(
      async (transaction) => {
        await transaction.authChallenge.updateMany({
          where: {
            email: input.email,
            kind: "MAGIC_LINK",
            consumedAt: null
          },
          data: { consumedAt: now }
        });
        await transaction.authChallenge.create({
          data: {
            email: input.email,
            kind: "MAGIC_LINK",
            secretHash: input.secretHash,
            expiresAt: input.expiresAt,
            maxAttempts: 1
          }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async createGoogleOAuthChallenge(
    input: CreateGoogleOAuthChallengeInput
  ): Promise<void> {
    await this.database.authChallenge.create({
      data: {
        kind: "GOOGLE_OAUTH",
        secretHash: input.secretHash,
        payload: { codeVerifier: input.codeVerifier, nonce: input.nonce },
        expiresAt: input.expiresAt,
        maxAttempts: 1
      }
    });
  }

  public async consumeGoogleOAuthChallenge(
    secretHash: string,
    now: Date
  ): Promise<{
    readonly codeVerifier: string;
    readonly nonce: string;
  } | null> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash }
            });
            if (
              !challenge ||
              challenge.kind !== "GOOGLE_OAUTH" ||
              challenge.consumedAt ||
              challenge.expiresAt <= now ||
              challenge.attemptCount >= challenge.maxAttempts
            ) {
              return null;
            }

            const codeVerifier = readCodeVerifier(challenge.payload);
            const nonce = readNonce(challenge.payload);
            if (!codeVerifier || !nonce) {
              return null;
            }

            const consumed = await transaction.authChallenge.updateMany({
              where: {
                id: challenge.id,
                consumedAt: null,
                expiresAt: { gt: now },
                attemptCount: { lt: challenge.maxAttempts }
              },
              data: { consumedAt: now, attemptCount: { increment: 1 } }
            });
            return consumed.count === 1 ? { codeVerifier, nonce } : null;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "GOOGLE_LOGIN_CONFLICT",
          "Googleログインが競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async resolveGoogleUser(
    input: ResolveGoogleUserInput
  ): Promise<AuthUserRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const identity = await transaction.externalIdentity.findUnique({
              where: {
                provider_providerSubject: {
                  provider: "GOOGLE",
                  providerSubject: input.providerSubject
                }
              },
              include: { user: true }
            });

            if (identity) {
              if (identity.revokedAt) {
                throw new AppError(
                  "GOOGLE_IDENTITY_REVOKED",
                  "このGoogleアカウントのログイン連携は解除されています。",
                  403
                );
              }
              await transaction.externalIdentity.update({
                where: { id: identity.id },
                data: {
                  email: input.email,
                  emailVerified: input.emailVerified,
                  lastUsedAt: input.now
                }
              });
              const user = await transaction.user.update({
                where: { id: identity.userId },
                data: {
                  email: input.email,
                  displayName: input.displayName,
                  emailVerifiedAt: input.emailVerified
                    ? (identity.user.emailVerifiedAt ?? input.now)
                    : identity.user.emailVerifiedAt
                }
              });
              return mapUser(user);
            }

            const emailUser = await transaction.user.findUnique({
              where: { email: input.email }
            });
            if (emailUser) {
              throw new AppError(
                "GOOGLE_ACCOUNT_LINK_REQUIRED",
                "同じメールアドレスの利用者が存在します。先に既存の方法でログインしてGoogleアカウントを連携してください。",
                409
              );
            }

            const user = await transaction.user.create({
              data: {
                email: input.email,
                displayName: input.displayName,
                emailVerifiedAt: input.emailVerified ? input.now : null,
                externalIdentities: {
                  create: {
                    provider: "GOOGLE",
                    providerSubject: input.providerSubject,
                    email: input.email,
                    emailVerified: input.emailVerified,
                    lastUsedAt: input.now
                  }
                }
              }
            });
            return mapUser(user);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "GOOGLE_LOGIN_CONFLICT",
          "Googleログインが競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async consumeMagicLink(
    secretHash: string,
    now: Date
  ): Promise<AuthUserRecord | null> {
    return this.database.$transaction(
      async (transaction) => {
        const challenge = await transaction.authChallenge.findUnique({
          where: { secretHash }
        });

        if (
          !challenge ||
          challenge.kind !== "MAGIC_LINK" ||
          !challenge.email ||
          challenge.consumedAt ||
          challenge.expiresAt <= now ||
          challenge.attemptCount >= challenge.maxAttempts
        ) {
          return null;
        }

        const consumed = await transaction.authChallenge.updateMany({
          where: {
            id: challenge.id,
            consumedAt: null,
            expiresAt: { gt: now },
            attemptCount: { lt: challenge.maxAttempts }
          },
          data: {
            consumedAt: now,
            attemptCount: { increment: 1 }
          }
        });

        if (consumed.count !== 1) {
          return null;
        }

        const user = await transaction.user.upsert({
          where: { email: challenge.email },
          create: {
            email: challenge.email,
            emailVerifiedAt: now
          },
          update: {
            emailVerifiedAt: now
          }
        });

        return mapUser(user);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async createSession(
    input: CreateSessionInput
  ): Promise<AuthSessionRecord> {
    const now = new Date();
    return this.database.$transaction(
      async (transaction) => {
        const activeSessions = await transaction.session.findMany({
          where: {
            userId: input.userId,
            revokedAt: null,
            idleExpiresAt: { gt: now },
            expiresAt: { gt: now }
          },
          orderBy: { createdAt: "asc" },
          select: { id: true }
        });

        const sessionsToRevoke =
          activeSessions.length - input.maxActiveSessions + 1;
        if (sessionsToRevoke > 0) {
          await transaction.session.updateMany({
            where: {
              id: {
                in: activeSessions
                  .slice(0, sessionsToRevoke)
                  .map(({ id }) => id)
              }
            },
            data: { revokedAt: now }
          });
        }

        const device = await transaction.device.create({
          data: {
            userId: input.userId,
            name: input.deviceName,
            userAgentHash: input.userAgentHash,
            lastSeenAt: now
          }
        });

        const session = await transaction.session.create({
          data: {
            userId: input.userId,
            deviceId: device.id,
            tokenHash: input.tokenHash,
            ipHash: input.ipHash,
            userAgentHash: input.userAgentHash,
            idleExpiresAt: input.idleExpiresAt,
            expiresAt: input.expiresAt
          },
          include: { device: true }
        });

        return mapSession(session);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async findActiveSession(
    tokenHash: string,
    now: Date
  ): Promise<{
    readonly user: AuthUserRecord;
    readonly session: AuthSessionRecord;
  } | null> {
    const session = await this.database.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        expiresAt: { gt: now },
        user: {
          status: "ACTIVE",
          deletedAt: null
        }
      },
      include: { user: true, device: true }
    });

    if (!session) {
      return null;
    }

    return {
      user: mapUser(session.user),
      session: mapSession(session)
    };
  }

  public async touchSession(
    sessionId: string,
    now: Date,
    idleExpiresAt: Date
  ): Promise<void> {
    await this.database.$transaction([
      this.database.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { lastSeenAt: now, idleExpiresAt }
      }),
      this.database.device.updateMany({
        where: { sessions: { some: { id: sessionId } }, revokedAt: null },
        data: { lastSeenAt: now }
      })
    ]);
  }

  public async listSessions(
    userId: string
  ): Promise<readonly AuthSessionRecord[]> {
    const sessions = await this.database.session.findMany({
      where: { userId, revokedAt: null },
      include: { device: true },
      orderBy: { lastSeenAt: "desc" }
    });

    return sessions.map(mapSession);
  }

  public async revokeSession(
    userId: string,
    sessionId: string,
    now: Date
  ): Promise<boolean> {
    const result = await this.database.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: now }
    });
    return result.count === 1;
  }

  public async revokeAllSessions(userId: string, now: Date): Promise<void> {
    await this.database.$transaction([
      this.database.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now }
      }),
      this.database.device.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now }
      })
    ]);
  }
}

function readCodeVerifier(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const codeVerifier = value.codeVerifier;
  return typeof codeVerifier === "string" ? codeVerifier : null;
}

function readNonce(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const nonce = value.nonce;
  return typeof nonce === "string" ? nonce : null;
}

function mapUser(user: {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: "ACTIVE" | "LOCKED" | "DELETED";
}): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status
  };
}

function mapSession(session: {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly device: { readonly name: string | null } | null;
}): AuthSessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    deviceName: session.device?.name ?? null,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt
  };
}
