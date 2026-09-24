import { randomUUID, randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  LocalAesGcmTokenEncryptionProvider,
  type TokenEncryptionProvider
} from "../src/modules/mail/token-encryption.js";
import {
  createOAuthFencedRefresh,
  type OAuthScope,
  type TokenProvider,
  type OAuthAccessResult
} from "../src/modules/mail/reliability/oauth-fenced-refresh.js";
import {
  oauthTestDatabase,
  oldSnapshot
} from "./fixtures/oauth-test-database.js";
import {
  seedJobFixture,
  jobHarness,
  jobTopic,
  notification
} from "./fixtures/gmail-job-harness.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";

const postgres =
  process.env.RUN_PR05A_POSTGRES_TESTS === "true" ? describe : describe.skip;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const accessValue = () => `synthetic-${randomUUID()}`;
type Reply = Awaited<ReturnType<TokenProvider["refresh"]>>;

postgres("PR05a fenced refresh (real PostgreSQL, fake provider only)", () => {
  let env: Awaited<ReturnType<typeof oauthTestDatabase>>;
  const encryption = new LocalAesGcmTokenEncryptionProvider(
    randomBytes(32).toString("base64"),
    "synthetic-v1"
  );
  beforeAll(async () => {
    env = await oauthTestDatabase();
  });
  afterAll(async () => {
    await env.close();
  });
  async function seed(provider: OAuthScope["provider"] = "GOOGLE") {
    const owner = await env.db.user.create({
      data: { email: `${randomUUID()}@example.invalid` }
    });
    const plaintext = accessValue(),
      sealed = await encryption.encrypt(plaintext);
    const auth = await env.db.mailAuthorization.create({
      data: {
        userId: owner.id,
        provider,
        providerSubject: randomUUID(),
        email: owner.email,
        encryptedRefreshToken: sealed.ciphertext,
        encryptionProvider: sealed.provider,
        encryptionKeyVersion: sealed.keyVersion
      }
    });
    return {
      scope: { authorizationId: auth.id, userId: owner.id, provider },
      plaintext
    };
  }
  async function future(seconds = 3600) {
    return (
      await env.pool.query<{ at: Date }>(
        "SELECT clock_timestamp()+$1*interval '1 second' AS at",
        [seconds]
      )
    ).rows[0]!.at;
  }
  async function reply(): Promise<Reply> {
    return { accessToken: accessValue(), expiresAt: await future() };
  }
  function service(
    provider: TokenProvider,
    options: { leaseMs?: number; encryption?: TokenEncryptionProvider } = {}
  ) {
    return createOAuthFencedRefresh("shadow", () => ({
      db: env.db,
      encryption,
      provider,
      ...options
    }))!;
  }
  const row = (scope: OAuthScope) =>
    env.db.mailAuthorization.findUniqueOrThrow({
      where: { id: scope.authorizationId }
    });
  async function cache(
    scope: OAuthScope,
    value: string,
    seconds = 3600,
    version = 0
  ) {
    await env.db.mailAuthorization.update({
      where: { id: scope.authorizationId },
      data: {
        encryptedAccessToken: JSON.stringify(await encryption.encrypt(value)),
        accessTokenExpiresAt: await future(seconds),
        credentialVersion: version,
        refreshLeaseToken: null,
        refreshLeaseUntil: null
      }
    });
  }
  function tokenMatches(result: OAuthAccessResult, value: string) {
    return result.kind === "TOKEN" && result.accessToken === value;
  }

  it("100 concurrent acquisitions: one lease, one provider call, 99 BUSY; crypto/provider outside TX", async () => {
    const f = await seed(),
      output = await reply(),
      gate = deferred<Reply>(),
      started = deferred<void>(),
      busy = deferred<void>();
    let busyCount = 0;
    const provider = {
      refresh: vi.fn(async (input: Parameters<TokenProvider["refresh"]>[0]) => {
        expect(input.refreshToken === f.plaintext).toBe(true);
        expect(input.timeoutMs).toBe(10000);
        // Another DB session can lock the row: provider is NOT inside a DB transaction.
        await env.pool.query(
          "SELECT id FROM mail_authorizations WHERE id=$1 FOR UPDATE NOWAIT",
          [f.scope.authorizationId]
        );
        started.resolve();
        return gate.promise;
      })
    };
    const s = service(provider);
    const requests = Array.from({ length: 100 }, async () => {
      const r = await s.acquire(f.scope);
      if (r.kind === "BUSY") {
        expect(r.retryAfterMs).toBeGreaterThan(0);
        if (++busyCount === 99) busy.resolve();
      }
      return r;
    });
    try {
      await started.promise;
      await busy.promise;
      expect(provider.refresh).toHaveBeenCalledTimes(1);
      const pending = await row(f.scope);
      expect(pending.refreshLeaseToken !== null).toBe(true);
      expect(pending.refreshLeaseGeneration).toBe(1n);
      expect(pending.credentialVersion).toBe(0);
    } finally {
      gate.resolve(output);
    }
    const results = await Promise.all(requests);
    expect(results.filter((r) => r.kind === "TOKEN")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "BUSY")).toHaveLength(99);
    const saved = await row(f.scope);
    expect(saved.credentialVersion).toBe(1);
    expect(saved.refreshLeaseToken).toBeNull();
    expect(saved.refreshLeaseUntil).toBeNull();
    expect(saved.encryptedAccessToken?.includes(output.accessToken)).toBe(
      false
    );
    expect(
      (await encryption.decrypt({
        ciphertext: saved.encryptedRefreshToken!,
        provider: saved.encryptionProvider!,
        keyVersion: saved.encryptionKeyVersion!
      })) === f.plaintext
    ).toBe(true);
  }, 15000);

  it("cache TTL >5min returns without refresh; forceRefresh bypasses cache", async () => {
    const f = await seed(),
      cached = accessValue(),
      fresh = await reply();
    await cache(f.scope, cached);
    const provider = { refresh: vi.fn(async () => fresh) },
      s = service(provider);
    expect(tokenMatches(await s.acquire(f.scope), cached)).toBe(true);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect((await row(f.scope)).refreshLeaseGeneration).toBe(0n);
    expect(
      tokenMatches(await s.acquire(f.scope, true), fresh.accessToken)
    ).toBe(true);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([300, 299, -1])("cache TTL %is is not reusable", async (seconds) => {
    const f = await seed();
    await cache(f.scope, accessValue(), seconds);
    const provider = { refresh: vi.fn(reply) };
    expect((await service(provider).acquire(f.scope)).kind).toBe("TOKEN");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it("TX2 version mismatch affects zero rows and returns latest stored credential, not old response", async () => {
    const f = await seed(),
      gate = deferred<Reply>(),
      started = deferred<void>();
    const pending = service({
      refresh: async () => {
        started.resolve();
        return gate.promise;
      }
    }).acquire(f.scope);
    await started.promise;
    const latest = accessValue();
    await cache(f.scope, latest, 3600, 7);
    const before = serialize(await row(f.scope));
    gate.resolve({ ...(await reply()), rotatedRefreshToken: accessValue() });
    const result = await pending;
    expect(tokenMatches(result, latest)).toBe(true);
    expect(result.kind === "TOKEN" && result.source === "LATEST").toBe(true);
    expect(serialize(await row(f.scope)) === before).toBe(true);
  });

  it("version mismatch without a latest cache returns STALE, never re-refreshes", async () => {
    const f = await seed(),
      gate = deferred<Reply>(),
      started = deferred<void>();
    const provider = {
      refresh: vi.fn(async () => {
        started.resolve();
        return gate.promise;
      })
    };
    const pending = service(provider).acquire(f.scope);
    await started.promise;
    await env.db.mailAuthorization.update({
      where: { id: f.scope.authorizationId },
      data: {
        credentialVersion: 9,
        refreshLeaseToken: null,
        refreshLeaseUntil: null
      }
    });
    gate.resolve(await reply());
    expect(await pending).toEqual({ kind: "STALE" });
    expect((await row(f.scope)).encryptedAccessToken).toBeNull();
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it("expired lease is recovered by another worker; old generation cannot write or clear new lease", async () => {
    const f = await seed(),
      first = deferred<Reply>(),
      firstStarted = deferred<void>(),
      second = deferred<Reply>(),
      secondStarted = deferred<void>();
    const old = service(
      {
        refresh: async () => {
          firstStarted.resolve();
          return first.promise;
        }
      },
      { leaseMs: 100 }
    ).acquire(f.scope);
    await firstStarted.promise;
    await env.pool.query("SELECT pg_sleep(0.15)");
    const current = service({
      refresh: async () => {
        secondStarted.resolve();
        return second.promise;
      }
    }).acquire(f.scope);
    await secondStarted.promise;
    const before = await row(f.scope);
    expect(before.refreshLeaseGeneration).toBe(2n);
    first.resolve(await reply());
    expect((await old).kind).toBe("BUSY");
    const after = await row(f.scope);
    expect(after.refreshLeaseToken === before.refreshLeaseToken).toBe(true);
    expect(after.credentialVersion).toBe(0);
    expect(after.encryptedAccessToken).toBeNull();
    const response = await reply();
    second.resolve(response);
    expect(tokenMatches(await current, response.accessToken)).toBe(true);
    expect((await row(f.scope)).credentialVersion).toBe(1);
  });

  it("expired lease without takeover cannot commit even with matching token/version/generation", async () => {
    const f = await seed(),
      started = deferred<void>(),
      gate = deferred<Reply>();
    const p = service(
      {
        refresh: async () => {
          started.resolve();
          return gate.promise;
        }
      },
      { leaseMs: 50 }
    ).acquire(f.scope);
    await started.promise;
    await env.pool.query("SELECT pg_sleep(0.1)");
    gate.resolve(await reply());
    expect(await p).toEqual({ kind: "STALE" });
    const r = await row(f.scope);
    expect(r.encryptedAccessToken).toBeNull();
    expect(r.credentialVersion).toBe(0);
    expect((await service({ refresh: reply }).acquire(f.scope)).kind).toBe(
      "TOKEN"
    );
  });

  it("10s provider timeout aborts, releases own lease, has no partial credentials; ignored late response cannot write", async () => {
    const f = await seed(),
      initial = await row(f.scope),
      started = deferred<void>(),
      gate = deferred<Reply>();
    let signal: AbortSignal | undefined;
    const provider = {
      refresh: vi.fn(async (input: Parameters<TokenProvider["refresh"]>[0]) => {
        signal = input.signal;
        started.resolve();
        return gate.promise;
      })
    } satisfies TokenProvider;
    const p = service(provider).acquire(f.scope);
    const rejection = expect(p).rejects.toThrow(/^OAUTH_REFRESH_TIMEOUT$/);
    await started.promise;
    const start = performance.now();
    await rejection;
    expect(performance.now() - start).toBeGreaterThanOrEqual(9800);
    expect(signal?.aborted).toBe(true);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    const timed = await row(f.scope);
    expect(timed.refreshLeaseToken).toBeNull();
    expect(timed.refreshLeaseUntil).toBeNull();
    expect(timed.encryptedAccessToken).toBeNull();
    expect(timed.accessTokenExpiresAt).toBeNull();
    expect(timed.credentialVersion).toBe(0);
    expect(timed.encryptedRefreshToken === initial.encryptedRefreshToken).toBe(
      true
    );
    const fresh = await service({ refresh: reply }).acquire(f.scope);
    expect(fresh.kind).toBe("TOKEN");
    const beforeLate = serialize(await row(f.scope));
    gate.resolve({ ...(await reply()), rotatedRefreshToken: accessValue() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(serialize(await row(f.scope)) === beforeLate).toBe(true);
  }, 15000);

  it.each(["REAUTH_REQUIRED", "REVOKED", "ERROR"] as const)(
    "status %s is never refreshed or changed",
    async (status) => {
      const f = await seed();
      await env.db.mailAuthorization.update({
        where: { id: f.scope.authorizationId },
        data: { status }
      });
      const provider = { refresh: vi.fn(reply) };
      expect(await service(provider).acquire(f.scope)).toEqual({
        kind: "UNAVAILABLE"
      });
      expect(provider.refresh).not.toHaveBeenCalled();
      expect((await row(f.scope)).status).toBe(status);
    }
  );

  it("rotation persists refresh/access atomically using existing encryption; missing rotation preserves old metadata", async () => {
    const f = await seed("MICROSOFT"),
      original = await row(f.scope),
      rotation = accessValue();
    const output = { ...(await reply()), rotatedRefreshToken: rotation };
    expect(
      tokenMatches(
        await service({ refresh: async () => output }).acquire(f.scope),
        output.accessToken
      )
    ).toBe(true);
    const r = await row(f.scope);
    expect(r.encryptedRefreshToken !== original.encryptedRefreshToken).toBe(
      true
    );
    expect(
      (await encryption.decrypt({
        ciphertext: r.encryptedRefreshToken!,
        provider: r.encryptionProvider!,
        keyVersion: r.encryptionKeyVersion!
      })) === rotation
    ).toBe(true);
    expect(r.credentialVersion).toBe(1);
    await service({ refresh: reply }).acquire(f.scope, true);
    const next = await row(f.scope);
    expect(next.encryptedRefreshToken === r.encryptedRefreshToken).toBe(true);
    expect(
      next.encryptionProvider === r.encryptionProvider &&
        next.encryptionKeyVersion === r.encryptionKeyVersion
    ).toBe(true);
  });

  it("provider/crypto failures are sanitized and do not change authorization status or existing credential", async () => {
    const f = await seed(),
      before = await row(f.scope),
      secret = accessValue();
    const provider = {
      refresh: vi.fn(async () => {
        throw new Error(secret);
      })
    };
    await expect(service(provider).acquire(f.scope)).rejects.toThrow(
      /^OAUTH_REFRESH_PREPARATION_FAILED$/
    );
    const r = await row(f.scope);
    expect(r.status).toBe("ACTIVE");
    expect(r.refreshLeaseToken).toBeNull();
    expect(r.credentialVersion).toBe(0);
    expect(r.encryptedRefreshToken === before.encryptedRefreshToken).toBe(true);
    const failingCrypto: TokenEncryptionProvider = {
      decrypt: encryption.decrypt.bind(encryption),
      encrypt: async () => {
        throw new Error(secret);
      }
    };
    await expect(
      service({ refresh: reply }, { encryption: failingCrypto }).acquire(
        f.scope
      )
    ).rejects.toThrow(/^OAUTH_REFRESH_PREPARATION_FAILED$/);
    expect((await row(f.scope)).encryptedAccessToken).toBeNull();
  });

  it("delayed failure cannot clear newer lease/credential; does not implement 05b status mutation", async () => {
    const f = await seed(),
      gate = deferred<void>(),
      started = deferred<void>();
    const p = service({
      refresh: async () => {
        started.resolve();
        await gate.promise;
        throw new Error("synthetic invalid_grant");
      }
    }).acquire(f.scope);
    const reject = expect(p).rejects.toThrow(
      /^OAUTH_REFRESH_PREPARATION_FAILED$/
    );
    await started.promise;
    await cache(f.scope, accessValue(), 3600, 8);
    const before = serialize(await row(f.scope));
    gate.resolve();
    await reject;
    expect(serialize(await row(f.scope)) === before).toBe(true);
  });

  it("user/provider/authorization scope mismatch never claims or contacts provider", async () => {
    const f = await seed(),
      provider = { refresh: vi.fn(reply) },
      s = service(provider);
    for (const scope of [
      { ...f.scope, userId: randomUUID() },
      { ...f.scope, authorizationId: randomUUID() },
      { ...f.scope, provider: "MICROSOFT" as const }
    ])
      expect(await s.acquire(scope)).toEqual({ kind: "UNAVAILABLE" });
    expect(provider.refresh).not.toHaveBeenCalled();
    expect((await row(f.scope)).refreshLeaseGeneration).toBe(0n);
  });

  it("cache decryption racing a replacement returns STALE; no token from losing version", async () => {
    const f = await seed(),
      started = deferred<void>(),
      gate = deferred<void>();
    await cache(f.scope, accessValue());
    const delayed: TokenEncryptionProvider = {
      encrypt: encryption.encrypt.bind(encryption),
      decrypt: async (token) => {
        started.resolve();
        await gate.promise;
        return encryption.decrypt(token);
      }
    };
    const p = service({ refresh: reply }, { encryption: delayed }).acquire(
      f.scope
    );
    await started.promise;
    await cache(f.scope, accessValue(), 3600, 2);
    gate.resolve();
    expect(await p).toEqual({ kind: "STALE" });
  });

  it("DB clock, not application clock, governs cache/lease; no external I/O in TX2", async () => {
    const f = await seed(),
      cached = accessValue();
    await cache(f.scope, cached);
    const provider = { refresh: vi.fn(reply) };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    try {
      expect(
        tokenMatches(await service(provider).acquire(f.scope), cached)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("OFF: legacy worker/includes preserve defaults and results; factory never constructed", async () => {
    const f = await seedJobFixture(env.db),
      deps = vi.fn(() => {
        throw new Error("must not construct");
      });
    expect(createOAuthFencedRefresh("off", deps)).toBeUndefined();
    const q = new PrismaGmailJobQueue(env.db, jobTopic),
      h = await jobHarness(env.db, f.connection.id);
    await q.accept(notification(f.authorization.email));
    expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
      "DONE"
    );
    const included = await env.db.mailConnection.findUniqueOrThrow({
      where: { id: f.connection.id },
      include: { mailAuthorization: true }
    });
    const a = included.mailAuthorization;
    expect(a.encryptedAccessToken).toBeNull();
    expect(a.accessTokenExpiresAt).toBeNull();
    expect(a.refreshLeaseToken).toBeNull();
    expect(a.refreshLeaseUntil).toBeNull();
    expect(a.credentialVersion).toBe(0);
    expect(a.refreshLeaseGeneration).toBe(0n);
    expect(deps).not.toHaveBeenCalled();
    expect(await env.db.alert.count({ where: { teamId: f.team.id } })).toBe(1);
    expect(
      await env.db.reliabilityOutbox.count({ where: { teamId: f.team.id } })
    ).toBe(2);
  });
  it("unrotated refresh leaves all existing table columns/data unchanged", async () => {
    const f = await seed(),
      before = await oldSnapshot(env.pool);
    expect((await service({ refresh: reply }).acquire(f.scope)).kind).toBe(
      "TOKEN"
    );
    expect(await oldSnapshot(env.pool)).toBe(before);
  });
  it("access cache has independent encryption metadata; crypto runs outside transactions", async () => {
    const f = await seed(),
      original = await row(f.scope);
    const nextKey = new LocalAesGcmTokenEncryptionProvider(
      randomBytes(32).toString("base64"),
      "synthetic-v2"
    );
    let checks = 0;
    const checkLock = async () => {
      await env.pool.query(
        "SELECT id FROM mail_authorizations WHERE id=$1 FOR UPDATE NOWAIT",
        [f.scope.authorizationId]
      );
      checks += 1;
    };
    const router: TokenEncryptionProvider = {
      encrypt: async (value) => {
        await checkLock();
        return nextKey.encrypt(value);
      },
      decrypt: async (sealed) => {
        await checkLock();
        return (
          sealed.keyVersion === "synthetic-v2" ? nextKey : encryption
        ).decrypt(sealed);
      }
    };
    const output = await reply(),
      provider = { refresh: vi.fn(async () => output) },
      s = service(provider, { encryption: router });
    expect(tokenMatches(await s.acquire(f.scope), output.accessToken)).toBe(
      true
    );
    expect(tokenMatches(await s.acquire(f.scope), output.accessToken)).toBe(
      true
    );
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(checks).toBe(4);
    const persisted = await row(f.scope);
    expect(
      persisted.encryptedRefreshToken === original.encryptedRefreshToken
    ).toBe(true);
    expect(
      persisted.encryptionKeyVersion === original.encryptionKeyVersion
    ).toBe(true);
  });
  it("rotated-token encryption failure has no partial access/refresh write", async () => {
    const f = await seed(),
      original = await row(f.scope);
    let count = 0;
    const failing: TokenEncryptionProvider = {
      decrypt: encryption.decrypt.bind(encryption),
      encrypt: async (value) => {
        if (++count === 2) throw new Error(accessValue());
        return encryption.encrypt(value);
      }
    };
    await expect(
      service(
        {
          refresh: async () => ({
            ...(await reply()),
            rotatedRefreshToken: accessValue()
          })
        },
        { encryption: failing }
      ).acquire(f.scope)
    ).rejects.toThrow(/^OAUTH_REFRESH_PREPARATION_FAILED$/);
    const persisted = await row(f.scope);
    expect(
      persisted.encryptedRefreshToken === original.encryptedRefreshToken
    ).toBe(true);
    expect(persisted.encryptedAccessToken).toBeNull();
    expect(persisted.accessTokenExpiresAt).toBeNull();
    expect(persisted.credentialVersion).toBe(0);
    expect(persisted.refreshLeaseToken).toBeNull();
  });
  it("a credential cleared/revoked in flight is never revived by a successful old refresh", async () => {
    const f = await seed(),
      started = deferred<void>(),
      gate = deferred<Reply>();
    const p = service({
      refresh: async () => {
        started.resolve();
        return gate.promise;
      }
    }).acquire(f.scope);
    await started.promise;
    await env.db.mailAuthorization.update({
      where: { id: f.scope.authorizationId },
      data: {
        status: "REVOKED",
        revokedAt: await future(-1),
        encryptedRefreshToken: null,
        credentialVersion: { increment: 1 },
        refreshLeaseToken: null,
        refreshLeaseUntil: null
      }
    });
    const before = serialize(await row(f.scope));
    gate.resolve(await reply());
    expect(await p).toEqual({ kind: "UNAVAILABLE" });
    expect(serialize(await row(f.scope)) === before).toBe(true);
  });
});

// No plaintext is emitted in failed assertion diffs.
function serialize(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  );
}
