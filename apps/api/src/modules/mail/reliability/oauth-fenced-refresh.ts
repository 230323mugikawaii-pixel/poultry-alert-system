import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../../db/client.js";
import { retrySerializableTransaction } from "../../../db/transaction-retry.js";
import {
  Prisma,
  type MailAuthorization
} from "../../../generated/prisma/client.js";
import type {
  TokenEncryptionProvider,
  StoredEncryptedToken
} from "../token-encryption.js";

export type OAuthFencedRefreshMode = "off" | "shadow";
export interface OAuthScope {
  readonly authorizationId: string;
  readonly userId: string;
  readonly provider: "GOOGLE" | "MICROSOFT";
}
export interface TokenProvider {
  refresh(input: {
    readonly provider: OAuthScope["provider"];
    readonly refreshToken: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: 10000;
  }): Promise<{
    readonly accessToken: string;
    readonly expiresAt: Date;
    readonly rotatedRefreshToken?: string | null;
  }>;
}
export type OAuthAccessResult =
  | {
      readonly kind: "TOKEN";
      readonly accessToken: string;
      readonly expiresAt: Date;
      readonly credentialVersion: number;
      readonly source: "CACHE" | "REFRESH" | "LATEST";
    }
  | { readonly kind: "BUSY"; readonly retryAfterMs: number }
  | { readonly kind: "STALE" | "UNAVAILABLE" };

interface Dependencies {
  readonly db: DatabaseClient;
  readonly encryption: TokenEncryptionProvider;
  readonly provider: TokenProvider;
  /** Defaults to 30s (>10s HTTP deadline). Shorter values allow deterministic lease tests. */
  readonly leaseMs?: number;
}
type Lease = OAuthScope & {
  readonly token: string;
  readonly generation: bigint;
  readonly version: number;
  readonly refresh: StoredEncryptedToken;
};
type Row = MailAuthorization & { readonly dbNow: Date };
type Cached = {
  readonly kind: "CACHED";
  readonly encrypted: string;
  readonly expiresAt: Date;
  readonly version: number;
};
type Reservation =
  | Cached
  | { readonly kind: "CLAIMED"; readonly lease: Lease }
  | Exclude<OAuthAccessResult, { kind: "TOKEN" }>;

/** Lazy factory. No production caller in 05a, including in shadow mode. */
export function createOAuthFencedRefresh(
  mode: OAuthFencedRefreshMode = "off",
  dependencies: () => Dependencies
): OAuthFencedRefresh | undefined {
  if (mode === "off") return undefined;
  if (mode !== "shadow") throw safeError("MODE_INVALID");
  return new OAuthFencedRefresh(dependencies());
}

