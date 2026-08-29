import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type { ProviderToken } from "../mail/mail-connection-repository.js";
import type { MailProviderId } from "../mail/mail-provider.js";
import type { StoredEncryptedToken } from "../mail/token-encryption.js";
import type {
  OwnerOnboardingChallengeRecord,
  OwnerOnboardingRecord,
  OwnerOnboardingRepository
} from "./owner-onboarding-repository.js";

export class PrismaOwnerOnboardingRepository implements OwnerOnboardingRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createOAuthChallenge(input: {
    readonly provider: MailProviderId;
    readonly userId: string | null;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    await this.database.$transaction(
      async (transaction) => {
        if (input.userId) {
          await transaction.authChallenge.updateMany({
            where: {
              userId: input.userId,
              kind: challengeKind(input.provider),
              consumedAt: null
            },
            data: { consumedAt: input.now }
          });
        }
        await transaction.authChallenge.create({
          data: {
            userId: input.userId,
            kind: challengeKind(input.provider),
            secretHash: input.secretHash,
            payload: {
              flow: "OWNER_ONBOARDING",
              provider: input.provider,
              codeVerifier: input.codeVerifier,
              nonce: input.nonce
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
    provider: MailProviderId,
    expectedUserId: string | null,
    now: Date
  ): Promise<OwnerOnboardingChallengeRecord | null> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const challenge = await transaction.authChallenge.findUnique({
              where: { secretHash }
            });
            const payload = parseChallenge(challenge?.payload);
            if (
              !challenge ||
              challenge.kind !== challengeKind(provider) ||
              challenge.userId !== expectedUserId ||
              challenge.consumedAt ||
              challenge.expiresAt <= now ||
              challenge.attemptCount >= challenge.maxAttempts ||
              !payload ||
              payload.provider !== provider
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
                  provider,
                  userId: challenge.userId,
                  codeVerifier: payload.codeVerifier,
                  nonce: payload.nonce
                }
              : null;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public savePendingAuthorization(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly expiresAt: Date;
    readonly now: Date;
  }) {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const subjectAuthorization =
              await transaction.mailAuthorization.findUnique({
                where: {
                  provider_providerSubject: {
                    provider: input.provider,
                    providerSubject: input.providerSubject
                  }
                }
              });
            if (
              subjectAuthorization &&
              subjectAuthorization.userId !== input.userId
            ) {
              throw new AppError(
                "MAIL_ACCOUNT_ALREADY_IN_USE",
                "このメールアカウントは別のCall Now利用者に設定されています。",
                409
              );
            }
            const obsoleteTokens: ProviderToken[] = [];
            const previousToken = toProviderToken(subjectAuthorization);
            if (previousToken) obsoleteTokens.push(previousToken);
            const authorization = subjectAuthorization
              ? await transaction.mailAuthorization.update({
                  where: { id: subjectAuthorization.id },
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
                    userId: input.userId,
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

            const activeMembership = await transaction.teamMembership.findFirst(
              {
                where: {
                  userId: input.userId,
                  status: "ACTIVE",
                  team: { status: "ACTIVE" }
                },
                select: { id: true }
              }
            );
            if (activeMembership) {
              await transaction.mailConnection.updateMany({
                where: {
                  mailAuthorizationId: authorization.id,
                  status: { in: ["REAUTH_REQUIRED", "ERROR"] }
                },
                data: { status: "ACTIVE", lastErrorCode: null, revokedAt: null }
              });
              return {
                onboarding: null,
                hasExistingTeam: true,
                obsoleteTokens
              };
            }

            const onboarding = await transaction.ownerOnboarding.upsert({
              where: { userId: input.userId },
              create: {
                userId: input.userId,
                status: "PENDING",
                expiresAt: input.expiresAt
              },
              update: {
                teamId: null,
                status: "PENDING",
                expiresAt: input.expiresAt,
                purchasedAt: null,
                completedAt: null,
                abandonedAt: null
              }
            });
            await transaction.onboardingMailChoice.upsert({
              where: {
                onboardingId_provider: {
                  onboardingId: onboarding.id,
                  provider: input.provider
                }
              },
              create: {
                onboardingId: onboarding.id,
                provider: input.provider,
                mailAuthorizationId: authorization.id,
                status: "AUTHORIZED"
              },
              update: {
                mailAuthorizationId: authorization.id,
                status: "AUTHORIZED",
                keywords: [],
                keywordsConfirmedAt: null
              }
            });
            return {
              onboarding: await findOnboarding(transaction, onboarding.id),
              hasExistingTeam: false,
              obsoleteTokens
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public async getCurrent(
    userId: string
  ): Promise<OwnerOnboardingRecord | null> {
    const onboarding = await this.database.ownerOnboarding.findUnique({
      where: { userId },
      include: choiceInclude
    });
    return onboarding ? mapOnboarding(onboarding) : null;
  }

  public skipProvider(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const onboarding = await lockPendingOnboarding(
              transaction,
              input.userId,
              input.now
            );
            const existing = await transaction.onboardingMailChoice.findUnique({
              where: {
                onboardingId_provider: {
                  onboardingId: onboarding.id,
                  provider: input.provider
                }
              }
            });
            if (existing?.mailAuthorizationId) {
              throw new AppError(
                "ONBOARDING_PROVIDER_ALREADY_AUTHORIZED",
                "設定済みのメールアカウントは購入後の確認画面で選択してください。",
                409
              );
            }
            await transaction.onboardingMailChoice.upsert({
              where: {
                onboardingId_provider: {
                  onboardingId: onboarding.id,
                  provider: input.provider
                }
              },
              create: {
                onboardingId: onboarding.id,
                provider: input.provider,
                status: "SKIPPED"
              },
              update: { status: "SKIPPED" }
            });
            return findOnboarding(transaction, onboarding.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public setChoiceKeywords(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly keywords: readonly string[];
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const onboarding = await lockPendingOnboarding(
              transaction,
              input.userId,
              input.now
            );
            const updated = await transaction.onboardingMailChoice.updateMany({
              where: {
                id: input.choiceId,
                onboardingId: onboarding.id,
                status: "AUTHORIZED",
                mailAuthorizationId: { not: null }
              },
              data: {
                keywords: [...input.keywords],
                keywordsConfirmedAt: input.now
              }
            });
            if (updated.count !== 1) throw invalidChoiceError();
            return findOnboarding(transaction, onboarding.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public activateChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const choice = await requirePurchasedChoice(
              transaction,
              input.userId,
              input.choiceId
            );
            if (!choice.mailAuthorizationId || !choice.onboarding.teamId) {
              throw invalidChoiceError();
            }
            if (
              !choice.mailAuthorization ||
              choice.mailAuthorization.status !== "ACTIVE" ||
              !choice.mailAuthorization.encryptedRefreshToken
            ) {
              throw new AppError(
                "MAIL_REAUTHORIZATION_REQUIRED",
                "このメールアカウントは再設定が必要です。",
                409
              );
            }
            await assertOwner(
              transaction,
              choice.onboarding.teamId,
              input.userId
            );
            const connection = await transaction.mailConnection.upsert({
              where: {
                teamId_mailAuthorizationId: {
                  teamId: choice.onboarding.teamId,
                  mailAuthorizationId: choice.mailAuthorizationId
                }
              },
              create: {
                teamId: choice.onboarding.teamId,
                mailAuthorizationId: choice.mailAuthorizationId,
                status: "ACTIVE",
                keywords: [...choice.keywords]
              },
              update: {
                status: "ACTIVE",
                keywords: [...choice.keywords],
                providerCursor: null,
                lastErrorCode: null,
                revokedAt: null
              }
            });
            await transaction.onboardingMailChoice.update({
              where: { id: choice.id },
              data: { status: "ACTIVATED" }
            });
            await transaction.auditEvent.create({
              data: {
                teamId: choice.onboarding.teamId,
                actorUserId: input.userId,
                action: "ONBOARDING_MAIL_MONITORING_ACTIVATED",
                targetType: "MailConnection",
                targetId: connection.id,
                requestId: input.requestId,
                metadata: { provider: choice.provider }
              }
            });
            await completeWhenSettled(
              transaction,
              choice.onboarding.id,
              input.now
            );
            return findOnboarding(transaction, choice.onboarding.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public deferChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const choice = await requirePurchasedChoice(
              transaction,
              input.userId,
              input.choiceId
            );
            if (choice.status === "AUTHORIZED") {
              await transaction.onboardingMailChoice.update({
                where: { id: choice.id },
                data: { status: "DEFERRED" }
              });
            }
            await completeWhenSettled(
              transaction,
              choice.onboarding.id,
              input.now
            );
            return findOnboarding(transaction, choice.onboarding.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => conflictError()
    );
  }

  public async expireAbandoned(now: Date): Promise<readonly ProviderToken[]> {
    const candidates = await this.database.ownerOnboarding.findMany({
      where: { status: "PENDING", expiresAt: { lte: now } },
      include: choiceInclude
    });
    const tokens: ProviderToken[] = [];
    for (const candidate of candidates) {
      const expired = await this.database.$transaction(async (transaction) => {
        const updated = await transaction.ownerOnboarding.updateMany({
          where: {
            id: candidate.id,
            status: "PENDING",
            expiresAt: { lte: now }
          },
          data: { status: "EXPIRED", abandonedAt: now }
        });
        if (updated.count !== 1) return [];
        const revoked: ProviderToken[] = [];
        for (const choice of candidate.choices) {
          const authorization = choice.mailAuthorization;
          if (
            !authorization?.encryptedRefreshToken ||
            !authorization.encryptionProvider ||
            !authorization.encryptionKeyVersion
          ) {
            continue;
          }
          const activeConnections = await transaction.mailConnection.count({
            where: {
              mailAuthorizationId: authorization.id,
              status: { not: "REVOKED" }
            }
          });
          if (activeConnections > 0) continue;
          revoked.push({
            provider: authorization.provider,
            token: {
              ciphertext: authorization.encryptedRefreshToken,
              provider: authorization.encryptionProvider,
              keyVersion: authorization.encryptionKeyVersion
            }
          });
          await transaction.mailAuthorization.update({
            where: { id: authorization.id },
            data: {
              status: "REVOKED",
              encryptedRefreshToken: null,
              encryptionProvider: null,
              encryptionKeyVersion: null,
              revokedAt: now
            }
          });
        }
        return revoked;
      });
      tokens.push(...expired);
    }
    return tokens;
  }
}

const choiceInclude = {
  choices: {
    include: { mailAuthorization: true },
    orderBy: { provider: "asc" as const }
  }
};

async function findOnboarding(
  transaction: Prisma.TransactionClient,
  id: string
): Promise<OwnerOnboardingRecord> {
  return mapOnboarding(
    await transaction.ownerOnboarding.findUniqueOrThrow({
      where: { id },
      include: choiceInclude
    })
  );
}

function mapOnboarding(input: {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly status: OwnerOnboardingRecord["status"];
  readonly seatCount: number | null;
  readonly keywords: readonly string[];
  readonly expiresAt: Date;
  readonly purchasedAt: Date | null;
  readonly completedAt: Date | null;
  readonly choices: readonly {
    readonly id: string;
    readonly provider: MailProviderId;
    readonly status: OwnerOnboardingRecord["choices"][number]["status"];
    readonly mailAuthorizationId: string | null;
    readonly mailAuthorization: { readonly email: string } | null;
    readonly keywords: readonly string[];
    readonly keywordsConfirmedAt: Date | null;
  }[];
}): OwnerOnboardingRecord {
  return {
    id: input.id,
    userId: input.userId,
    teamId: input.teamId,
    status: input.status,
    seatCount: input.seatCount,
    keywords: [...input.keywords],
    expiresAt: input.expiresAt,
    purchasedAt: input.purchasedAt,
    completedAt: input.completedAt,
    choices: input.choices.map((choice) => ({
      id: choice.id,
      provider: choice.provider,
      status: choice.status,
      authorizationId: choice.mailAuthorizationId,
      email: choice.mailAuthorization?.email ?? null,
      keywords: [...choice.keywords],
      keywordsConfirmedAt: choice.keywordsConfirmedAt
    }))
  };
}

async function lockPendingOnboarding(
  transaction: Prisma.TransactionClient,
  userId: string,
  now: Date
) {
  const onboarding = await transaction.ownerOnboarding.findUnique({
    where: { userId }
  });
  if (
    !onboarding ||
    onboarding.status !== "PENDING" ||
    onboarding.expiresAt <= now
  ) {
    throw new AppError(
      "OWNER_ONBOARDING_NOT_AVAILABLE",
      "初期設定をもう一度開始してください。",
      409
    );
  }
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM owner_onboardings WHERE id = ${onboarding.id}::uuid FOR UPDATE`
  );
  return transaction.ownerOnboarding.findUniqueOrThrow({
    where: { id: onboarding.id }
  });
}

async function requirePurchasedChoice(
  transaction: Prisma.TransactionClient,
  userId: string,
  choiceId: string
) {
  const choice = await transaction.onboardingMailChoice.findFirst({
    where: { id: choiceId, onboarding: { userId } },
    include: { onboarding: true, mailAuthorization: true }
  });
  if (
    !choice ||
    !["PURCHASED", "COMPLETED"].includes(choice.onboarding.status) ||
    !["AUTHORIZED", "DEFERRED", "ACTIVATED"].includes(choice.status)
  ) {
    throw invalidChoiceError();
  }
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM owner_onboardings WHERE id = ${choice.onboarding.id}::uuid FOR UPDATE`
  );
  return choice;
}

async function completeWhenSettled(
  transaction: Prisma.TransactionClient,
  onboardingId: string,
  now: Date
): Promise<void> {
  const pending = await transaction.onboardingMailChoice.count({
    where: { onboardingId, status: "AUTHORIZED" }
  });
  if (pending === 0) {
    await transaction.ownerOnboarding.update({
      where: { id: onboardingId },
      data: { status: "COMPLETED", completedAt: now }
    });
  }
}

async function assertOwner(
  transaction: Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<void> {
  const owner = await transaction.teamMembership.findFirst({
    where: { teamId, userId, role: "OWNER", status: "ACTIVE" },
    select: { id: true }
  });
  if (!owner) {
    throw new AppError(
      "OWNER_REQUIRED",
      "メール監視アカウントの変更は管理者のみ行えます。",
      403
    );
  }
}

function parseChallenge(value: Prisma.JsonValue | null | undefined): {
  readonly provider: MailProviderId;
  readonly codeVerifier: string;
  readonly nonce: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.flow !== "OWNER_ONBOARDING") return null;
  const provider = value.provider;
  const codeVerifier = value.codeVerifier;
  const nonce = value.nonce;
  return (provider === "GOOGLE" || provider === "MICROSOFT") &&
    typeof codeVerifier === "string" &&
    typeof nonce === "string"
    ? { provider, codeVerifier, nonce }
    : null;
}

function challengeKind(provider: MailProviderId) {
  return provider === "GOOGLE" ? "GMAIL_OAUTH" : "MICROSOFT_MAIL_OAUTH";
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

function invalidChoiceError(): AppError {
  return new AppError(
    "ONBOARDING_MAIL_CHOICE_INVALID",
    "監視アカウントの設定状態を確認できませんでした。",
    409
  );
}

function conflictError(): AppError {
  return new AppError(
    "OWNER_ONBOARDING_CONFLICT",
    "初期設定が競合しました。もう一度お試しください。",
    409
  );
}
