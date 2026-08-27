import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import {
  MailOAuthExchangeError,
  type MailOAuthGrant,
  type MailProviderAdapter,
  type MailProviderErrorKind,
  type RefreshedMailAccess
} from "../mail-provider.js";

export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_MAIL_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE] as const;

export class GoogleMailProvider implements MailProviderAdapter {
  public readonly provider = "GOOGLE" as const;
  private readonly client: OAuth2Client;

  public constructor(
    private readonly options: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
    }
  ) {
    this.client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri
    });
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    return this.client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: false,
      scope: [...GOOGLE_MAIL_SCOPES],
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256
    });
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant> {
    let tokens;
    try {
      ({ tokens } = await this.client.getToken({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirect_uri: this.options.redirectUri
      }));
    } catch {
      throw new MailOAuthExchangeError("TOKEN_EXCHANGE_FAILED");
    }
    if (!tokens.id_token) {
      throw new MailOAuthExchangeError("ID_TOKEN_MISSING");
    }
    if (!tokens.refresh_token) {
      throw new MailOAuthExchangeError("REFRESH_TOKEN_MISSING");
    }

    let ticket;
    try {
      ticket = await this.client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.options.clientId
      });
    } catch {
      throw new MailOAuthExchangeError("ID_TOKEN_INVALID");
    }
    const payload = ticket.getPayload();
    const grantedScopes = normalizeScopes(tokens.scope);
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.nonce !== input.expectedNonce
    ) {
      throw new MailOAuthExchangeError("IDENTITY_CLAIMS_INVALID");
    }
    if (!grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
      throw new MailOAuthExchangeError("REQUIRED_SCOPE_MISSING");
    }

    return {
      provider: this.provider,
      subject: payload.sub,
      email: payload.email,
      emailVerified: true,
      refreshToken: tokens.refresh_token,
      grantedScopes
    };
  }

  public async refreshAccessToken(
    refreshToken: string
  ): Promise<RefreshedMailAccess> {
    const client = new OAuth2Client({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri
    });
    client.setCredentials({ refresh_token: refreshToken });
    const result = await client.getAccessToken();
    if (!result.token) {
      throw new Error("google_mail_access_token_missing");
    }
    return {
      accessToken: result.token,
      expiresAt: client.credentials.expiry_date
        ? new Date(client.credentials.expiry_date)
        : null,
      rotatedRefreshToken: null
    };
  }

  public async revokeAuthorization(refreshToken: string): Promise<void> {
    await this.client.revokeToken(refreshToken);
  }

  public classifyProviderError(error: unknown): MailProviderErrorKind {
    const code = readErrorCode(error).toLowerCase();
    const status = readErrorStatus(error);
    if (code.includes("invalid_grant") || status === 401) {
      return "REAUTHORIZATION_REQUIRED";
    }
    if (code.includes("insufficient") || status === 403) {
      return "FORBIDDEN";
    }
    if (status === 429) {
      return "RATE_LIMITED";
    }
    if (status !== null && status >= 500) {
      return "TRANSIENT";
    }
    return "UNKNOWN";
  }
}

function normalizeScopes(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function readErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as Readonly<Record<string, unknown>>;
  return typeof record.code === "string"
    ? record.code
    : typeof record.message === "string"
      ? record.message
      : "";
}

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Readonly<Record<string, unknown>>;
  if (typeof record.status === "number") return record.status;
  const response = record.response;
  if (!response || typeof response !== "object") return null;
  const status = (response as Readonly<Record<string, unknown>>).status;
  return typeof status === "number" ? status : null;
}
