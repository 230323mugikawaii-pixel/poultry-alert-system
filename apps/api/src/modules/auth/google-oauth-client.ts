import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

const GOOGLE_LOGIN_SCOPES = ["openid", "email", "profile"] as const;

export interface GoogleIdentityProfile {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
}

export interface GoogleOAuthProvider {
  createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<GoogleIdentityProfile>;
}

export interface GoogleOAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export class GoogleOAuthClient implements GoogleOAuthProvider {
  private readonly client: OAuth2Client;

  public constructor(private readonly options: GoogleOAuthClientOptions) {
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
      access_type: "online",
      scope: [...GOOGLE_LOGIN_SCOPES],
      prompt: "select_account",
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
  }): Promise<GoogleIdentityProfile> {
    const { tokens } = await this.client.getToken({
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirect_uri: this.options.redirectUri
    });
    if (!tokens.id_token) {
      throw new Error("google_id_token_missing");
    }

    const ticket = await this.client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.options.clientId
    });
    const payload = ticket.getPayload();
    if (
      !payload?.sub ||
      !payload.email ||
      payload.nonce !== input.expectedNonce
    ) {
      throw new Error("google_identity_claims_missing");
    }

    return {
      subject: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      displayName: payload.name?.trim() || null
    };
  }
}
