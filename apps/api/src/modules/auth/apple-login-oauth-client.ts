import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryIdentityProfile
} from "./primary-auth-provider.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_AUTHORIZATION_ENDPOINT = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN_ENDPOINT = `${APPLE_ISSUER}/auth/token`;

interface AppleTokenResponse {
  readonly id_token?: unknown;
  readonly error?: unknown;
}

export class AppleLoginOAuthClient implements PrimaryAuthProviderAdapter {
  public readonly provider = "APPLE" as const;
  private readonly fetcher: typeof fetch;
  private readonly keySet: JWTVerifyGetKey;

  public constructor(
    private readonly options: {
      readonly clientId: string;
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKey: string;
      readonly redirectUri: string;
      readonly fetcher?: typeof fetch;
      readonly keySet?: JWTVerifyGetKey;
    }
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.keySet =
      options.keySet ??
      createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`));
  }

  public createAuthorizationUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly nonce: string;
  }): string {
    const url = new URL(APPLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("scope", "name email");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    return url.toString();
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectedNonce: string;
    readonly userPayload?: string;
  }): Promise<PrimaryIdentityProfile> {
    const response = await this.fetcher(APPLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: await this.createClientSecret(),
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: this.options.redirectUri
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const tokens = isRecord(payload) ? payload : {};
    if (!response.ok || typeof tokens.id_token !== "string") {
      throw new Error("apple_login_token_exchange_failed");
    }

    const { payload: identity } = await jwtVerify(
      tokens.id_token,
      this.keySet,
      {
        issuer: APPLE_ISSUER,
        audience: this.options.clientId,
        algorithms: ["RS256"]
      }
    );
    if (
      typeof identity.sub !== "string" ||
      !identity.sub ||
      identity.nonce !== input.expectedNonce
    ) {
      throw new Error("apple_login_identity_claims_invalid");
    }
    const email = typeof identity.email === "string" ? identity.email : null;
    const verified =
      identity.email_verified === true || identity.email_verified === "true";
    return {
      provider: "APPLE",
      subject: identity.sub,
      email,
      emailVerified: Boolean(email) && verified,
      displayName: readAppleName(input.userPayload)
    };
  }

  private async createClientSecret(): Promise<string> {
    const key = await importPKCS8(
      readPrivateKey(this.options.privateKey),
      "ES256"
    );
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.options.keyId })
      .setIssuer(this.options.teamId)
      .setSubject(this.options.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
  }
}

function readPrivateKey(value: string): string {
  if (value.includes("BEGIN PRIVATE KEY")) {
    return value.replace(/\\n/gu, "\n");
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function readAppleName(userPayload: string | undefined): string | null {
  if (!userPayload) return null;
  try {
    const parsed: unknown = JSON.parse(userPayload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const name = (parsed as Readonly<Record<string, unknown>>).name;
    if (!name || typeof name !== "object" || Array.isArray(name)) return null;
    const record = name as Readonly<Record<string, unknown>>;
    const parts = [record.firstName, record.lastName]
      .filter((part): part is string => typeof part === "string")
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.join(" ").slice(0, 120) || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is AppleTokenResponse {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
