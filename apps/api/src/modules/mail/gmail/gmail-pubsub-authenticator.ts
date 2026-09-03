import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { AppError } from "../../../lib/app-error.js";

const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com"
]);

export interface PubSubIdTokenVerifier {
  verify(idToken: string, audience: string): Promise<TokenPayload>;
}

export interface PubSubPushAuthenticator {
  authenticate(authorizationHeader: string | undefined): Promise<void>;
}

export class GooglePubSubIdTokenVerifier implements PubSubIdTokenVerifier {
  private readonly client = new OAuth2Client();

  public async verify(
    idToken: string,
    audience: string
  ): Promise<TokenPayload> {
    const ticket = await this.client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("pubsub_oidc_payload_missing");
    return payload;
  }
}

export class GooglePubSubPushAuthenticator implements PubSubPushAuthenticator {
  private readonly verifier: PubSubIdTokenVerifier;
  private readonly now: () => Date;

  public constructor(
    private readonly options: {
      readonly audience: string;
      readonly serviceAccountEmail: string;
      readonly verifier?: PubSubIdTokenVerifier;
      readonly now?: () => Date;
    }
  ) {
    this.verifier = options.verifier ?? new GooglePubSubIdTokenVerifier();
    this.now = options.now ?? (() => new Date());
  }

  public async authenticate(
    authorizationHeader: string | undefined
  ): Promise<void> {
    const token = readBearerToken(authorizationHeader);
    let payload: TokenPayload;
    try {
      payload = await this.verifier.verify(token, this.options.audience);
    } catch {
      throw unauthenticatedPushError();
    }
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (
      !payload.iss ||
      !GOOGLE_ISSUERS.has(payload.iss) ||
      !audience.includes(this.options.audience) ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + 300 ||
      payload.email_verified !== true ||
      payload.email?.toLowerCase() !==
        this.options.serviceAccountEmail.toLowerCase()
    ) {
      throw unauthenticatedPushError();
    }
  }
}

function readBearerToken(value: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{20,16384})$/u.exec(value ?? "");
  if (!match) throw unauthenticatedPushError();
  return match[1]!;
}

function unauthenticatedPushError(): AppError {
  return new AppError(
    "GMAIL_PUBSUB_UNAUTHENTICATED",
    "The push request could not be authenticated.",
    401
  );
}
