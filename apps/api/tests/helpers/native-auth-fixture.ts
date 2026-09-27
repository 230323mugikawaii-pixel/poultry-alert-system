import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { loadEnvironment } from "../../src/config/env.js";
import { AuthService } from "../../src/modules/auth/auth-service.js";
import type {
  AuthRepository,
  AuthUserRecord
} from "../../src/modules/auth/auth-repository.js";
import { PrimaryAuthService } from "../../src/modules/auth/primary-auth-service.js";
import {
  NativeAuthService,
  pkceChallenge,
  type NativeGrant,
  type NativeGrantRepository,
  type NativeProvider
} from "../../src/modules/auth/native-auth-service.js";
import type { PrimaryAuthProviderAdapter } from "../../src/modules/auth/primary-auth-provider.js";
import { SecurityThrottleService } from "../../src/modules/security/security-throttle-service.js";
import { MemorySecurityThrottleRepository } from "./memory-security-throttle.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./memory-auth.js";

export class MemoryNativeGrants implements NativeGrantRepository {
  public readonly rows: (NativeGrant & {
    claimed?: boolean;
    consumed?: boolean;
    codeHash?: string;
    codeExpiresAt?: Date;
    userId?: string;
  })[] = [];
  public constructor(private readonly auth: MemoryAuthRepository) {}
  public async create(input: Omit<NativeGrant, "id">) {
    this.rows.push({ ...input, id: randomUUID() });
  }
  public async owns(hash: string) {
    return this.rows.some((r) => r.stateHash === hash);
  }
  public async claimCallback(
    hash: string,
    binding: string,
    provider: NativeProvider,
    now: Date
  ) {
    const r = this.rows.find(
      (r) =>
        r.stateHash === hash &&
        r.bindingHash === binding &&
        r.provider === provider &&
        !r.claimed &&
        r.expiresAt > now
    );
    if (!r) return null;
    r.claimed = true;
    return r;
  }
  public async issueCode(id: string, userId: string, hash: string, now: Date) {
    const r = this.rows.find((r) => r.id === id)!;
    r.userId = userId;
    r.codeHash = hash;
    r.codeExpiresAt = new Date(now.getTime() + 60000);
  }
  public async consumeCode(
    hash: string,
    challenge: string,
    now: Date
  ): Promise<AuthUserRecord | null> {
    const r = this.rows.find(
      (r) =>
        r.codeHash === hash &&
        r.codeChallenge === challenge &&
        !r.consumed &&
        r.expiresAt > now &&
        r.codeExpiresAt! > now
    );
    if (!r) return null;
    r.consumed = true;
    return (
      [...this.auth.users.values()].find(
        (u) => u.id === r.userId && u.status === "ACTIVE"
      ) ?? null
    );
  }
}
class FakeNativeProvider implements PrimaryAuthProviderAdapter {
  public readonly authorizations = new Map<
    string,
    { nonce: string; challenge: string }
  >();
  public constructor(public readonly provider: NativeProvider) {}
  public createAuthorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }) {
    this.authorizations.set(input.state, {
      nonce: input.nonce,
      challenge: input.codeChallenge
    });
    return `https://provider.example.invalid/authorize?state=${input.state}`;
  }
  public async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    expectedNonce: string;
  }) {
    const saved = this.authorizations.get(input.code);
    if (
      !saved ||
      saved.nonce !== input.expectedNonce ||
      saved.challenge !== pkceChallenge(input.codeVerifier)
    )
      throw new Error("SYNTHETIC_PROVIDER_FAILURE");
    return {
      provider: this.provider,
      subject: `synthetic-${this.provider}`,
      email: `${this.provider.toLowerCase()}@example.invalid`,
      emailVerified: true,
      displayName: "Synthetic OWNER"
    };
  }
}
export async function nativeFixture(
  options: {
    authRepository?: AuthRepository;
    grants?: NativeGrantRepository;
    mode?: "off" | "enabled";
  } = {}
) {
  const memory = new MemoryAuthRepository();
  const repository = options.authRepository ?? memory;
  const grants = options.grants ?? new MemoryNativeGrants(memory);
  let now = new Date();
  const environment = loadEnvironment({
    APP_ENV: "test",
    NATIVE_AUTH_MODE: options.mode ?? "enabled"
  });
  const auth = new AuthService({
    repository,
    emailSender: new MemoryMagicLinkEmailSender(),
    publicOrigin: environment.PUBLIC_ORIGIN,
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    magicLinkTtlMinutes: 10,
    sessionIdleDays: 7,
    sessionAbsoluteDays: 30,
    maxActiveSessions: 10,
    now: () => now
  });
  const primary = new PrimaryAuthService({
    repository,
    authService: auth,
    providerAdapters: [
      new FakeNativeProvider("GOOGLE"),
      new FakeNativeProvider("MICROSOFT")
    ],
    tokenPepper: environment.AUTH_TOKEN_PEPPER,
    stateTtlMinutes: { GOOGLE: 10, MICROSOFT: 10, APPLE: 10 },
    now: () => now
  });
  const native = new NativeAuthService({
    repository: grants,
    auth,
    primary,
    pepper: environment.AUTH_TOKEN_PEPPER,
    now: () => now
  });
  let constructed = 0;
  const app = await buildApp({
    environment,
    logger: false,
    authService: auth,
    primaryAuthService: primary,
    nativeAuthFactory: () => {
      constructed++;
      return native;
    },
    securityThrottleService: new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      environment.AUTH_TOKEN_PEPPER
    )
  });
  return {
    app,
    native,
    auth,
    memory,
    grants,
    environment,
    constructed: () => constructed,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    }
  };
}
