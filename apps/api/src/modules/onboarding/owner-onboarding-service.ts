import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type { AuthRepository } from "../auth/auth-repository.js";
import type {
  AuthService,
  ClientContext,
  MagicLinkLoginResult
} from "../auth/auth-service.js";
import type {
  MailProviderAdapter,
  MailProviderId
} from "../mail/mail-provider.js";
import { readMailOAuthFailureReason } from "../mail/mail-provider.js";
import type { TokenEncryptionProvider } from "../mail/token-encryption.js";
import type { TeamService } from "../teams/team-service.js";
import {
  mergeTeamKeywordSets,
  normalizeTeamKeywords
} from "../teams/keyword-policy.js";
import type {
  OwnerOnboardingRecord,
  OwnerOnboardingRepository
} from "./owner-onboarding-repository.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export class OwnerOnboardingService {
  private readonly providers: ReadonlyMap<MailProviderId, MailProviderAdapter>;
  private readonly now: () => Date;

  public constructor(
    private readonly options: {
      readonly repository: OwnerOnboardingRepository;
      readonly authRepository: AuthRepository;
      readonly authService: AuthService;
      readonly teamService: TeamService;
      readonly providerAdapters: readonly MailProviderAdapter[];
      readonly tokenEncryption: TokenEncryptionProvider;
      readonly tokenPepper: string;
      readonly stateTtlMinutes: Readonly<Record<MailProviderId, number>>;
      readonly onboardingTtlHours: number;
      readonly now?: () => Date;
    }
  ) {
    this.providers = new Map(
      options.providerAdapters.map((provider) => [provider.provider, provider])
    );
    this.now = options.now ?? (() => new Date());
  }

  public providerAvailability(
    provider: MailProviderId
  ): "AVAILABLE" | "NOT_CONFIGURED" {
    return this.providers.has(provider) ? "AVAILABLE" : "NOT_CONFIGURED";
  }

  public async createAuthorizationRequest(input: {
    readonly provider: MailProviderId;
    readonly authenticatedUserId: string | null;
  }): Promise<{
    readonly state: string;
    readonly authorizationUrl: string;
    readonly expiresAt: Date;
  }> {
    await this.cleanupExpired();
    const provider = this.requireProvider(input.provider);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const now = this.now();
    const expiresAt = addMinutes(
      now,
      this.options.stateTtlMinutes[input.provider]
    );
    await this.options.repository.createOAuthChallenge({
      provider: input.provider,
      userId: input.authenticatedUserId,
      secretHash: this.hashSecret(state),
      codeVerifier,
      nonce,
      expiresAt,
      now
    });
    return {
      state,
      authorizationUrl: provider.createAuthorizationUrl({
        state,
        codeChallenge,
        nonce
      }),
      expiresAt
    };
  }

  public async completeAuthorization(input: {
    readonly provider: MailProviderId;
    readonly state: string;
    readonly code: string;
    readonly authenticatedUserId: string | null;
    readonly clientContext: ClientContext;
  }): Promise<{
    readonly onboarding: OwnerOnboardingRecord | null;
    readonly hasExistingTeam: boolean;
    readonly login: MagicLinkLoginResult | null;
  }> {
    if (!isPlausibleState(input.state) || !isPlausibleCode(input.code)) {
      throw invalidOnboardingAuthorizationError();
    }
    const challenge = await this.options.repository.consumeOAuthChallenge(
      this.hashSecret(input.state),
      input.provider,
      input.authenticatedUserId,
      this.now()
    );
    if (!challenge) throw invalidOnboardingAuthorizationError();

    let grant;
    try {
      grant = await this.requireProvider(input.provider).exchangeCode({
        code: input.code,
        codeVerifier: challenge.codeVerifier,
        expectedNonce: challenge.nonce
      });
    } catch (error) {
      throw invalidOnboardingAuthorizationError(
        readMailOAuthFailureReason(error)
      );
    }
    const email = grant.email.trim().toLowerCase();
    if (
      grant.provider !== input.provider ||
      !grant.subject ||
      grant.subject.length > 255 ||
      !grant.emailVerified ||
      !EMAIL_PATTERN.test(email) ||
      email.length > 320
    ) {
      throw invalidOnboardingAuthorizationError();
    }

    const identity = {
      provider: grant.provider,
      providerSubject: grant.subject,
      email,
      displayName: null,
      emailVerified: true,
      now: this.now()
    } as const;
    const user = challenge.userId
      ? await this.linkToAuthenticatedUser(challenge.userId, identity)
      : await this.options.authRepository.resolvePrimaryIdentityUser(identity);
    const encryptedToken = await this.options.tokenEncryption.encrypt(
      grant.refreshToken
    );
    const persisted = await this.options.repository.savePendingAuthorization({
      userId: user.id,
      provider: grant.provider,
      providerSubject: grant.subject,
      email,
      encryptedToken,
      grantedScopes: [...new Set(grant.grantedScopes)].sort(),
      expiresAt: addHours(this.now(), this.options.onboardingTtlHours),
      now: this.now()
    });
    await Promise.all(
      persisted.obsoleteTokens.map((token) =>
        this.revokeProviderToken(
          token.provider,
          token.token,
          grant.provider,
          grant.refreshToken
        )
      )
    );
    const login = challenge.userId
      ? null
      : await this.options.authService.createSessionForVerifiedUser(
          user,
          input.clientContext
        );
    return { ...persisted, login };
  }

  public async getCurrent(
    userId: string
  ): Promise<OwnerOnboardingRecord | null> {
    await this.cleanupExpired();
    return this.options.repository.getCurrent(userId);
  }

  public skipProvider(
    userId: string,
    provider: MailProviderId
  ): Promise<OwnerOnboardingRecord> {
    return this.options.repository.skipProvider({
      userId,
      provider,
      now: this.now()
    });
  }

  public async completeDemoPurchase(input: {
    readonly userId: string;
    readonly onboardingId: string;
    readonly seatCount: number;
  }) {
    const onboarding = await this.options.repository.getCurrent(input.userId);
    if (!onboarding || onboarding.id !== input.onboardingId) {
      throw onboardingNotReadyError();
    }
    if (["PURCHASED", "COMPLETED"].includes(onboarding.status)) {
      return this.options.teamService.completeOwnerOnboardingPurchase({
        ...input,
        keywords: [...onboarding.keywords]
      });
    }
    if (onboarding.status !== "PENDING") throw onboardingNotReadyError();
    const choices = onboarding.choices.filter(
      (choice) => choice.status === "AUTHORIZED" && choice.authorizationId
    );
    if (
      choices.length === 0 ||
      choices.some((choice) => !choice.keywordsConfirmedAt)
    ) {
      throw onboardingNotReadyError();
    }
    return this.options.teamService.completeOwnerOnboardingPurchase({
      ...input,
      keywords: mergeTeamKeywordSets(choices.map((choice) => choice.keywords))
    });
  }

  public setChoiceKeywords(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly keywords: readonly string[];
  }): Promise<OwnerOnboardingRecord> {
    return this.options.repository.setChoiceKeywords({
      ...input,
      keywords: normalizeTeamKeywords(input.keywords),
      now: this.now()
    });
  }

  public activateChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly requestId: string | null;
  }): Promise<OwnerOnboardingRecord> {
    return this.options.repository.activateChoice({
      ...input,
      now: this.now()
    });
  }

  public deferChoice(
    userId: string,
    choiceId: string
  ): Promise<OwnerOnboardingRecord> {
    return this.options.repository.deferChoice({
      userId,
      choiceId,
      now: this.now()
    });
  }

  public async cleanupExpired(): Promise<void> {
    const tokens = await this.options.repository.expireAbandoned(this.now());
    await Promise.all(
      tokens.map((token) =>
        this.revokeProviderToken(token.provider, token.token)
      )
    );
  }

  private async linkToAuthenticatedUser(
    userId: string,
    identity: Parameters<AuthRepository["linkPrimaryIdentity"]>[1]
  ) {
    await this.options.authRepository.linkPrimaryIdentity(userId, identity);
    const existing =
      await this.options.authRepository.listPrimaryIdentities(userId);
    const linked = existing.some(
      (candidate) => candidate.provider === identity.provider
    );
    if (!linked) throw invalidOnboardingAuthorizationError();
    const sessionUser =
      await this.options.authRepository.resolvePrimaryIdentityUser(identity);
    if (sessionUser.id !== userId) {
      throw new AppError(
        "LOGIN_IDENTITY_ALREADY_IN_USE",
        "このアカウントは別のCall Now利用者に登録されています。",
        409
      );
    }
    return sessionUser;
  }

  private requireProvider(provider: MailProviderId): MailProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new AppError(
        "MAIL_PROVIDER_NOT_CONFIGURED",
        "このメール連携は現在準備中です。",
        503
      );
    }
    return adapter;
  }

  private async revokeProviderToken(
    provider: MailProviderId,
    token: Parameters<TokenEncryptionProvider["decrypt"]>[0],
    activeProvider?: MailProviderId,
    activeRefreshToken?: string
  ): Promise<void> {
    try {
      const plaintext = await this.options.tokenEncryption.decrypt(token);
      if (provider === activeProvider && plaintext === activeRefreshToken) {
        return;
      }
      await this.requireProvider(provider).revokeAuthorization(plaintext);
    } catch {
      // Local state is already unusable. Provider revocation is best-effort.
    }
  }

  private hashSecret(value: string): string {
    return createHmac("sha256", this.options.tokenPepper)
      .update(value, "utf8")
      .digest("hex");
  }
}

function isPlausibleState(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/u.test(value);
}

function isPlausibleCode(value: string): boolean {
  return value.length >= 10 && value.length <= 4096 && !/[\r\n\0]/u.test(value);
}

function invalidOnboardingAuthorizationError(reasonCode?: string): AppError {
  return new AppError(
    "OWNER_ONBOARDING_AUTHORIZATION_INVALID_OR_EXPIRED",
    "メールアカウントの設定が無効または期限切れです。もう一度お試しください。",
    401,
    reasonCode ? { reasonCode } : undefined
  );
}

function onboardingNotReadyError(): AppError {
  return new AppError(
    "OWNER_ONBOARDING_KEYWORDS_INCOMPLETE",
    "設定したすべての監視アカウントで通知キーワードを決定してください。",
    409
  );
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 3_600_000);
}
