import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryIdentityProfile
} from "./primary-auth-provider.js";

const MICROSOFT_LOGIN_SCOPES = ["openid", "profile", "email"] as const;
const PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface MicrosoftTokenResponse {
  readonly id_token?: unknown;
  readonly error?: unknown;
}

export class MicrosoftLoginOAuthClient implements PrimaryAuthProviderAdapter {
  public readonly provider = "MICROSOFT" as const;
  private readonly authority: string;
  private readonly verifier: MicrosoftLoginIdTokenVerifier;
  private readonly fetcher: typeof fetch;

  public constructor(
    private readonly options: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
      readonly tenant: string;
      readonly fetcher?: typeof fetch;
      readonly verifier?: MicrosoftLoginIdTokenVerifier;
    }
  ) {
    this.authority = `https://login.microsoftonline.com/${encodeURIComponent(options.tenant)}/oauth2/v2.0`;
    this.fetcher = options.fetcher ?? fetch;
    this.verifier =
      options.verifier ??
      new MicrosoftLoginIdTokenVerifier(options.clientId, options.tenant);
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
    url.searchParams.set("scope", MICROSOFT_LOGIN_SCOPES.join(" "));
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
  }): Promise<PrimaryIdentityProfile> {
    const response = await this.fetcher(`${this.authority}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: this.options.redirectUri,
        code_verifier: input.codeVerifier,
        scope: MICROSOFT_LOGIN_SCOPES.join(" ")
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const tokens = isRecord(payload) ? payload : {};
    if (!response.ok || typeof tokens.id_token !== "string") {
      throw new Error("microsoft_login_token_exchange_failed");
    }
    return this.verifier.verify(tokens.id_token, input.expectedNonce);
  }
}

export class MicrosoftLoginIdTokenVerifier {
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
  ): Promise<PrimaryIdentityProfile> {
    const unverified = decodeJwt(idToken);
    const tenantId =
      typeof unverified.tid === "string" ? unverified.tid.toLowerCase() : "";
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error("microsoft_login_tenant_claim_invalid");
    }
    assertTenantAllowed(this.tenant, tenantId);
    const { payload } = await jwtVerify(idToken, this.keySet, {
      audience: this.clientId,
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      algorithms: ["RS256"]
    });
    const email =
      typeof payload.email === "string"
        ? payload.email
        : typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : null;
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.ver !== "2.0" ||
      payload.nonce !== expectedNonce
    ) {
      throw new Error("microsoft_login_identity_claims_invalid");
    }
    return {
      provider: "MICROSOFT",
      subject: `${tenantId}:${payload.sub}`,
      email,
      emailVerified: Boolean(email),
      displayName: typeof payload.name === "string" ? payload.name : null
    };
  }
}

function assertTenantAllowed(configuredTenant: string, tenantId: string): void {
  const normalized = configuredTenant.toLowerCase();
  if (normalized === "common") return;
  if (normalized === "organizations" && tenantId !== PERSONAL_TENANT_ID) return;
  if (normalized === "consumers" && tenantId === PERSONAL_TENANT_ID) return;
  if (normalized === tenantId) return;
  throw new Error("microsoft_login_tenant_not_allowed");
}

function isRecord(value: unknown): value is MicrosoftTokenResponse {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
