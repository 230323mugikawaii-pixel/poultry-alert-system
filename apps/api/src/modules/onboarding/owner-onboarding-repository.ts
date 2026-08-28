import type { StoredEncryptedToken } from "../mail/token-encryption.js";
import type { MailProviderId } from "../mail/mail-provider.js";
import type { ProviderToken } from "../mail/mail-connection-repository.js";

export type OwnerOnboardingStatus =
  "PENDING" | "PURCHASED" | "COMPLETED" | "EXPIRED" | "ABANDONED";

export type OnboardingMailChoiceStatus =
  "AUTHORIZED" | "ACTIVATED" | "DEFERRED" | "SKIPPED";

export interface OwnerOnboardingChoiceRecord {
  readonly id: string;
  readonly provider: MailProviderId;
  readonly status: OnboardingMailChoiceStatus;
  readonly authorizationId: string | null;
  readonly email: string | null;
}

export interface OwnerOnboardingRecord {
  readonly id: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly status: OwnerOnboardingStatus;
  readonly seatCount: number | null;
  readonly keywords: readonly string[];
  readonly expiresAt: Date;
  readonly purchasedAt: Date | null;
  readonly completedAt: Date | null;
  readonly choices: readonly OwnerOnboardingChoiceRecord[];
}

export interface OwnerOnboardingChallengeRecord {
  readonly provider: MailProviderId;
  readonly userId: string | null;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface OwnerOnboardingRepository {
  createOAuthChallenge(input: {
    readonly provider: MailProviderId;
    readonly userId: string | null;
    readonly secretHash: string;
    readonly codeVerifier: string;
    readonly nonce: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void>;
  consumeOAuthChallenge(
    secretHash: string,
    provider: MailProviderId,
    expectedUserId: string | null,
    now: Date
  ): Promise<OwnerOnboardingChallengeRecord | null>;
  savePendingAuthorization(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly providerSubject: string;
    readonly email: string;
    readonly encryptedToken: StoredEncryptedToken;
    readonly grantedScopes: readonly string[];
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<{
    readonly onboarding: OwnerOnboardingRecord | null;
    readonly hasExistingTeam: boolean;
    readonly obsoleteTokens: readonly ProviderToken[];
  }>;
  getCurrent(userId: string): Promise<OwnerOnboardingRecord | null>;
  skipProvider(input: {
    readonly userId: string;
    readonly provider: MailProviderId;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord>;
  activateChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly requestId: string | null;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord>;
  deferChoice(input: {
    readonly userId: string;
    readonly choiceId: string;
    readonly now: Date;
  }): Promise<OwnerOnboardingRecord>;
  expireAbandoned(now: Date): Promise<readonly ProviderToken[]>;
}
