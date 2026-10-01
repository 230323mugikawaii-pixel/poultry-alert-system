import { createHash, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../../lib/app-error.js";
import type {
  AuthRepository,
  NativeLinkTicket,
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
    readonly nativeLink?: true;
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
      expiresAt,
      ...(input.nativeLink ? { nativeLink: true as const } : {})
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
    const { challenge, identityInput } = await this.verifyAuthorization(
      input,
      false
    );
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

  // Native LINK is deliberately separate from LOGIN. Browser proof alone never
  // links an account; only the initiating app session plus S256 can finalize it.
  public async startNativeLink(input: {
    provider: PrimaryIdentityProvider;
    userId: string;
    sessionId: string;
    codeChallenge: string;
  }): Promise<string> {
    if (
      input.provider === "APPLE" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)
    )
      throw invalidPrimaryLoginError();
    this.requireProvider(input.provider);
    return this.issueNativeLinkTicket({ ...input, stage: "HANDOFF" });
  }

  public async openNativeLink(
    provider: PrimaryIdentityProvider,
    handoff: string
  ) {
    const ticket = await this.consumeNativeLinkTicket(
      provider,
      "HANDOFF",
      handoff
    );
    const authorization = await this.createAuthorizationRequest({
      provider,
      intent: "LINK",
      authenticatedUserId: ticket.userId,
      nativeLink: true
    });
    await this.options.repository.createNativeLinkTicket({
      ...ticket,
      stage: "CALLBACK",
      secretHash: this.nativeLinkHash("CALLBACK", authorization.state),
      expiresAt: authorization.expiresAt
    });
    return authorization;
  }

  public async verifyNativeLinkCallback(
    provider: PrimaryIdentityProvider,
    state: string,
    code: string
  ): Promise<string> {
    const ticket = await this.consumeNativeLinkTicket(
      provider,
      "CALLBACK",
      state
    );
    const { identityInput } = await this.verifyAuthorization(
      {
        provider,
        state,
        code,
        authenticatedUserId: ticket.userId
      },
      true
    );
    const identity = {
      provider: identityInput.provider,
      providerSubject: identityInput.providerSubject,
      email: identityInput.email,
      displayName: identityInput.displayName,
      emailVerified: identityInput.emailVerified
    };
    return this.issueNativeLinkTicket({
      ...ticket,
      stage: "FINALIZE",
      identity
    });
  }

  public async finalizeNativeLink(input: {
    provider: PrimaryIdentityProvider;
    userId: string;
    sessionId: string;
    code: string;
    codeVerifier: string;
  }): Promise<PrimaryIdentityRecord> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier))
      throw invalidPrimaryLoginError();
    const ticket = await this.consumeNativeLinkTicket(
      input.provider,
      "FINALIZE",
      input.code,
      {
        userId: input.userId,
        sessionId: input.sessionId,
        codeChallenge: createHash("sha256")
          .update(input.codeVerifier, "ascii")
          .digest("base64url")
      }
    );
    if (!ticket.identity) throw invalidPrimaryLoginError();
    // Existing repository enforces subject ownership/provider uniqueness; never
    // merges by email. Consumption is fail-closed: retry from start on DB failure.
    return this.options.repository.linkPrimaryIdentity(ticket.userId, {
      ...ticket.identity,
      now: this.now()
    });
  }

  private async issueNativeLinkTicket(
    ticket: NativeLinkTicket
  ): Promise<string> {
    const code = randomBytes(32).toString("base64url");
    await this.options.repository.createNativeLinkTicket({
      ...ticket,
      secretHash: this.nativeLinkHash(ticket.stage, code),
      expiresAt: new Date(this.now().getTime() + 120_000)
    });
    return code;
  }

  private async consumeNativeLinkTicket(
    provider: PrimaryIdentityProvider,
    stage: NativeLinkTicket["stage"],
    code: string,
    binding?: Pick<NativeLinkTicket, "userId" | "sessionId" | "codeChallenge">
  ): Promise<NativeLinkTicket> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw invalidPrimaryLoginError();
    const ticket = await this.options.repository.consumeNativeLinkTicket({
      provider,
      stage,
      secretHash: this.nativeLinkHash(stage, code),
      now: this.now(),
      ...(binding ? { binding } : {})
    });
    if (!ticket) throw invalidPrimaryLoginError();
    return ticket;
  }

  private nativeLinkHash(
    stage: NativeLinkTicket["stage"],
    value: string
  ): string {
    return this.hashSecret(`native-link-v1:${stage}:${value}`);
  }

  private async verifyAuthorization(
    input: {
      provider: PrimaryIdentityProvider;
      state: string;
      code: string;
      authenticatedUserId: string | null;
      userPayload?: string;
    },
    nativeLink: boolean
  ) {
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
    if (
      !challenge ||
      Boolean(challenge.nativeLink) !== nativeLink ||
      (nativeLink && challenge.intent !== "LINK")
    ) {
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
    return { challenge, identityInput };
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
