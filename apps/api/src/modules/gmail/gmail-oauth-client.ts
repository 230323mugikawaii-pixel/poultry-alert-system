import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_AUTHORIZATION_SCOPES = [
  "openid",
  "email",
  GMAIL_READONLY_SCOPE
] as const;

export interface GmailOAuthGrant {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly refreshToken: string;
  readonly grantedScopes: readonly string[];
}

export interface GmailOAuthProvider {
  createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<GmailOAuthGrant>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export class GoogleGmailOAuthClient implements GmailOAuthProvider {
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
      scope: [...GMAIL_AUTHORIZATION_SCOPES],
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
  }): Promise<GmailOAuthGrant> {
    const { tokens } = await this.client.getToken({
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirect_uri: this.options.redirectUri
    });
    if (!tokens.id_token || !tokens.refresh_token) {
      throw new Error("gmail_oauth_tokens_missing");
    }

    const ticket = await this.client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.options.clientId
    });
    const payload = ticket.getPayload();
    const grantedScopes = (tokens.scope ?? "")
      .split(/\s+/u)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.nonce !== input.expectedNonce ||
      !grantedScopes.includes(GMAIL_READONLY_SCOPE)
    ) {
      throw new Error("gmail_oauth_claims_or_scope_invalid");
    }

    return {
      subject: payload.sub,
      email: payload.email,
      emailVerified: true,
      refreshToken: tokens.refresh_token,
      grantedScopes
    };
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.client.revokeToken(refreshToken);
  }
}
