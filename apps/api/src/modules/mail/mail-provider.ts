export type MailProviderId = "GOOGLE" | "MICROSOFT";

export type MailProviderErrorKind =
  | "REAUTHORIZATION_REQUIRED"
  | "CONSENT_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "UNKNOWN";

export type MailOAuthFailureReason =
  | "TOKEN_EXCHANGE_FAILED"
  | "ID_TOKEN_MISSING"
  | "REFRESH_TOKEN_MISSING"
  | "ID_TOKEN_INVALID"
  | "IDENTITY_CLAIMS_INVALID"
  | "REQUIRED_SCOPE_MISSING"
  | "PROVIDER_RESPONSE_INVALID";

export class MailOAuthExchangeError extends Error {
  public constructor(public readonly reasonCode: MailOAuthFailureReason) {
    super("mail_oauth_exchange_failed");
    this.name = "MailOAuthExchangeError";
  }
}

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
  stopMailboxWatch?(refreshToken: string): Promise<void>;
  classifyProviderError(error: unknown): MailProviderErrorKind;
}

export function readMailOAuthFailureReason(
  error: unknown
): MailOAuthFailureReason {
  return error instanceof MailOAuthExchangeError
    ? error.reasonCode
    : "PROVIDER_RESPONSE_INVALID";
}
