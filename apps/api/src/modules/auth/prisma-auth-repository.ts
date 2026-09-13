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
  CreatePrimaryOAuthChallengeInput,
  CreateSessionInput,
  PrimaryIdentityProvider,
  PrimaryIdentityRecord,
  PrimaryOAuthChallengeRecord,
  ResolvePrimaryIdentityInput,
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

  public async createPrimaryOAuthChallenge(
    input: CreatePrimaryOAuthChallengeInput
  ): Promise<void> {
    await this.database.authChallenge.create({
      data: {
        userId: input.userId,
        kind: primaryChallengeKind(input.provider),
        secretHash: input.secretHash,
        payload: {
          provider: input.provider,
          intent: input.intent,
          codeVerifier: input.codeVerifier,
          nonce: input.nonce
        },
        expiresAt: input.expiresAt,
        maxAttempts: 1
      }
    });
  }

  public consumePrimaryOAuthChallenge(
    secretHash: string,
    provider: PrimaryIdentityProvider,
    authenticatedUserId: string | null,
    now: Date
  ): Promise<PrimaryOAuthChallengeRecord | null> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash }
            });
            if (
              !challenge ||
              challenge.kind !== primaryChallengeKind(provider) ||
              challenge.consumedAt ||
              challenge.expiresAt <= now ||
              challenge.attemptCount >= challenge.maxAttempts
            ) {
              return null;
            }
            const parsed = readPrimaryChallenge(challenge.payload);
            if (!parsed || parsed.provider !== provider) {
              return null;
            }
            if (
              (parsed.intent === "LINK" &&
                (!challenge.userId ||
                  challenge.userId !== authenticatedUserId)) ||
              (parsed.intent === "LOGIN" && challenge.userId !== null)
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
              data: { consumedAt: now, attemptCount: { increment: 1 } }
            });
            return consumed.count === 1
              ? {
                  ...parsed,
                  userId: challenge.userId
                }
              : null;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "PRIMARY_LOGIN_CONFLICT",
          "ログイン処理が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async resolvePrimaryIdentityUser(
    input: ResolvePrimaryIdentityInput
  ): Promise<AuthUserRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const identity = await transaction.externalIdentity.findUnique({
              where: {
                provider_providerSubject: {
                  provider: input.provider,
                  providerSubject: input.providerSubject
                }
              },
              include: { user: true }
            });
            if (identity) {
              if (identity.revokedAt) {
                throw new AppError(
                  "LOGIN_IDENTITY_REVOKED",
                  "このログイン方法は解除されています。別の方法でログインしてください。",
                  403
                );
              }
              await transaction.externalIdentity.update({
                where: { id: identity.id },
                data: {
                  ...(input.email ? { email: input.email } : {}),
                  emailVerified: input.email
                    ? input.emailVerified
                    : identity.emailVerified,
                  lastUsedAt: input.now
                }
              });
              const user = input.displayName
                ? await transaction.user.update({
                    where: { id: identity.userId },
                    data: { displayName: input.displayName }
                  })
                : identity.user;
              return mapUser(user);
            }

            const email = requireVerifiedEmail(input);
            const emailUser = await transaction.user.findUnique({
              where: { email }
            });
            if (emailUser) {
              throw new AppError(
                "LOGIN_IDENTITY_LINK_REQUIRED",
                "同じメールアドレスの利用者が存在します。既存の方法でログインしてから、このログイン方法を追加してください。",
                409
              );
            }
            const user = await transaction.user.create({
              data: {
                email,
                displayName: input.displayName,
                emailVerifiedAt: input.now,
                externalIdentities: {
                  create: {
                    provider: input.provider,
                    providerSubject: input.providerSubject,
                    email,
                    emailVerified: true,
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
          "PRIMARY_LOGIN_CONFLICT",
          "ログイン処理が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async linkPrimaryIdentity(
    userId: string,
    input: ResolvePrimaryIdentityInput
  ): Promise<PrimaryIdentityRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const email = requireVerifiedEmail(input);
            const subjectIdentity =
              await transaction.externalIdentity.findUnique({
                where: {
                  provider_providerSubject: {
                    provider: input.provider,
                    providerSubject: input.providerSubject
                  }
                }
              });
            if (subjectIdentity && subjectIdentity.userId !== userId) {
              throw new AppError(
                "LOGIN_IDENTITY_ALREADY_IN_USE",
                "このログイン方法は別のCall Nowアカウントに接続されています。",
                409
              );
            }
            const providerIdentity =
              await transaction.externalIdentity.findUnique({
                where: { userId_provider: { userId, provider: input.provider } }
              });
            if (
              providerIdentity &&
              !providerIdentity.revokedAt &&
              providerIdentity.providerSubject !== input.providerSubject
            ) {
              throw new AppError(
                "LOGIN_PROVIDER_ALREADY_LINKED",
                "このログイン方法はすでに別のアカウントで追加されています。",
                409
              );
            }
            const identity = providerIdentity
              ? await transaction.externalIdentity.update({
                  where: { id: providerIdentity.id },
                  data: {
                    providerSubject: input.providerSubject,
                    email,
                    emailVerified: true,
                    lastUsedAt: input.now,
                    revokedAt: null
                  }
                })
              : await transaction.externalIdentity.create({
                  data: {
                    userId,
                    provider: input.provider,
                    providerSubject: input.providerSubject,
                    email,
                    emailVerified: true,
                    lastUsedAt: input.now
                  }
                });
            await transaction.auditEvent.create({
              data: {
                actorUserId: userId,
                action: "LOGIN_IDENTITY_LINKED",
                targetType: "ExternalIdentity",
                targetId: identity.id,
                metadata: { provider: input.provider }
              }
            });
            return mapPrimaryIdentity(identity);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "LOGIN_IDENTITY_LINK_CONFLICT",
          "ログイン方法の追加が競合しました。もう一度お試しください。",
          409
        )
    );
  }

  public async listPrimaryIdentities(
    userId: string
  ): Promise<readonly PrimaryIdentityRecord[]> {
    const identities = await this.database.externalIdentity.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: "asc" }
    });
    return identities.map(mapPrimaryIdentity);
  }

  public async unlinkPrimaryIdentity(
    userId: string,
    provider: PrimaryIdentityProvider,
    now: Date
  ): Promise<void> {
    await retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const identities = await transaction.externalIdentity.findMany({
              where: { userId, revokedAt: null },
              select: { id: true, provider: true }
            });
            if (identities.length <= 1) {
              throw new AppError(
                "LAST_LOGIN_IDENTITY_REQUIRED",
                "最後のログイン方法は解除できません。先に別のログイン方法を追加してください。",
                409
              );
            }
            const target = identities.find(
              (identity) => identity.provider === provider
            );
            if (!target) {
              throw new AppError(
                "LOGIN_IDENTITY_NOT_FOUND",
                "このログイン方法は追加されていません。",
                404
              );
            }
            await transaction.externalIdentity.update({
              where: { id: target.id },
              data: { revokedAt: now }
            });
            await transaction.auditEvent.create({
              data: {
                actorUserId: userId,
                action: "LOGIN_IDENTITY_UNLINKED",
                targetType: "ExternalIdentity",
                targetId: target.id,
                metadata: { provider }
              }
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "LOGIN_IDENTITY_UNLINK_CONFLICT",
          "ログイン方法の解除が競合しました。もう一度お試しください。",
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

function readPrimaryChallenge(
  value: Prisma.JsonValue | null
): Omit<PrimaryOAuthChallengeRecord, "userId"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const provider = value.provider;
  const intent = value.intent;
  const codeVerifier = value.codeVerifier;
  const nonce = value.nonce;
  if (
    !isPrimaryIdentityProvider(provider) ||
    (intent !== "LOGIN" && intent !== "LINK") ||
    typeof codeVerifier !== "string" ||
    typeof nonce !== "string"
  ) {
    return null;
  }
  return { provider, intent, codeVerifier, nonce };
}

function primaryChallengeKind(
  provider: PrimaryIdentityProvider
): "GOOGLE_OAUTH" | "MICROSOFT_OAUTH" | "APPLE_OAUTH" {
  if (provider === "MICROSOFT") return "MICROSOFT_OAUTH";
  if (provider === "APPLE") return "APPLE_OAUTH";
  return "GOOGLE_OAUTH";
}

function isPrimaryIdentityProvider(
  value: unknown
): value is PrimaryIdentityProvider {
  return value === "GOOGLE" || value === "MICROSOFT" || value === "APPLE";
}

function requireVerifiedEmail(input: ResolvePrimaryIdentityInput): string {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (
    !input.emailVerified ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    email.length > 320
  ) {
    throw new AppError(
      "VERIFIED_EMAIL_REQUIRED",
      "確認済みメールアドレスを取得できませんでした。",
      401
    );
  }
  return email;
}

function mapPrimaryIdentity(identity: {
  readonly provider: PrimaryIdentityProvider;
  readonly email: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}): PrimaryIdentityRecord {
  return {
    provider: identity.provider,
    email: identity.email,
    linkedAt: identity.createdAt,
    lastUsedAt: identity.lastUsedAt
  };
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
