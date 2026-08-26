export type MailProviderId = "GOOGLE" | "MICROSOFT";

export type MailProviderErrorKind =
  | "REAUTHORIZATION_REQUIRED"
  | "CONSENT_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "UNKNOWN";

export interface MailOAuthGrant {
  readonly provider: MailProviderId;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly refreshToken: string;
  readonly grantedScopes: readonly string[];
}

export interface RefreshedMailAccess {
  readonly accessToken: string;
  readonly expiresAt: Date | null;
  readonly rotatedRefreshToken: string | null;
}

export interface MailProviderAdapter {
  readonly provider: MailProviderId;
  createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant>;
  refreshAccessToken(refreshToken: string): Promise<RefreshedMailAccess>;
  revokeAuthorization(refreshToken: string): Promise<void>;
  classifyProviderError(error: unknown): MailProviderErrorKind;
}
