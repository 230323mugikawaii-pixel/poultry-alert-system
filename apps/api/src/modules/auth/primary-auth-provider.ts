export type PrimaryIdentityProvider = "GOOGLE" | "MICROSOFT" | "APPLE";

export interface PrimaryIdentityProfile {
  readonly provider: PrimaryIdentityProvider;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
}

export interface PrimaryAuthProviderAdapter {
  readonly provider: PrimaryIdentityProvider;
  createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
    readonly userPayload?: string;
  }): Promise<PrimaryIdentityProfile>;
}

export type PrimaryProviderAvailability = "AVAILABLE" | "NOT_CONFIGURED";