/** Isolated foundation. Do NOT connect to real credentials before 05b guards all writers. */
class OAuthFencedRefresh {
  private readonly leaseMs: number;
  public constructor(private readonly deps: Dependencies) {
    this.leaseMs = deps.leaseMs ?? 30000;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1 ||
      this.leaseMs > 300000
    )
      throw safeError("LEASE_INVALID");
  }

  public async acquire(
    scope: OAuthScope,
    forceRefresh = false
  ): Promise<OAuthAccessResult> {
    validateScope(scope);
    const reservation = await this.transaction(
      async (tx): Promise<Reservation> => {
        const row = await lockAndRead(tx, scope);
        if (!usable(row)) return { kind: "UNAVAILABLE" };
        const cached = cachedToken(row);
        if (!forceRefresh && cached) return cached;
        if (row.refreshLeaseUntil && row.refreshLeaseUntil > row.dbNow)
          return {
            kind: "BUSY",
            retryAfterMs: Math.max(
              1,
              row.refreshLeaseUntil.getTime() - row.dbNow.getTime()
            )
          };
        if (
          !row.encryptedRefreshToken ||
          !row.encryptionProvider ||
          !row.encryptionKeyVersion
        )
          return { kind: "UNAVAILABLE" };
        const token = randomUUID();
        const [claim] = await tx.$queryRaw<
          Array<{ refreshLeaseGeneration: bigint }>
        >`
        UPDATE mail_authorizations
        SET "refreshLeaseToken"=${token}::uuid,
            "refreshLeaseUntil"=clock_timestamp() + ${this.leaseMs} * interval '1 millisecond',
            "refreshLeaseGeneration"="refreshLeaseGeneration"+1
        WHERE id=${scope.authorizationId}::uuid
        RETURNING "refreshLeaseGeneration"`;
        if (!claim) throw safeError("CLAIM_FAILED");
        return {
          kind: "CLAIMED",
          lease: {
            ...scope,
            token,
            generation: claim.refreshLeaseGeneration,
            version: row.credentialVersion,
            refresh: {
              ciphertext: row.encryptedRefreshToken,
              provider: row.encryptionProvider,
              keyVersion: row.encryptionKeyVersion
            }
          }
        };
      }
    );
    if (reservation.kind === "CACHED")
      return this.decodeCached(scope, reservation, "CACHE");
    if (reservation.kind !== "CLAIMED") return reservation;
    const lease = reservation.lease;
    let encryptedAccess: string,
      rotated: StoredEncryptedToken | null,
      expiresAt: Date;
    try {
      // Decrypt/provider/encrypt can perform I/O. All are outside DB transactions/retries.
      const refreshToken = await this.deps.encryption.decrypt(lease.refresh);
      const refreshed = await refreshWithDeadline(
        this.deps.provider,
        scope.provider,
        refreshToken
      );
      assertPlaintext(refreshed.accessToken);
      if (
        !(refreshed.expiresAt instanceof Date) ||
        !Number.isFinite(refreshed.expiresAt.getTime())
      )
        throw safeError("PROVIDER_RESPONSE_INVALID");
      expiresAt = refreshed.expiresAt;
      // Cache has its own envelope; shared refresh metadata must not be changed when no rotation occurs.
      encryptedAccess = JSON.stringify(
        await this.deps.encryption.encrypt(refreshed.accessToken)
      );
      const next = refreshed.rotatedRefreshToken;
      if (next !== undefined && next !== null) assertPlaintext(next);
      rotated = next ? await this.deps.encryption.encrypt(next) : null;
    } catch (error) {
      await this.release(lease);
      // 05a deliberately does not classify invalid_grant or mutate status/connections/audit.
      throw safeError(
        error instanceof RefreshDeadlineError ? "TIMEOUT" : "PREPARATION_FAILED"
      );
    }
    const count = await this.transaction(
      (tx) => tx.$executeRaw`
      UPDATE mail_authorizations
      SET "encryptedAccessToken"=${encryptedAccess}, "accessTokenExpiresAt"=${expiresAt},
          "encryptedRefreshToken"=COALESCE(${rotated?.ciphertext ?? null},"encryptedRefreshToken"),
          "encryptionProvider"=COALESCE(${rotated?.provider ?? null},"encryptionProvider"),
          "encryptionKeyVersion"=COALESCE(${rotated?.keyVersion ?? null},"encryptionKeyVersion"),
          "credentialVersion"="credentialVersion"+1,
          "refreshLeaseToken"=NULL,"refreshLeaseUntil"=NULL
      WHERE id=${lease.authorizationId}::uuid AND "userId"=${lease.userId}::uuid
        AND provider=${lease.provider}::"MailProvider" AND status='ACTIVE' AND "revokedAt" IS NULL
        AND "credentialVersion"=${lease.version} AND "refreshLeaseToken"=${lease.token}::uuid
        AND "refreshLeaseGeneration"=${lease.generation} AND "refreshLeaseUntil">clock_timestamp()
        AND ${expiresAt}::timestamptz>clock_timestamp()`
    );
    // Never return the losing provider result. Re-read persisted state, without a recursive refresh.
    return this.latest(scope, count === 1 ? "REFRESH" : "LATEST");
  }

  private async release(lease: Lease): Promise<void> {
    await this.transaction(
      (tx) => tx.$executeRaw`
      UPDATE mail_authorizations SET "refreshLeaseToken"=NULL,"refreshLeaseUntil"=NULL
      WHERE id=${lease.authorizationId}::uuid AND "userId"=${lease.userId}::uuid
        AND provider=${lease.provider}::"MailProvider" AND "credentialVersion"=${lease.version}
        AND "refreshLeaseToken"=${lease.token}::uuid AND "refreshLeaseGeneration"=${lease.generation}`
    );
  }

  private async latest(
    scope: OAuthScope,
    source: "REFRESH" | "LATEST"
  ): Promise<OAuthAccessResult> {
    const snapshot = await this.transaction(
      async (
        tx
      ): Promise<Cached | Exclude<OAuthAccessResult, { kind: "TOKEN" }>> => {
        const row = await lockAndRead(tx, scope);
        if (!usable(row)) return { kind: "UNAVAILABLE" };
        // A just-refreshed token can have <=5min TTL; cache *reuse* requires >5min.
        const cached = cachedToken(row, source === "REFRESH" ? 0 : 300000);
        if (cached) return cached;
        if (row.refreshLeaseUntil && row.refreshLeaseUntil > row.dbNow)
          return {
            kind: "BUSY",
            retryAfterMs: Math.max(
              1,
              row.refreshLeaseUntil.getTime() - row.dbNow.getTime()
            )
          };
        return { kind: "STALE" };
      }
    );
    return snapshot.kind === "CACHED"
      ? this.decodeCached(scope, snapshot, source)
      : snapshot;
  }

  private async decodeCached(
    scope: OAuthScope,
    cached: Cached,
    source: "CACHE" | "REFRESH" | "LATEST"
  ): Promise<OAuthAccessResult> {
    let accessToken: string;
    try {
      const envelope: unknown = JSON.parse(cached.encrypted);
      if (!validEnvelope(envelope)) throw safeError("CACHE_INVALID");
      accessToken = await this.deps.encryption.decrypt(envelope);
      assertPlaintext(accessToken);
    } catch {
      throw safeError("CACHE_UNAVAILABLE");
    }
    // Decryption (e.g. KMS) is outside TX and may be slow: don't return credentials replaced meanwhile.
    const stillCurrent = await this.transaction(async (tx) => {
      const row = await lockAndRead(tx, scope);
      return (
        usable(row) &&
        row.credentialVersion === cached.version &&
        row.encryptedAccessToken === cached.encrypted &&
        Boolean(
          row.accessTokenExpiresAt && row.accessTokenExpiresAt > row.dbNow
        )
      );
    });
    return stillCurrent
      ? {
          kind: "TOKEN",
          accessToken,
          expiresAt: cached.expiresAt,
          credentialVersion: cached.version,
          source
        }
      : { kind: "STALE" };
  }

  private async transaction<T>(
    body: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.deps.db.$transaction(body, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable
          }),
        () => safeError("DB_CONFLICT")
      );
    } catch {
      throw safeError("DB_UNAVAILABLE");
    } // Never expose query parameters, URLs, adapter errors or cause.
  }
}

