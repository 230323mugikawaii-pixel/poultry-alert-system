import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type {
  MailOAuthGrant,
  MailProviderAdapter,
  MailProviderErrorKind,
  RefreshedMailAccess
} from "../mail-provider.js";

export const MICROSOFT_MAIL_READ_SCOPE =
  "https://graph.microsoft.com/Mail.Read";
const MICROSOFT_MAIL_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  MICROSOFT_MAIL_READ_SCOPE
] as const;
const MICROSOFT_PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface MicrosoftIdentity {
  readonly subject: string;
  readonly email: string;
}

export interface MicrosoftIdTokenVerifier {
  verify(idToken: string, expectedNonce: string): Promise<MicrosoftIdentity>;
}

interface MicrosoftTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly scope?: unknown;
  readonly expires_in?: unknown;
  readonly error?: unknown;
}

export class MicrosoftMailProvider implements MailProviderAdapter {
  public readonly provider = "MICROSOFT" as const;
  private readonly authority: string;
  private readonly tokenEndpoint: string;
  private readonly idTokenVerifier: MicrosoftIdTokenVerifier;
  private readonly fetcher: typeof fetch;

  public constructor(
    private readonly options: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly tenant: string;
      readonly fetcher?: typeof fetch;
      readonly idTokenVerifier?: MicrosoftIdTokenVerifier;
    }
  ) {
    this.authority = `https://login.microsoftonline.com/${encodeURIComponent(options.tenant)}/oauth2/v2.0`;
    this.tokenEndpoint = `${this.authority}/token`;
    this.fetcher = options.fetcher ?? fetch;
    this.idTokenVerifier =
      options.idTokenVerifier ??
      new MicrosoftOidcIdTokenVerifier(options.clientId, options.tenant);
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    const url = new URL(`${this.authority}/authorize`);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", MICROSOFT_MAIL_SCOPES.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
  }): Promise<MailOAuthGrant> {
    const tokens = await this.requestTokens({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.options.redirectUri,
      code_verifier: input.codeVerifier,
      scope: MICROSOFT_MAIL_SCOPES.join(" ")
    });
    if (
      typeof tokens.access_token !== "string" ||
      typeof tokens.refresh_token !== "string" ||
      typeof tokens.id_token !== "string"
    ) {
      throw new MicrosoftProviderRequestError(
        "microsoft_mail_oauth_tokens_missing",
        401
      );
    }
    const grantedScopes = normalizeScopes(tokens.scope);
    if (!hasMailRead(grantedScopes)) {
      throw new MicrosoftProviderRequestError(
        "microsoft_mail_scope_missing",
        403
      );
    }
    const identity = await this.idTokenVerifier.verify(
      tokens.id_token,
      input.expectedNonce
    );
    return {
      provider: this.provider,
      subject: identity.subject,
      email: identity.email,
      emailVerified: true,
      refreshToken: tokens.refresh_token,
      grantedScopes
    };
  }

  public async refreshAccessToken(
    refreshToken: string
  ): Promise<RefreshedMailAccess> {
    const tokens = await this.requestTokens({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: MICROSOFT_MAIL_SCOPES.join(" ")
    });
    if (typeof tokens.access_token !== "string") {
      throw new MicrosoftProviderRequestError(
        "microsoft_mail_access_token_missing",
        401
      );
    }
    const expiresIn =
      typeof tokens.expires_in === "number" && tokens.expires_in > 0
        ? tokens.expires_in
        : null;
    return {
      accessToken: tokens.access_token,
      expiresAt: expiresIn
        ? new Date(Date.now() + Math.min(expiresIn, 86_400) * 1_000)
        : null,
      rotatedRefreshToken:
        typeof tokens.refresh_token === "string" ? tokens.refresh_token : null
    };
  }

  public async revokeAuthorization(refreshToken: string): Promise<void> {
    void refreshToken;
    // Microsoft identity platform does not expose a narrowly scoped refresh
    // token revocation endpoint for this delegated web-app grant. Call Now
    // disables and clears its credential first; the user can additionally
    // revoke the app grant from their Microsoft account or organization.
  }

  public classifyProviderError(error: unknown): MailProviderErrorKind {
    const code = readProviderErrorCode(error).toLowerCase();
    const status = readProviderErrorStatus(error);
    if (
      code.includes("invalid_grant") ||
      code.includes("interaction_required") ||
      status === 401
    ) {
      return "REAUTHORIZATION_REQUIRED";
    }
    if (code.includes("consent_required")) {
      return "CONSENT_REQUIRED";
    }
    if (code.includes("invalid_scope") || status === 403) {
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

  private async requestTokens(
    values: Readonly<Record<string, string>>
  ): Promise<MicrosoftTokenResponse> {
    const response = await this.fetcher(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const tokens = isRecord(payload) ? payload : {};
    if (!response.ok) {
      const code =
        typeof tokens.error === "string"
          ? sanitizeProviderCode(tokens.error)
          : "microsoft_token_request_failed";
      throw new MicrosoftProviderRequestError(code, response.status);
    }
    return tokens;
  }
}

export class MicrosoftOidcIdTokenVerifier implements MicrosoftIdTokenVerifier {
  private readonly keySet: JWTVerifyGetKey;

  public constructor(
    private readonly clientId: string,
    private readonly tenant: string,
    keySet?: JWTVerifyGetKey
  ) {
    this.keySet =
      keySet ??
      createRemoteJWKSet(
        new URL(
          `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/discovery/v2.0/keys`
        )
      );
  }

  public async verify(
    idToken: string,
    expectedNonce: string
  ): Promise<MicrosoftIdentity> {
    const unverified = decodeJwt(idToken);
    const tenantId =
      typeof unverified.tid === "string" ? unverified.tid.toLowerCase() : "";
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error("microsoft_mail_tenant_claim_invalid");
    }
    assertTenantAllowed(this.tenant, tenantId);
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const { payload } = await jwtVerify(idToken, this.keySet, {
      audience: this.clientId,
      issuer,
      algorithms: ["RS256"]
    });
    const email =
      typeof payload.email === "string"
        ? payload.email
        : typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : "";
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.ver !== "2.0" ||
      payload.nonce !== expectedNonce ||
      !email
    ) {
      throw new Error("microsoft_mail_identity_claims_invalid");
    }
    return { subject: `${tenantId}:${payload.sub}`, email };
  }
}

class MicrosoftProviderRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super("Microsoft mail provider request failed");
  }
}

function assertTenantAllowed(configuredTenant: string, tenantId: string): void {
  const normalized = configuredTenant.toLowerCase();
  if (normalized === "common") return;
  if (
    normalized === "organizations" &&
    tenantId !== MICROSOFT_PERSONAL_TENANT_ID
  ) {
    return;
  }
  if (normalized === "consumers" && tenantId === MICROSOFT_PERSONAL_TENANT_ID) {
    return;
  }
  if (normalized === tenantId) return;
  throw new Error("microsoft_mail_tenant_not_allowed");
}

function hasMailRead(scopes: readonly string[]): boolean {
  return scopes.some((scope) => {
    const normalized = scope.toLowerCase();
    return normalized === "mail.read" || normalized.endsWith("/mail.read");
  });
}

function normalizeScopes(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(/\s+/u)
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [];
}

function isRecord(value: unknown): value is MicrosoftTokenResponse {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProviderCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/gu, "_")
    .slice(0, 100);
}

function readProviderErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as Readonly<Record<string, unknown>>).code;
  return typeof code === "string" ? code : "";
}

function readProviderErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as Readonly<Record<string, unknown>>).status;
  return typeof status === "number" ? status : null;
}
