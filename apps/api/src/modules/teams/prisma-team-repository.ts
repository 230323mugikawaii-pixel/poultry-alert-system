import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { countOccupiedAdditionalSeats } from "../notification-members/prisma-notification-member-repository.js";
import { mergeTeamKeywordSets } from "./keyword-policy.js";
import {
  calculateAnnualPriceYen,
  calculateSeatSummary
} from "./seat-policy.js";
import type {
  AppliedContractChangeRecord,
  ContractChangeQuoteRecord,
  ContractConnectionSettings,
  CreateTeamInput,
  InvitationDraft,
  IssuedInvitationRecord,
  SeatLimitChangeResult,
  TeamCreationResult,
  TeamContextRecord,
  TeamMemberRecord,
  TeamRepository
} from "./team-repository.js";

export class PrismaTeamRepository implements TeamRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createTeam(input: CreateTeamInput): Promise<TeamCreationResult> {
    if (input.seatLimit > 0 && !input.initialInvitation) {
      throw new Error("initial_invitation_required");
    }
    try {
      return await this.database.$transaction(
        (transaction) => createTeamInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError("TEAM_CODE_CONFLICT", "Team code collision.", 409);
      }
      throw error;
    }
  }

  public async completeOwnerOnboardingPurchase(
    input: CreateTeamInput & { readonly onboardingId: string }
  ): Promise<TeamCreationResult> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const onboarding = await transaction.ownerOnboarding.findFirst({
                where: { id: input.onboardingId, userId: input.ownerUserId },
                include: {
                  choices: { include: { mailAuthorization: true } }
                }
              });
              if (!onboarding) throw onboardingNotAvailableError();
              await transaction.$queryRaw(
                Prisma.sql`SELECT id FROM owner_onboardings WHERE id = ${onboarding.id}::uuid FOR UPDATE`
              );
              const locked =
                await transaction.ownerOnboarding.findUniqueOrThrow({
                  where: { id: onboarding.id },
                  include: {
                    choices: { include: { mailAuthorization: true } }
                  }
                });
              if (
                (locked.status === "PURCHASED" ||
                  locked.status === "COMPLETED") &&
                locked.teamId
              ) {
                await activatePurchasedMonitoringChoices(transaction, {
                  onboardingId: locked.id,
                  teamId: locked.teamId,
                  ownerUserId: input.ownerUserId,
                  choices: locked.choices,
                  now: input.currentTermStartedAt
                });
                const existing = await findCurrentTeam(
                  transaction,
                  input.ownerUserId
                );
                if (!existing || existing.teamId !== locked.teamId) {
                  throw onboardingNotAvailableError();
                }
                return { team: existing, invitation: null };
              }
              if (
                locked.status !== "PENDING" ||
                locked.expiresAt <= input.currentTermStartedAt ||
                !locked.choices.some(
                  (choice) =>
                    choice.status === "AUTHORIZED" && choice.mailAuthorizationId
                )
              ) {
                throw onboardingNotAvailableError();
              }
              const authorizedChoices = locked.choices.filter(
                (choice) =>
                  choice.status === "AUTHORIZED" && choice.mailAuthorizationId
              );
              if (
                authorizedChoices.some(
                  (choice) =>
                    !choice.keywordsConfirmedAt || choice.keywords.length === 0
                )
              ) {
                throw new AppError(
                  "OWNER_ONBOARDING_KEYWORDS_INCOMPLETE",
                  "設定したすべての監視アカウントで通知キーワードを決定してください。",
                  409
                );
              }
              const lockedKeywords = mergeTeamKeywordSets(
                authorizedChoices.map((choice) => choice.keywords)
              );
              if (!sameKeywordSet(input.keywords, lockedKeywords)) {
                throw new AppError(
                  "OWNER_ONBOARDING_KEYWORDS_CHANGED",
                  "通知キーワードが変更されました。内容を確認してください。",
                  409
                );
              }
              const memberships = await transaction.teamMembership.count({
                where: { userId: input.ownerUserId }
              });
              if (memberships > 0) {
                throw new AppError(
                  "OWNER_ONBOARDING_TEAM_ALREADY_EXISTS",
                  "すでに利用中の契約があります。",
                  409
                );
              }
              const purchaseInput = {
                ...input,
                keywords: lockedKeywords,
                currentTermAmountYen: calculateAnnualPriceYen(
                  input.seatLimit,
                  lockedKeywords.length
                )
              };
              const created = await createTeamInTransaction(
                transaction,
                purchaseInput
              );
              await transaction.ownerOnboarding.update({
                where: { id: locked.id },
                data: {
                  teamId: created.team.teamId,
                  status: "PURCHASED",
                  seatCount: 1 + input.seatLimit,
                  keywords: lockedKeywords,
                  purchasedAt: input.currentTermStartedAt
                }
              });
              await activatePurchasedMonitoringChoices(transaction, {
                onboardingId: locked.id,
                teamId: created.team.teamId,
                ownerUserId: input.ownerUserId,
                choices: locked.choices,
                now: input.currentTermStartedAt
              });
              return created;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "OWNER_ONBOARDING_PURCHASE_CONFLICT",
            "購入手続きが競合しました。もう一度お試しください。",
            409
          )
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError("TEAM_CODE_CONFLICT", "Team code collision.", 409);
      }
      throw error;
    }
  }

  public async ensureInitialTeam(
    input: CreateTeamInput
  ): Promise<TeamContextRecord> {
    if (input.seatLimit !== 0 || input.initialInvitation) {
      throw new Error("initial_team_must_not_include_member_capacity");
    }
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const lockedUsers = await transaction.$queryRaw<
                Array<{ id: string }>
              >(
                Prisma.sql`SELECT id FROM users WHERE id = ${input.ownerUserId}::uuid FOR UPDATE`
              );
              if (lockedUsers.length !== 1) {
                throw new AppError(
                  "USER_NOT_FOUND",
                  "利用者情報が見つかりません。",
                  404
                );
              }

              const existing = await findCurrentTeam(
                transaction,
                input.ownerUserId
              );
              if (existing) {
                return existing;
              }

              const previousMemberships =
                await transaction.teamMembership.count({
                  where: { userId: input.ownerUserId }
                });
              if (previousMemberships > 0) {
                throw new AppError(
                  "INITIAL_TEAM_NOT_AVAILABLE",
                  "現在利用できる契約がありません。管理者へお問い合わせください。",
                  409
                );
              }

              return (await createTeamInTransaction(transaction, input)).team;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "INITIAL_TEAM_BOOTSTRAP_CONFLICT",
            "初期設定が競合しました。もう一度お試しください。",
            409
          )
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError("TEAM_CODE_CONFLICT", "Team code collision.", 409);
      }
      throw error;
    }
  }

  public async findCurrentTeam(
    userId: string
  ): Promise<TeamContextRecord | null> {
    return findCurrentTeam(this.database, userId);
  }

  public async findTeamForUser(
    userId: string,
    teamId: string
  ): Promise<TeamContextRecord | null> {
    const membership = await this.database.teamMembership.findFirst({
      where: {
        userId,
        teamId,
        status: "ACTIVE",
        team: { status: "ACTIVE" }
      },
      include: {
        team: {
          include: {
            subscription: true,
            keywords: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }
          }
        }
      }
    });
    if (!membership?.team.subscription) {
      return null;
    }

    const activeMemberCount = await countOccupiedAdditionalSeats(
      this.database,
      teamId
    );
    return mapTeamContext({
      team: membership.team,
      membership,
      subscription: membership.team.subscription,
      activeMemberCount
    });
  }

  public async listActiveMembers(
    teamId: string
  ): Promise<readonly TeamMemberRecord[]> {
    const memberships = await this.database.teamMembership.findMany({
      where: { teamId, status: "ACTIVE" },
      include: { user: true },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }]
    });

    return memberships.map((membership) => ({
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      displayName: membership.user.displayName,
      role: membership.role,
      joinedAt: membership.joinedAt
    }));
  }

  public updateContractSettings(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly {
      readonly connectionId: string;
      readonly keywords: readonly string[];
    }[];
    readonly currentTermAmountYen: number;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<TeamContextRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const membership = await transaction.teamMembership.findFirst({
              where: {
                teamId: input.teamId,
                userId: input.actorUserId,
                role: "OWNER",
                status: "ACTIVE",
                team: { status: "ACTIVE" }
              }
            });
            if (!membership) {
              throw new AppError(
                "OWNER_REQUIRED",
                "この操作はチームの代表者だけが実行できます。",
                403
              );
            }
            const subscriptionIdentity =
              await transaction.subscription.findUnique({
                where: { teamId: input.teamId },
                select: { id: true }
              });
            if (!subscriptionIdentity) {
              throw new AppError(
                "SUBSCRIPTION_NOT_FOUND",
                "契約が見つかりません。",
                404
              );
            }
            await transaction.$queryRaw(
              Prisma.sql`SELECT id FROM subscriptions WHERE id = ${subscriptionIdentity.id}::uuid FOR UPDATE`
            );
            const subscription =
              await transaction.subscription.findUniqueOrThrow({
                where: { id: subscriptionIdentity.id }
              });
            if (subscription.pendingSeatLimit !== null) {
              throw new AppError(
                "SUBSCRIPTION_CHANGE_PENDING",
                "利用人数の変更処理中です。完了後にもう一度お試しください。",
                409
              );
            }
            const occupied = await countOccupiedAdditionalSeats(
              transaction,
              input.teamId
            );
            if (input.seatLimit < occupied) {
              throw new AppError(
                "SEAT_LIMIT_BELOW_OCCUPANCY",
                "現在利用中の人数より少ない契約人数には変更できません。",
                409
              );
            }
            const connections = await transaction.mailConnection.findMany({
              where: { teamId: input.teamId, status: { not: "REVOKED" } },
              select: { id: true }
            });
            const expectedIds = new Set(
              connections.map((connection) => connection.id)
            );
            if (
              expectedIds.size !== input.connectionKeywords.length ||
              input.connectionKeywords.some(
                (connection) => !expectedIds.has(connection.connectionId)
              )
            ) {
              throw new AppError(
                "MAIL_CONNECTIONS_CHANGED",
                "監視アカウントの状態が変更されました。画面を更新してください。",
                409
              );
            }
            for (const connection of input.connectionKeywords) {
              await transaction.mailConnection.update({
                where: { id: connection.connectionId },
                data: { keywords: [...connection.keywords] }
              });
            }
            await transaction.teamKeyword.deleteMany({
              where: { teamId: input.teamId }
            });
            if (input.keywords.length > 0) {
              await transaction.teamKeyword.createMany({
                data: input.keywords.map((keyword, sortOrder) => ({
                  teamId: input.teamId,
                  keyword,
                  normalized: keyword.normalize("NFKC").toLowerCase(),
                  sortOrder
                }))
              });
            }
            const updatedSubscription = await transaction.subscription.update({
              where: { id: subscription.id },
              data: {
                seatLimit: input.seatLimit,
                currentTermAmountYen: input.currentTermAmountYen,
                renewalAmountYen: input.currentTermAmountYen
              }
            });
            await transaction.auditEvent.create({
              data: {
                teamId: input.teamId,
                actorUserId: input.actorUserId,
                action: "CONTRACT_SETTINGS_UPDATED",
                targetType: "Subscription",
                targetId: subscription.id,
                requestId: input.requestId,
                metadata: {
                  previousSeatLimit: subscription.seatLimit,
                  seatLimit: input.seatLimit,
                  previousAnnualAmountYen: subscription.currentTermAmountYen,
                  annualAmountYen: input.currentTermAmountYen,
                  keywordCount: input.keywords.length,
                  mailConnectionCount: input.connectionKeywords.length
                }
              }
            });
            const team = await transaction.team.findUniqueOrThrow({
              where: { id: input.teamId },
              include: {
                keywords: {
                  orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
                }
              }
            });
            return mapTeamContext({
              team,
              membership,
              subscription: updatedSubscription,
              activeMemberCount: occupied
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "CONTRACT_SETTINGS_CONFLICT",
          "契約内容の更新が競合しました。最新の状態を確認してください。",
          409
        )
    );
  }

  public createContractChangeQuote(input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly ContractConnectionSettings[];
    readonly idempotencyKey: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<ContractChangeQuoteRecord> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (transaction) => {
            const membership = await requireOwnerMembership(transaction, {
              teamId: input.teamId,
              actorUserId: input.actorUserId
            });
            void membership;
            const snapshot = await loadContractSnapshot(
              transaction,
              input.teamId
            );
            assertContractConnectionsMatch(
              snapshot.connections,
              input.connectionKeywords
            );
            if (input.seatLimit < snapshot.occupiedAdditionalSeats) {
              throw new AppError(
                "SEAT_LIMIT_BELOW_OCCUPANCY",
                `現在${1 + snapshot.occupiedAdditionalSeats}人が利用中のため、${1 + snapshot.occupiedAdditionalSeats}人未満には変更できません。`,
                409
              );
            }
            if (snapshot.subscription.pendingSeatLimit !== null) {
              throw new AppError(
                "SUBSCRIPTION_CHANGE_PENDING",
                "利用人数の変更処理中です。完了後にもう一度お試しください。",
                409
              );
            }
            if (
              contractSettingsAreEqual(snapshot, {
                seatLimit: input.seatLimit,
                keywords: input.keywords,
                connectionKeywords: input.connectionKeywords
              })
            ) {
              throw new AppError(
                "CONTRACT_SETTINGS_UNCHANGED",
                "変更内容がありません。",
                409
              );
            }
            const nextAnnualAmountYen = calculateAnnualPriceYen(
              input.seatLimit,
              input.keywords.length
            );
            const previousAnnualAmountYen =
              snapshot.subscription.currentTermAmountYen;
            const additionalChargeYen = Math.max(
              nextAnnualAmountYen - previousAnnualAmountYen,
              0
            );
            const quote = await transaction.contractChangeQuote.upsert({
              where: { idempotencyKey: input.idempotencyKey },
              update: {},
              create: {
                teamId: input.teamId,
                subscriptionId: snapshot.subscription.id,
                requestedByUserId: input.actorUserId,
                idempotencyKey: input.idempotencyKey,
                baselineFingerprint: snapshot.fingerprint,
                requestedSeatLimit: input.seatLimit,
                requestedKeywords: [...input.keywords],
                requestedConnectionSettings: input.connectionKeywords.map(
                  (connection) => ({
                    connectionId: connection.connectionId,
                    keywords: [...connection.keywords]
                  })
                ),
                previousAnnualAmountYen,
                nextAnnualAmountYen,
                additionalChargeYen,
                mailConnectionCount: input.connectionKeywords.length,
                expiresAt: input.expiresAt
              }
            });
            if (
              quote.teamId !== input.teamId ||
              quote.requestedByUserId !== input.actorUserId ||
              quote.requestedSeatLimit !== input.seatLimit ||
              !sameKeywordSet(quote.requestedKeywords, input.keywords) ||
              !sameConnectionSettings(
                parseContractConnectionSettings(
                  quote.requestedConnectionSettings
                ),
                input.connectionKeywords
              )
            ) {
              throw new AppError(
                "CONTRACT_CHANGE_IDEMPOTENCY_CONFLICT",
                "契約変更の再送内容が一致しません。もう一度お試しください。",
                409
              );
            }
            if (quote.status !== "PENDING" && quote.status !== "APPLIED") {
              throw contractQuoteExpiredError();
            }
            return mapContractChangeQuote(quote);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => contractSettingsConflictError()
    );
  }

  public async applyContractChangeQuote(input: {
    readonly teamId: string;
    readonly quoteId: string;
    readonly actorUserId: string;
    readonly applyIdempotencyKey: string;
    readonly expectedPreviousAnnualAmountYen: number;
    readonly expectedNextAnnualAmountYen: number;
    readonly expectedAdditionalChargeYen: number;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<AppliedContractChangeRecord> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const membership = await requireOwnerMembership(transaction, {
                teamId: input.teamId,
                actorUserId: input.actorUserId
              });
              const quoteIdentity =
                await transaction.contractChangeQuote.findFirst({
                  where: {
                    id: input.quoteId,
                    teamId: input.teamId,
                    requestedByUserId: input.actorUserId
                  },
                  select: { id: true }
                });
              if (!quoteIdentity) {
                throw new AppError(
                  "CONTRACT_CHANGE_QUOTE_NOT_FOUND",
                  "契約変更の内容を確認できませんでした。",
                  404
                );
              }
              await transaction.$queryRaw(
                Prisma.sql`SELECT id FROM contract_change_quotes WHERE id = ${quoteIdentity.id}::uuid FOR UPDATE`
              );
              const quote =
                await transaction.contractChangeQuote.findUniqueOrThrow({
                  where: { id: quoteIdentity.id }
                });
              if (quote.status === "APPLIED") {
                if (quote.applyIdempotencyKey !== input.applyIdempotencyKey) {
                  throw new AppError(
                    "CONTRACT_CHANGE_ALREADY_APPLIED",
                    "この契約変更はすでに適用されています。",
                    409
                  );
                }
                return {
                  quote: mapContractChangeQuote(quote),
                  team: await loadTeamContextAfterContractChange(transaction, {
                    teamId: input.teamId,
                    membership
                  })
                };
              }
              if (quote.status !== "PENDING" || quote.expiresAt <= input.now) {
                if (quote.status === "PENDING") {
                  await transaction.contractChangeQuote.update({
                    where: { id: quote.id },
                    data: { status: "EXPIRED" }
                  });
                }
                throw contractQuoteExpiredError();
              }
              if (
                quote.previousAnnualAmountYen !==
                  input.expectedPreviousAnnualAmountYen ||
                quote.nextAnnualAmountYen !==
                  input.expectedNextAnnualAmountYen ||
                quote.additionalChargeYen !== input.expectedAdditionalChargeYen
              ) {
                throw contractSettingsConflictError();
              }
              const requestedConnections = parseContractConnectionSettings(
                quote.requestedConnectionSettings
              );
              const snapshot = await loadContractSnapshot(
                transaction,
                input.teamId
              );
              if (snapshot.fingerprint !== quote.baselineFingerprint) {
                throw contractSettingsConflictError();
              }
              assertContractConnectionsMatch(
                snapshot.connections,
                requestedConnections
              );
              if (quote.requestedSeatLimit < snapshot.occupiedAdditionalSeats) {
                throw contractSettingsConflictError();
              }
              const recalculatedNextAnnualAmountYen = calculateAnnualPriceYen(
                quote.requestedSeatLimit,
                quote.requestedKeywords.length
              );
              const recalculatedAdditionalChargeYen = Math.max(
                recalculatedNextAnnualAmountYen -
                  snapshot.subscription.currentTermAmountYen,
                0
              );
              if (
                snapshot.subscription.currentTermAmountYen !==
                  quote.previousAnnualAmountYen ||
                recalculatedNextAnnualAmountYen !== quote.nextAnnualAmountYen ||
                recalculatedAdditionalChargeYen !== quote.additionalChargeYen
              ) {
                throw contractSettingsConflictError();
              }
              for (const connection of requestedConnections) {
                await transaction.mailConnection.update({
                  where: { id: connection.connectionId },
                  data: { keywords: [...connection.keywords] }
                });
              }
              await transaction.teamKeyword.deleteMany({
                where: { teamId: input.teamId }
              });
              if (quote.requestedKeywords.length > 0) {
                await transaction.teamKeyword.createMany({
                  data: quote.requestedKeywords.map((keyword, sortOrder) => ({
                    teamId: input.teamId,
                    keyword,
                    normalized: keyword.normalize("NFKC").toLowerCase(),
                    sortOrder
                  }))
                });
              }
              const updatedSubscription = await transaction.subscription.update(
                {
                  where: { id: snapshot.subscription.id },
                  data: {
                    seatLimit: quote.requestedSeatLimit,
                    currentTermAmountYen:
                      quote.additionalChargeYen > 0
                        ? quote.nextAnnualAmountYen
                        : snapshot.subscription.currentTermAmountYen,
                    renewalAmountYen: quote.nextAnnualAmountYen
                  }
                }
              );
              const appliedQuote = await transaction.contractChangeQuote.update(
                {
                  where: { id: quote.id },
                  data: {
                    status: "APPLIED",
                    appliedAt: input.now,
                    applyIdempotencyKey: input.applyIdempotencyKey
                  }
                }
              );
              await transaction.auditEvent.create({
                data: {
                  teamId: input.teamId,
                  actorUserId: input.actorUserId,
                  action: "CONTRACT_CHANGE_APPLIED",
                  targetType: "ContractChangeQuote",
                  targetId: quote.id,
                  requestId: input.requestId,
                  metadata: {
                    previousSeatLimit: snapshot.subscription.seatLimit,
                    seatLimit: quote.requestedSeatLimit,
                    previousAnnualAmountYen: quote.previousAnnualAmountYen,
                    annualAmountYen: quote.nextAnnualAmountYen,
                    additionalChargeYen: quote.additionalChargeYen,
                    keywordCount: quote.requestedKeywords.length,
                    mailConnectionCount: quote.mailConnectionCount
                  }
                }
              });
              const team = await transaction.team.findUniqueOrThrow({
                where: { id: input.teamId },
                include: {
                  keywords: {
                    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
                  }
                }
              });
              return {
                quote: mapContractChangeQuote(appliedQuote),
                team: mapTeamContext({
                  team,
                  membership,
                  subscription: updatedSubscription,
                  activeMemberCount: snapshot.occupiedAdditionalSeats
                })
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () => contractSettingsConflictError()
      );
    } catch (error) {
      if (isContractChangeApplyKeyUniqueConstraintError(error)) {
        throw new AppError(
          "CONTRACT_CHANGE_IDEMPOTENCY_CONFLICT",
          "この確定操作は別の契約変更に使用されています。内容を再確認してください。",
          409
        );
      }
      throw error;
    }
  }

  public async requestSeatLimitChange(input: {
    readonly teamId: string;
    readonly requestedByUserId: string;
    readonly requestedSeatLimit: number;
    readonly now: Date;
    readonly replacementInvitation: InvitationDraft | null;
  }): Promise<SeatLimitChangeResult> {
    return this.database.$transaction(
      async (transaction) => {
        const owner = await transaction.teamMembership.findFirst({
          where: {
            teamId: input.teamId,
            userId: input.requestedByUserId,
            role: "OWNER",
            status: "ACTIVE"
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

        const existingSubscription = await transaction.subscription.findUnique({
          where: { teamId: input.teamId }
        });
        if (!existingSubscription) {
          throw new AppError(
            "SUBSCRIPTION_NOT_FOUND",
            "契約が見つかりません。",
            404
          );
        }

        await transaction.$queryRaw(
          Prisma.sql`SELECT id FROM subscriptions WHERE id = ${existingSubscription.id}::uuid FOR UPDATE`
        );
        const subscription = await transaction.subscription.findUniqueOrThrow({
          where: { id: existingSubscription.id }
        });
        const activeMemberCount = await countOccupiedAdditionalSeats(
          transaction,
          input.teamId
        );

        if (
          input.requestedSeatLimit === subscription.seatLimit &&
          subscription.pendingSeatLimit === null
        ) {
          throw new AppError(
            "SEAT_LIMIT_UNCHANGED",
            "追加メンバー契約数は変更されていません。",
            409
          );
        }

        await transaction.subscriptionChange.updateMany({
          where: {
            subscriptionId: subscription.id,
            status: { in: ["AWAITING_PAYMENT", "PENDING_CAPACITY"] }
          },
          data: { status: "CANCELED", canceledAt: input.now }
        });

        let status: SeatLimitChangeResult["status"];
        let appliedSeatLimit = subscription.seatLimit;
        let invitation: IssuedInvitationRecord | null = null;

        if (input.requestedSeatLimit > subscription.seatLimit) {
          status = "AWAITING_PAYMENT";
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { pendingSeatLimit: null }
          });
        } else if (input.requestedSeatLimit >= activeMemberCount) {
          status = "APPLIED";
          appliedSeatLimit = input.requestedSeatLimit;
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: {
              seatLimit: input.requestedSeatLimit,
              pendingSeatLimit: null
            }
          });
          await replaceActiveInvitations(transaction, input.teamId, input.now);
          const availableSeats = Math.max(
            input.requestedSeatLimit - activeMemberCount,
            0
          );
          if (availableSeats > 0 && !input.replacementInvitation) {
            throw new Error("replacement_invitation_required");
          }
          if (availableSeats > 0 && input.replacementInvitation) {
            invitation = await createInvitation(transaction, {
              teamId: input.teamId,
              actorUserId: input.requestedByUserId,
              maxUses: availableSeats,
              draft: input.replacementInvitation,
              now: input.now,
              auditAction: "INVITATION_ISSUED_AFTER_SEAT_CHANGE"
            });
          }
        } else {
          status = "PENDING_CAPACITY";
          await transaction.subscription.update({
            where: { id: subscription.id },
            data: { pendingSeatLimit: input.requestedSeatLimit }
          });
          await revokeActiveInvitations(
            transaction,
            input.teamId,
            input.now,
            "PENDING_SEAT_REDUCTION"
          );
        }

        const change = await transaction.subscriptionChange.create({
          data: {
            subscriptionId: subscription.id,
            requestedByUserId: input.requestedByUserId,
            previousSeatLimit: subscription.seatLimit,
            requestedSeatLimit: input.requestedSeatLimit,
            status,
            ...(status === "APPLIED" ? { appliedAt: input.now } : {})
          }
        });

        await transaction.auditEvent.create({
          data: {
            teamId: input.teamId,
            actorUserId: input.requestedByUserId,
            action: "SEAT_LIMIT_CHANGE_REQUESTED",
            targetType: "SubscriptionChange",
            targetId: change.id,
            metadata: {
              previousSeatLimit: subscription.seatLimit,
              requestedSeatLimit: input.requestedSeatLimit,
              activeMemberCount,
              status
            }
          }
        });

        const summary = calculateSeatSummary(
          appliedSeatLimit,
          activeMemberCount
        );
        return {
          changeId: change.id,
          status,
          previousSeatLimit: subscription.seatLimit,
          requestedSeatLimit: input.requestedSeatLimit,
          activeMemberCount,
          availableSeats:
            status === "PENDING_CAPACITY" ? 0 : summary.availableSeats,
          invitation
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  public async applyPaidSeatIncrease(input: {
    readonly changeId: string;
    readonly paymentEventId: string;
    readonly now: Date;
    readonly invitation: InvitationDraft;
  }): Promise<SeatLimitChangeResult> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (transaction) => {
              const changeIdentity =
                await transaction.subscriptionChange.findUnique({
                  where: { id: input.changeId },
                  select: { subscriptionId: true }
                });
              if (!changeIdentity) {
                throw seatIncreaseNotPayableError();
              }

              await transaction.$queryRaw(
                Prisma.sql`SELECT id FROM subscriptions WHERE id = ${changeIdentity.subscriptionId}::uuid FOR UPDATE`
              );
              const change =
                await transaction.subscriptionChange.findUniqueOrThrow({
                  where: { id: input.changeId },
                  include: {
                    subscription: true,
                    issuedInvitation: true
                  }
                });
              const subscription = change.subscription;
              const activeMemberCount = await countOccupiedAdditionalSeats(
                transaction,
                subscription.teamId
              );

              if (change.status === "APPLIED") {
                if (
                  change.paymentEventId !== input.paymentEventId ||
                  !change.issuedInvitation
                ) {
                  throw new AppError(
                    "PAYMENT_EVENT_CONFLICT",
                    "この決済イベントは別の増員処理に使用されています。",
                    409
                  );
                }
                const summary = calculateSeatSummary(
                  subscription.seatLimit,
                  activeMemberCount
                );
                return {
                  changeId: change.id,
                  status: "APPLIED" as const,
                  previousSeatLimit: change.previousSeatLimit,
                  requestedSeatLimit: change.requestedSeatLimit,
                  activeMemberCount,
                  availableSeats: summary.availableSeats,
                  invitation: publicIssuedInvitation(change.issuedInvitation)
                };
              }
              if (change.status !== "AWAITING_PAYMENT") {
                throw seatIncreaseNotPayableError();
              }

              const eventOwner =
                await transaction.subscriptionChange.findUnique({
                  where: { paymentEventId: input.paymentEventId },
                  select: { id: true }
                });
              if (eventOwner && eventOwner.id !== change.id) {
                throw new AppError(
                  "PAYMENT_EVENT_CONFLICT",
                  "この決済イベントは別の増員処理に使用されています。",
                  409
                );
              }
              if (change.requestedSeatLimit <= subscription.seatLimit) {
                throw new AppError(
                  "SEAT_INCREASE_STALE",
                  "この増員申請は現在の契約へ適用できません。",
                  409
                );
              }

              const keywordCount = await transaction.teamKeyword.count({
                where: { teamId: subscription.teamId }
              });
              const summary = calculateSeatSummary(
                change.requestedSeatLimit,
                activeMemberCount
              );
              await replaceActiveInvitations(
                transaction,
                subscription.teamId,
                input.now
              );
              const invitation = await createInvitation(transaction, {
                teamId: subscription.teamId,
                actorUserId: change.requestedByUserId,
                maxUses: summary.availableSeats,
                draft: input.invitation,
                now: input.now,
                auditAction: "INVITATION_ISSUED_AFTER_PAID_INCREASE"
              });
              await transaction.subscription.update({
                where: { id: subscription.id },
                data: {
                  seatLimit: change.requestedSeatLimit,
                  pendingSeatLimit: null,
                  currentTermAmountYen: calculateAnnualPriceYen(
                    change.requestedSeatLimit,
                    keywordCount
                  ),
                  renewalAmountYen: calculateAnnualPriceYen(
                    change.requestedSeatLimit,
                    keywordCount
                  )
                }
              });
              await transaction.subscriptionChange.update({
                where: { id: change.id },
                data: {
                  status: "APPLIED",
                  appliedAt: input.now,
                  paymentEventId: input.paymentEventId,
                  issuedInvitationId: invitation.id
                }
              });
              await transaction.auditEvent.create({
                data: {
                  teamId: subscription.teamId,
                  actorUserId: change.requestedByUserId,
                  action: "SEAT_LIMIT_INCREASE_APPLIED",
                  targetType: "SubscriptionChange",
                  targetId: change.id,
                  metadata: {
                    paymentEventId: input.paymentEventId,
                    previousSeatLimit: subscription.seatLimit,
                    requestedSeatLimit: change.requestedSeatLimit,
                    activeMemberCount,
                    invitationId: invitation.id,
                    invitationMaxUses: invitation.maxUses
                  }
                }
              });

              return {
                changeId: change.id,
                status: "APPLIED" as const,
                previousSeatLimit: subscription.seatLimit,
                requestedSeatLimit: change.requestedSeatLimit,
                activeMemberCount,
                availableSeats: summary.availableSeats,
                invitation
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () =>
          new AppError(
            "SEAT_INCREASE_TRANSACTION_CONFLICT",
            "増員処理が競合しました。決済イベントを再送してください。",
            409
          )
      );
    } catch (error) {
      if (isPaymentEventUniqueConstraintError(error)) {
        throw new AppError(
          "PAYMENT_EVENT_CONFLICT",
          "この決済イベントは別の増員処理に使用されています。",
          409
        );
      }
      throw error;
    }
  }
}

async function activatePurchasedMonitoringChoices(
  transaction: Prisma.TransactionClient,
  input: {
    readonly onboardingId: string;
    readonly teamId: string;
    readonly ownerUserId: string;
    readonly choices: readonly {
      readonly id: string;
      readonly provider: "GOOGLE" | "MICROSOFT";
      readonly status: string;
      readonly mailAuthorizationId: string | null;
      readonly keywords: readonly string[];
      readonly mailAuthorization: {
        readonly status: string;
        readonly encryptedRefreshToken: string | null;
      } | null;
    }[];
    readonly now: Date;
  }
): Promise<void> {
  for (const choice of input.choices) {
    if (choice.status !== "AUTHORIZED") continue;
    if (
      !choice.mailAuthorizationId ||
      choice.mailAuthorization?.status !== "ACTIVE" ||
      !choice.mailAuthorization.encryptedRefreshToken
    ) {
      throw new AppError(
        "MAIL_REAUTHORIZATION_REQUIRED",
        "監視アカウントをもう一度設定してください。",
        409
      );
    }
    const connection = await transaction.mailConnection.upsert({
      where: {
        teamId_mailAuthorizationId: {
          teamId: input.teamId,
          mailAuthorizationId: choice.mailAuthorizationId
        }
      },
      create: {
        teamId: input.teamId,
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
        teamId: input.teamId,
        actorUserId: input.ownerUserId,
        action: "ONBOARDING_MAIL_MONITORING_ACTIVATED",
        targetType: "MailConnection",
        targetId: connection.id,
        metadata: { provider: choice.provider }
      }
    });
  }

  await transaction.ownerOnboarding.update({
    where: { id: input.onboardingId },
    data: { status: "COMPLETED", completedAt: input.now }
  });
}

interface ContractSnapshot {
  readonly subscription: {
    readonly id: string;
    readonly seatLimit: number;
    readonly pendingSeatLimit: number | null;
    readonly currentTermAmountYen: number;
    readonly renewalAmountYen: number;
    readonly updatedAt: Date;
  };
  readonly occupiedAdditionalSeats: number;
  readonly keywords: readonly string[];
  readonly connections: readonly {
    readonly id: string;
    readonly status: string;
    readonly keywords: readonly string[];
  }[];
  readonly fingerprint: string;
}

async function requireOwnerMembership(
  transaction: Prisma.TransactionClient,
  input: { readonly teamId: string; readonly actorUserId: string }
) {
  const membership = await transaction.teamMembership.findFirst({
    where: {
      teamId: input.teamId,
      userId: input.actorUserId,
      role: "OWNER",
      status: "ACTIVE",
      team: { status: "ACTIVE" }
    }
  });
  if (!membership) {
    throw new AppError(
      "OWNER_REQUIRED",
      "この操作はチームの代表者だけが実行できます。",
      403
    );
  }
  return membership;
}

async function loadContractSnapshot(
  transaction: Prisma.TransactionClient,
  teamId: string
): Promise<ContractSnapshot> {
  const subscriptionIdentity = await transaction.subscription.findUnique({
    where: { teamId },
    select: { id: true }
  });
  if (!subscriptionIdentity) {
    throw new AppError("SUBSCRIPTION_NOT_FOUND", "契約が見つかりません。", 404);
  }
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM subscriptions WHERE id = ${subscriptionIdentity.id}::uuid FOR UPDATE`
  );
  const [subscription, occupiedAdditionalSeats, keywords, connections] =
    await Promise.all([
      transaction.subscription.findUniqueOrThrow({
        where: { id: subscriptionIdentity.id },
        select: {
          id: true,
          seatLimit: true,
          pendingSeatLimit: true,
          currentTermAmountYen: true,
          renewalAmountYen: true,
          updatedAt: true
        }
      }),
      countOccupiedAdditionalSeats(transaction, teamId),
      transaction.teamKeyword.findMany({
        where: { teamId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { keyword: true }
      }),
      transaction.mailConnection.findMany({
        where: { teamId, status: { not: "REVOKED" } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, keywords: true }
      })
    ]);
  const snapshotValues = {
    subscriptionId: subscription.id,
    seatLimit: subscription.seatLimit,
    pendingSeatLimit: subscription.pendingSeatLimit,
    currentTermAmountYen: subscription.currentTermAmountYen,
    renewalAmountYen: subscription.renewalAmountYen,
    updatedAt: subscription.updatedAt.toISOString(),
    occupiedAdditionalSeats,
    keywords: canonicalKeywords(keywords.map(({ keyword }) => keyword)),
    connections: connections.map((connection) => ({
      id: connection.id,
      status: connection.status,
      keywords: canonicalKeywords(connection.keywords)
    }))
  };
  return {
    subscription,
    occupiedAdditionalSeats,
    keywords: keywords.map(({ keyword }) => keyword),
    connections,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(snapshotValues))
      .digest("hex")
  };
}

function contractSettingsAreEqual(
  snapshot: ContractSnapshot,
  requested: {
    readonly seatLimit: number;
    readonly keywords: readonly string[];
    readonly connectionKeywords: readonly ContractConnectionSettings[];
  }
): boolean {
  return (
    snapshot.subscription.seatLimit === requested.seatLimit &&
    sameKeywordSet(snapshot.keywords, requested.keywords) &&
    sameConnectionSettings(
      snapshot.connections.map((connection) => ({
        connectionId: connection.id,
        keywords: connection.keywords
      })),
      requested.connectionKeywords
    )
  );
}

function assertContractConnectionsMatch(
  existing: readonly { readonly id: string }[],
  requested: readonly ContractConnectionSettings[]
): void {
  const expectedIds = new Set(existing.map(({ id }) => id));
  if (
    expectedIds.size !== requested.length ||
    requested.some(({ connectionId }) => !expectedIds.has(connectionId))
  ) {
    throw contractSettingsConflictError();
  }
}

function parseContractConnectionSettings(
  value: Prisma.JsonValue
): readonly ContractConnectionSettings[] {
  if (!Array.isArray(value)) throw contractSettingsConflictError();
  const parsed = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.connectionId !== "string" ||
      !Array.isArray(entry.keywords) ||
      !entry.keywords.every((keyword) => typeof keyword === "string")
    ) {
      throw contractSettingsConflictError();
    }
    return {
      connectionId: entry.connectionId,
      keywords: entry.keywords
    };
  });
  return parsed;
}

function sameConnectionSettings(
  left: readonly ContractConnectionSettings[],
  right: readonly ContractConnectionSettings[]
): boolean {
  const canonicalize = (connections: readonly ContractConnectionSettings[]) =>
    [...connections]
      .map((connection) => ({
        connectionId: connection.connectionId,
        keywords: canonicalKeywords(connection.keywords)
      }))
      .sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

function canonicalKeywords(values: readonly string[]): readonly string[] {
  return [...values]
    .map((value) => value.normalize("NFKC").toLocaleLowerCase("ja-JP"))
    .sort();
}

function mapContractChangeQuote(input: {
  readonly id: string;
  readonly status: "PENDING" | "APPLIED" | "EXPIRED" | "CANCELED";
  readonly previousAnnualAmountYen: number;
  readonly nextAnnualAmountYen: number;
  readonly additionalChargeYen: number;
  readonly requestedSeatLimit: number;
  readonly requestedKeywords: readonly string[];
  readonly mailConnectionCount: number;
  readonly expiresAt: Date;
}): ContractChangeQuoteRecord {
  if (input.status !== "PENDING" && input.status !== "APPLIED") {
    throw contractQuoteExpiredError();
  }
  return {
    id: input.id,
    status: input.status,
    previousAnnualAmountYen: input.previousAnnualAmountYen,
    nextAnnualAmountYen: input.nextAnnualAmountYen,
    additionalChargeYen: input.additionalChargeYen,
    seatCount: input.requestedSeatLimit + 1,
    keywordCount: input.requestedKeywords.length,
    mailConnectionCount: input.mailConnectionCount,
    expiresAt: input.expiresAt
  };
}

async function loadTeamContextAfterContractChange(
  transaction: Prisma.TransactionClient,
  input: {
    readonly teamId: string;
    readonly membership: {
      readonly id: string;
      readonly role: "OWNER" | "MEMBER";
    };
  }
): Promise<TeamContextRecord> {
  const [team, subscription, occupiedAdditionalSeats] = await Promise.all([
    transaction.team.findUniqueOrThrow({
      where: { id: input.teamId },
      include: {
        keywords: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }
      }
    }),
    transaction.subscription.findUniqueOrThrow({
      where: { teamId: input.teamId }
    }),
    countOccupiedAdditionalSeats(transaction, input.teamId)
  ]);
  return mapTeamContext({
    team,
    membership: input.membership,
    subscription,
    activeMemberCount: occupiedAdditionalSeats
  });
}

function contractSettingsConflictError(): AppError {
  return new AppError(
    "CONTRACT_SETTINGS_CONFLICT",
    "契約情報が更新されました。内容と料金をもう一度確認してください。",
    409
  );
}

function contractQuoteExpiredError(): AppError {
  return new AppError(
    "CONTRACT_CHANGE_QUOTE_EXPIRED",
    "契約変更の有効期限が切れました。戻ってもう一度確認してください。",
    409
  );
}

function sameKeywordSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLocaleLowerCase("ja-JP");
  const leftValues = [...left].map(normalize).sort();
  const rightValues = [...right].map(normalize).sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

type TeamDatabase = DatabaseClient | Prisma.TransactionClient;

async function findCurrentTeam(
  database: TeamDatabase,
  userId: string
): Promise<TeamContextRecord | null> {
  const membership = await database.teamMembership.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      team: { status: "ACTIVE" }
    },
    include: {
      team: {
        include: {
          subscription: true,
          keywords: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
          }
        }
      }
    },
    orderBy: { joinedAt: "asc" }
  });
  if (!membership?.team.subscription) {
    return null;
  }

  const activeMemberCount = await countOccupiedAdditionalSeats(
    database,
    membership.teamId
  );

  return mapTeamContext({
    team: membership.team,
    membership,
    subscription: membership.team.subscription,
    activeMemberCount
  });
}

async function createTeamInTransaction(
  transaction: Prisma.TransactionClient,
  input: CreateTeamInput
): Promise<TeamCreationResult> {
  const team = await transaction.team.create({
    data: {
      publicCode: input.publicCode,
      name: input.name,
      memberships: {
        create: {
          userId: input.ownerUserId,
          role: "OWNER",
          status: "ACTIVE"
        }
      },
      subscription: {
        create: {
          seatLimit: input.seatLimit,
          currentTermAmountYen: input.currentTermAmountYen,
          renewalAmountYen: input.currentTermAmountYen,
          currentTermStartedAt: input.currentTermStartedAt,
          currentTermEndsAt: input.currentTermEndsAt
        }
      },
      keywords: {
        create: input.keywords.map((keyword, sortOrder) => ({
          keyword,
          normalized: keyword.normalize("NFKC").toLowerCase(),
          sortOrder
        }))
      }
    },
    include: {
      memberships: {
        where: { userId: input.ownerUserId, status: "ACTIVE" }
      },
      subscription: true,
      keywords: { orderBy: { sortOrder: "asc" } }
    }
  });

  await transaction.auditEvent.create({
    data: {
      teamId: team.id,
      actorUserId: input.ownerUserId,
      action: "TEAM_CREATED",
      targetType: "Team",
      targetId: team.id,
      metadata: {
        seatLimit: input.seatLimit,
        keywordCount: input.keywords.length
      }
    }
  });

  const membership = team.memberships[0];
  if (!membership || !team.subscription) {
    throw new Error("team_creation_invariant_failed");
  }

  const invitation =
    input.initialInvitation && input.seatLimit > 0
      ? await createInvitation(transaction, {
          teamId: team.id,
          actorUserId: input.ownerUserId,
          maxUses: input.seatLimit,
          draft: input.initialInvitation,
          now: input.currentTermStartedAt,
          auditAction: "INITIAL_INVITATION_ISSUED"
        })
      : null;

  return {
    team: mapTeamContext({
      team,
      membership,
      subscription: team.subscription,
      activeMemberCount: 0
    }),
    invitation
  };
}

function mapTeamContext(input: {
  readonly team: {
    readonly id: string;
    readonly publicCode: string;
    readonly name: string | null;
    readonly keywords: readonly { readonly keyword: string }[];
  };
  readonly membership: {
    readonly id: string;
    readonly role: "OWNER" | "MEMBER";
  };
  readonly subscription: {
    readonly status: "ACTIVE" | "PAST_DUE" | "CANCELED";
    readonly seatLimit: number;
    readonly pendingSeatLimit: number | null;
    readonly currentTermAmountYen: number;
    readonly renewalAmountYen: number;
    readonly currentTermStartedAt: Date;
    readonly currentTermEndsAt: Date;
  };
  readonly activeMemberCount: number;
}): TeamContextRecord {
  return {
    teamId: input.team.id,
    teamCode: input.team.publicCode,
    teamName: input.team.name,
    membershipId: input.membership.id,
    role: input.membership.role,
    keywords: input.team.keywords.map(({ keyword }) => keyword),
    seatSummary: calculateSeatSummary(
      input.subscription.seatLimit,
      input.activeMemberCount
    ),
    pendingSeatLimit: input.subscription.pendingSeatLimit,
    subscriptionStatus: input.subscription.status,
    currentTermAmountYen: input.subscription.currentTermAmountYen,
    renewalAmountYen: input.subscription.renewalAmountYen,
    currentTermStartedAt: input.subscription.currentTermStartedAt,
    currentTermEndsAt: input.subscription.currentTermEndsAt
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "P2002"
  ) {
    return false;
  }

  return JSON.stringify(
    (error as { readonly meta?: unknown }).meta ?? {}
  ).includes("publicCode");
}

function onboardingNotAvailableError(): AppError {
  return new AppError(
    "OWNER_ONBOARDING_NOT_AVAILABLE",
    "購入前の設定を確認できませんでした。初期設定をもう一度お試しください。",
    409
  );
}

function isPaymentEventUniqueConstraintError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "P2002"
  ) {
    return false;
  }
  return JSON.stringify(
    (error as { readonly meta?: unknown }).meta ?? {}
  ).includes("paymentEventId");
}

function isContractChangeApplyKeyUniqueConstraintError(
  error: unknown
): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    (error as { readonly code?: unknown }).code !== "P2002"
  ) {
    return false;
  }
  return JSON.stringify(
    (error as { readonly meta?: unknown }).meta ?? {}
  ).includes("applyIdempotencyKey");
}

function seatIncreaseNotPayableError(): AppError {
  return new AppError(
    "SEAT_INCREASE_NOT_PAYABLE",
    "適用できる増員申請が見つかりません。",
    409
  );
}

async function createInvitation(
  transaction: Prisma.TransactionClient,
  input: {
    readonly teamId: string;
    readonly actorUserId: string;
    readonly maxUses: number;
    readonly draft: InvitationDraft;
    readonly now: Date;
    readonly auditAction: string;
  }
): Promise<IssuedInvitationRecord> {
  if (input.maxUses < 1) {
    throw new Error("invitation_requires_available_seat");
  }
  const invitation = await transaction.invitation.create({
    data: {
      teamId: input.teamId,
      createdByUserId: input.actorUserId,
      passwordHash: input.draft.passwordHash,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt: input.draft.expiresAt
    }
  });
  await transaction.auditEvent.create({
    data: {
      teamId: input.teamId,
      actorUserId: input.actorUserId,
      action: input.auditAction,
      targetType: "Invitation",
      targetId: invitation.id,
      metadata: { maxUses: input.maxUses }
    }
  });
  return publicIssuedInvitation(invitation);
}

function publicIssuedInvitation(invitation: {
  readonly id: string;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}): IssuedInvitationRecord {
  return {
    id: invitation.id,
    maxUses: invitation.maxUses,
    usedCount: invitation.usedCount,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt
  };
}

async function replaceActiveInvitations(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date
): Promise<void> {
  const invitations = await transaction.invitation.findMany({
    where: { teamId, status: "ACTIVE" },
    select: { id: true }
  });
  const invitationIds = invitations.map(({ id }) => id);
  if (invitationIds.length === 0) {
    return;
  }
  await transaction.invitationLink.updateMany({
    where: { invitationId: { in: invitationIds }, status: "ACTIVE" },
    data: { status: "REPLACED", invalidatedAt: now }
  });
  await transaction.invitation.updateMany({
    where: { id: { in: invitationIds }, status: "ACTIVE" },
    data: {
      status: "REPLACED",
      invalidatedAt: now,
      invalidationNote: "SEAT_LIMIT_CHANGED"
    }
  });
}

async function revokeActiveInvitations(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date,
  note: string
): Promise<void> {
  const invitations = await transaction.invitation.findMany({
    where: { teamId, status: "ACTIVE" },
    select: { id: true }
  });
  const invitationIds = invitations.map(({ id }) => id);
  if (invitationIds.length === 0) {
    return;
  }
  await transaction.invitationLink.updateMany({
    where: { invitationId: { in: invitationIds }, status: "ACTIVE" },
    data: { status: "REVOKED", invalidatedAt: now }
  });
  await transaction.invitation.updateMany({
    where: { id: { in: invitationIds }, status: "ACTIVE" },
    data: {
      status: "REVOKED",
      invalidatedAt: now,
      invalidationNote: note
    }
  });
}