function safeError(code: string): Error {
  return new Error(`OAUTH_REFRESH_${code}`);
}
function validateScope(scope: OAuthScope) {
  if (
    ![scope.authorizationId, scope.userId].every((x) =>
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x)
    ) ||
    !["GOOGLE", "MICROSOFT"].includes(scope.provider)
  )
    throw safeError("SCOPE_INVALID");
}
function usable(row: Row | undefined): row is Row {
  return Boolean(row && row.status === "ACTIVE" && !row.revokedAt);
}
function cachedToken(row: Row, minimumTtlMs = 300000): Cached | null {
  return row.encryptedAccessToken &&
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() - row.dbNow.getTime() > minimumTtlMs
    ? {
        kind: "CACHED",
        encrypted: row.encryptedAccessToken,
        expiresAt: row.accessTokenExpiresAt,
        version: row.credentialVersion
      }
    : null;
}
async function lockAndRead(
  tx: Prisma.TransactionClient,
  scope: OAuthScope
): Promise<Row | undefined> {
  // Read DB time AFTER acquiring the row lock, never transaction-start/app time.
  await tx.$queryRaw`SELECT id FROM mail_authorizations WHERE id=${scope.authorizationId}::uuid AND "userId"=${scope.userId}::uuid AND provider=${scope.provider}::"MailProvider" FOR UPDATE`;
  const [row] = await tx.$queryRaw<
    Row[]
  >`SELECT *,clock_timestamp() AS "dbNow" FROM mail_authorizations WHERE id=${scope.authorizationId}::uuid AND "userId"=${scope.userId}::uuid AND provider=${scope.provider}::"MailProvider"`;
  return row;
}
function assertPlaintext(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 16384 ||
    /[\r\n\0]/u.test(value)
  )
    throw safeError("PROVIDER_RESPONSE_INVALID");
}
function validEnvelope(value: unknown): value is StoredEncryptedToken {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [v.ciphertext, v.provider, v.keyVersion].every(
    (x) => typeof x === "string" && x.length > 0
  );
}
class RefreshDeadlineError extends Error {}
async function refreshWithDeadline(
  provider: TokenProvider,
  kind: OAuthScope["provider"],
  refreshToken: string
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        provider.refresh({
          provider: kind,
          refreshToken,
          signal: controller.signal,
          timeoutMs: 10000
        })
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new RefreshDeadlineError();
          reject(error);
          controller.abort(error);
        }, 10000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Abort is advisory; an ignoring provider may complete later. There is no continuation that persists that late result.
}
