import { randomUUID } from "node:crypto";
import type { ProviderToken } from "../../src/modules/mail/mail-connection-repository.js";
import type { MailProviderId } from "../../src/modules/mail/mail-provider.js";
import type { StoredEncryptedToken } from "../../src/modules/mail/token-encryption.js";
import type {
  OwnerOnboardingChallengeRecord,
  OwnerOnboardingRecord,
  OwnerOnboardingRepository
} from "../../src/modules/onboarding/owner-onboarding-repository.js";

interface StoredChallenge extends OwnerOnboardingChallengeRecord {
  secretHash: string;
  expiresAt: Date;
  consumed: boolean;
}

interface StoredAuthorization {
  userId: string;
  provider: MailProviderId;
  subject: string;
  email: string;
  token: StoredEncryptedToken | null;
}

export class MemoryOwnerOnboardingRepository implements OwnerOnboardingRepository {
  public readonly challenges: StoredChallenge[] = [];
  public readonly authorizations: StoredAuthorization[] = [];
  public onboarding: OwnerOnboardingRecord | null = null;

  public async createOAuthChallenge(input: {
    readonly provider: MailProviderId;
    readonly userId: string | null;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void> {
    void input.now;
    this.challenges.push({
      provider: input.provider,
      userId: input.userId,
      secretHash: input.secretHash,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
      consumed: false
    });
  }

  public async consumeOAuthChallenge(
    secretHash: string,
    provider: MailProviderId,
    expectedUserId: string | null,
    now: Date
  ): Promise<OwnerOnboardingChallengeRecord | null> {
    const challenge = this.challenges.find(
      (candidate) =>
        candidate.secretHash === secretHash &&
        candidate.provider === provider &&
        candidate.userId === expectedUserId &&
        !candidate.consumed &&
        candidate.expiresAt > now
    );
    if (!challenge) return null;
    challenge.consumed = true;
    return challenge;
  }

  public async savePendingAuthorization(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly expiresAt: Date;
    readonly now: Date;
  }) {
    void input.grantedScopes;
    void input.now;
    const existing = this.authorizations.find(
      (authorization) =>
        authorization.provider === input.provider &&
        authorization.subject === input.providerSubject
    );
    const obsoleteTokens: ProviderToken[] = existing?.token
      ? [{ provider: existing.provider, token: existing.token }]
      : [];
    if (existing) {
      Object.assign(existing, {
        userId: input.userId,
        email: input.email,
        token: input.encryptedToken
      });
    } else {
      this.authorizations.push({
        userId: input.userId,
        provider: input.provider,
        subject: input.providerSubject,
        email: input.email,
        token: input.encryptedToken
      });
    }
    const previousChoices =
      this.onboarding?.userId === input.userId
        ? this.onboarding.choices.filter(
            (choice) => choice.provider !== input.provider
          )
        : [];
    const authorizationId = randomUUID();
    this.onboarding = {
      id:
        this.onboarding?.userId === input.userId
          ? this.onboarding.id
          : randomUUID(),
      userId: input.userId,
      teamId: null,
      status: "PENDING",
      seatCount: null,
      keywords: [],
      expiresAt: input.expiresAt,
      purchasedAt: null,
      completedAt: null,
      choices: [
        ...previousChoices,
        {
          id: randomUUID(),
          provider: input.provider,
          status: "AUTHORIZED",
          authorizationId,
          email: input.email,
          keywords: [],
          keywordsConfirmedAt: null
        }
      ]
    };
    return {
      onboarding: this.onboarding,
      hasExistingTeam: false,
      obsoleteTokens
    };
  }

  public async getCurrent(
    userId: string
  ): Promise<OwnerOnboardingRecord | null> {
    return this.onboarding?.userId === userId ? this.onboarding : null;
  }

  public async skipProvider(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    void input.now;
    if (!this.onboarding || this.onboarding.userId !== input.userId) {
      throw new Error("onboarding_missing");
    }
    this.onboarding = {
      ...this.onboarding,
      choices: [
        ...this.onboarding.choices.filter(
          (choice) => choice.provider !== input.provider
        ),
        {
          id: randomUUID(),
          provider: input.provider,
          status: "SKIPPED",
          authorizationId: null,
          email: null,
          keywords: [],
          keywordsConfirmedAt: null
        }
      ]
    };
    return this.onboarding;
  }

  public async setChoiceKeywords(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly keywords: readonly string[];
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    if (!this.onboarding || this.onboarding.userId !== input.userId) {
      throw new Error("onboarding_missing");
    }
    this.onboarding = {
      ...this.onboarding,
      choices: this.onboarding.choices.map((choice) =>
        choice.id === input.choiceId && choice.status === "AUTHORIZED"
          ? {
              ...choice,
              keywords: [...input.keywords],
              keywordsConfirmedAt: input.now
            }
          : choice
      )
    };
    return this.onboarding;
  }

  public async activateChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    void input.requestId;
    void input.now;
    return this.updateChoice(input.userId, input.choiceId, "ACTIVATED");
  }

  public async deferChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord> {
    void input.now;
    return this.updateChoice(input.userId, input.choiceId, "DEFERRED");
  }

  public async expireAbandoned(now: Date): Promise<readonly ProviderToken[]> {
    if (
      !this.onboarding ||
      this.onboarding.status !== "PENDING" ||
      this.onboarding.expiresAt > now
    ) {
      return [];
    }
    this.onboarding = {
      ...this.onboarding,
      status: "EXPIRED"
    };
    return this.authorizations.flatMap((authorization) =>
      authorization.token
        ? [{ provider: authorization.provider, token: authorization.token }]
        : []
    );
  }

  private updateChoice(
    userId: string,
    choiceId: string,
    status: "ACTIVATED" | "DEFERRED"
  ): OwnerOnboardingRecord {
    if (!this.onboarding || this.onboarding.userId !== userId) {
      throw new Error("onboarding_missing");
    }
    this.onboarding = {
      ...this.onboarding,
      choices: this.onboarding.choices.map((choice) =>
        choice.id === choiceId ? { ...choice, status } : choice
      )
    };
    return this.onboarding;
  }
}
