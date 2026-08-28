import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  AuthRepository,
  PrimaryIdentityProvider,
  PrimaryIdentityRecord
} from "./auth-repository.js";
import type {
  AuthService,
  ClientContext,
  MagicLinkLoginResult
} from "./auth-service.js";
import type {
  PrimaryAuthProviderAdapter,
  PrimaryProviderAvailability
} from "./primary-auth-provider.js";

export type PrimaryAuthorizationResult =
  | ({ readonly intent: "LOGIN" } & MagicLinkLoginResult)
  | {
      readonly intent: "LINK";
      readonly identity: PrimaryIdentityRecord;
    };

export class PrimaryAuthService {
  private readonly now: () => Date;
  private readonly providers: ReadonlyMap<
    PrimaryIdentityProvider,
    PrimaryAuthProviderAdapter
  >;

  public constructor(
    private readonly options: {
      readonly repository: AuthRepository;
      readonly authService: AuthService;
      readonly providerAdapters: readonly PrimaryAuthProviderAdapter[];
      readonly tokenPepper: string;
      readonly stateTtlMinutes: Readonly<
        Record<PrimaryIdentityProvider, number>
      >;
      readonly now?: () => Date;
    }
  ) {
    this.now = options.now ?? (() => new Date());
    this.providers = new Map(
      options.providerAdapters.map((provider) => [provider.provider, provider])
    );
  }

  public getProviderAvailability(
    provider: PrimaryIdentityProvider
  ): PrimaryProviderAvailability {
    return this.providers.has(provider) ? "AVAILABLE" : "NOT_CONFIGURED";
  }

  public async createAuthorizationRequest(input: {
    readonly provider: PrimaryIdentityProvider;
    readonly intent: "LOGIN" | "LINK";
    readonly authenticatedUserId: string | null;
  }): Promise<{
    readonly state: string;
    readonly authorizationUrl: string;
    readonly expiresAt: Date;
  }> {
    if (input.intent === "LINK" && !input.authenticatedUserId) {
      throw new AppError("UNAUTHENTICATED", "ログインが必要です。", 401);
    }
    const adapter = this.requireProvider(input.provider);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier, "utf8")
      .digest("base64url");
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.options.stateTtlMinutes[input.provider] * 60_000
    );
    await this.options.repository.createPrimaryOAuthChallenge({
      provider: input.provider,
      intent: input.intent,
      userId: input.intent === "LINK" ? input.authenticatedUserId : null,
      secretHash: this.hashSecret(state),
      codeVerifier,
      nonce,
      expiresAt
    });
    return {
      state,
      authorizationUrl: adapter.createAuthorizationUrl({
        state,
        codeChallenge,
        nonce
      }),
      expiresAt
    };
  }

  public async completeAuthorization(input: {
    readonly provider: PrimaryIdentityProvider;
    readonly state: string;
    readonly code: string;
    readonly authenticatedUserId: string | null;
    readonly userPayload?: string;
    readonly clientContext: ClientContext;
  }): Promise<PrimaryAuthorizationResult> {
    if (!isPlausibleState(input.state) || !isPlausibleCode(input.code)) {
      throw invalidPrimaryLoginError();
    }
    const challenge =
      await this.options.repository.consumePrimaryOAuthChallenge(
        this.hashSecret(input.state),
        input.provider,
        input.authenticatedUserId,
        this.now()
      );
    if (!challenge) {
      throw invalidPrimaryLoginError();
    }
    let profile;
    try {
      profile = await this.requireProvider(input.provider).exchangeCode({
        code: input.code,
        codeVerifier: challenge.codeVerifier,
        expectedNonce: challenge.nonce,
        ...(input.userPayload ? { userPayload: input.userPayload } : {})
      });
    } catch {
      throw invalidPrimaryLoginError();
    }
    if (
      profile.provider !== input.provider ||
      !profile.subject ||
      profile.subject.length > 255
    ) {
      throw invalidPrimaryLoginError();
    }
    const identityInput = {
      provider: profile.provider,
      providerSubject: profile.subject,
      email: normalizeOptionalEmail(profile.email),
      displayName: profile.displayName?.trim().slice(0, 120) || null,
      emailVerified: profile.emailVerified,
      now: this.now()
    };
    if (challenge.intent === "LINK") {
      if (!challenge.userId || challenge.userId !== input.authenticatedUserId) {
        throw invalidPrimaryLoginError();
      }
      return {
        intent: "LINK",
        identity: await this.options.repository.linkPrimaryIdentity(
          challenge.userId,
          identityInput
        )
      };
    }
    const user =
      await this.options.repository.resolvePrimaryIdentityUser(identityInput);
    const login = await this.options.authService.createSessionForVerifiedUser(
      user,
      input.clientContext
    );
    return { intent: "LOGIN", ...login };
  }

  public listIdentities(
    userId: string
  ): Promise<readonly PrimaryIdentityRecord[]> {
    return this.options.repository.listPrimaryIdentities(userId);
  }

  public unlinkIdentity(
    userId: string,
    provider: PrimaryIdentityProvider
  ): Promise<void> {
    return this.options.repository.unlinkPrimaryIdentity(
      userId,
      provider,
      this.now()
    );
  }

  private requireProvider(
    provider: PrimaryIdentityProvider
  ): PrimaryAuthProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new AppError(
        "LOGIN_PROVIDER_NOT_CONFIGURED",
        "このログイン方法は現在準備中です。",
        503
      );
    }
    return adapter;
  }

  private hashSecret(value: string): string {
    return createHmac("sha256", this.options.tokenPepper)
      .update(value, "utf8")
      .digest("hex");
  }
}

function normalizeOptionalEmail(value: string | null): string | null {
  return value?.trim().toLowerCase().slice(0, 320) || null;
}

function isPlausibleState(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,100}$/u.test(value);
}

function isPlausibleCode(value: string): boolean {
  return value.length >= 10 && value.length <= 4096 && !/[\r\n\0]/u.test(value);
}

function invalidPrimaryLoginError(): AppError {
  return new AppError(
    "PRIMARY_LOGIN_INVALID_OR_EXPIRED",
    "ログインが無効または期限切れです。もう一度お試しください。",
    401
  );
}
