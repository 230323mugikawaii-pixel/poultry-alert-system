import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type { AuthUserRecord } from "./auth-repository.js";
import type { AuthService, ClientContext } from "./auth-service.js";
import type { PrimaryAuthService } from "./primary-auth-service.js";

export const nativeClientId = "callnow-ios";
export const nativeRedirectUri = "com.callnow.poultryalert:/oauth/callback";
export type NativeProvider = "GOOGLE" | "MICROSOFT";
export interface NativeGrant {
  readonly id: string;
  readonly stateHash: string;
  readonly bindingHash: string;
  readonly provider: string;
  readonly clientState: string;
  readonly codeChallenge: string;
  readonly expiresAt: Date;
}
export interface NativeGrantRepository {
  create(input: Omit<NativeGrant, "id">): Promise<void>;
  owns(stateHash: string): Promise<boolean>;
  claimCallback(
    stateHash: string,
    bindingHash: string,
    provider: NativeProvider,
    now: Date
  ): Promise<NativeGrant | null>;
  issueCode(
    id: string,
    userId: string,
    codeHash: string,
    now: Date
  ): Promise<void>;
  consumeCode(
    codeHash: string,
    codeChallenge: string,
    now: Date
  ): Promise<AuthUserRecord | null>;
}
export const invalidNativeGrant = () =>
  new AppError(
    "NATIVE_GRANT_INVALID",
    "ログインが無効または期限切れです。もう一度お試しください。",
    401
  );
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

export class NativeAuthService {
  public constructor(
    private readonly options: {
      readonly repository: NativeGrantRepository;
      readonly primary: Pick<
        PrimaryAuthService,
        | "createAuthorizationRequest"
        | "completeNativeAuthorization"
        | "getProviderAvailability"
      >;
      readonly auth: Pick<AuthService, "createSessionForVerifiedUser">;
      readonly pepper: string;
      readonly now?: () => Date;
    }
  ) {}
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private hash(value: string): string {
    return createHmac("sha256", this.options.pepper)
      .update(`native-v1:${value}`)
      .digest("hex");
  }
  public availability(provider: NativeProvider) {
    return this.options.primary.getProviderAvailability(provider);
  }
  public owns(state: string): Promise<boolean> {
    return /^[A-Za-z0-9_-]{43}$/u.test(state)
      ? this.options.repository.owns(this.hash(state))
      : Promise.resolve(false);
  }
  public async start(
    provider: NativeProvider,
    clientState: string,
    codeChallenge: string
  ) {
    if (
      !/^[A-Za-z0-9_-]{43,128}$/u.test(clientState) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)
    )
      throw invalidNativeGrant();
    const upstream = await this.options.primary.createAuthorizationRequest({
      provider,
      intent: "LOGIN",
      authenticatedUserId: null
    });
    const binding = randomBytes(32).toString("base64url");
    await this.options.repository.create({
      stateHash: this.hash(upstream.state),
      bindingHash: this.hash(binding),
      provider,
      clientState,
      codeChallenge,
      expiresAt: new Date(
        Math.min(upstream.expiresAt.getTime(), this.now().getTime() + 600_000)
      )
    });
    return { authorizationUrl: upstream.authorizationUrl, binding };
  }
  public async callback(
    provider: NativeProvider,
    state: string,
    binding: string,
    code?: string,
    providerError?: string
  ): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(binding)) throw invalidNativeGrant();
    const grant = await this.options.repository.claimCallback(
      this.hash(state),
      this.hash(binding),
      provider,
      this.now()
    );
    if (!grant) throw invalidNativeGrant();
    const callback = new URL(nativeRedirectUri);
    callback.searchParams.set("state", grant.clientState);
    if (providerError || !code) {
      callback.searchParams.set("error", "access_denied");
      return callback.toString();
    }
    try {
      const user = await this.options.primary.completeNativeAuthorization({
        provider,
        state,
        code
      });
      const handoff = randomBytes(32).toString("base64url");
      await this.options.repository.issueCode(
        grant.id,
        user.id,
        this.hash(handoff),
        this.now()
      );
      callback.searchParams.set("code", handoff);
    } catch {
      // Never log raw adapter/DB errors; never mint a session on a failed callback.
      callback.searchParams.set("error", "login_failed");
    }
    return callback.toString();
  }
  public async exchange(
    code: string,
    verifier: string,
    context: ClientContext
  ) {
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(code) ||
      !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
    )
      throw invalidNativeGrant();
    const user = await this.options.repository.consumeCode(
      this.hash(code),
      pkceChallenge(verifier),
      this.now()
    );
    if (!user) throw invalidNativeGrant();
    // One-shot, fail closed: if session persistence fails, repeat the login.
    // No upstream OAuth token is returned or stored in this grant.
    return this.options.auth.createSessionForVerifiedUser(user, {
      ...context,
      deviceName: "Call Now iOS"
    });
  }
}
