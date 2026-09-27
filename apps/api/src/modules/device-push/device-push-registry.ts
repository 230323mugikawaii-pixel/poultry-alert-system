import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import type { TokenEncryptionProvider } from "../mail/token-encryption.js";

export interface PushPrincipal {
  readonly teamId: string;
  readonly principalKind: "OWNER" | "MEMBER";
  readonly principalId: string;
}

const publicSelect = {
  targetKey: true,
  installationId: true,
  platform: true,
  tokenVersion: true,
  status: true,
  createdAt: true,
  lastSeenAt: true,
  rotatedAt: true
} as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createDevicePushRegistry(
  mode: "off" | "shadow",
  dependencies: () => {
    database: DatabaseClient;
    encryption: TokenEncryptionProvider;
    tokenPepper: string;
  }
): DevicePushRegistry | undefined {
  if (mode === "off") return undefined;
  const { database, encryption, tokenPepper } = dependencies();
  return new DevicePushRegistry(database, encryption, tokenPepper);
}

export class DevicePushRegistry {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly encryption: TokenEncryptionProvider,
    private readonly tokenPepper: string
  ) {
    if (tokenPepper.length < 32)
      throw new Error("PUSH_REGISTRY_CONFIGURATION_INVALID");
  }

  public async register(
    scope: PushPrincipal,
    installationId: string,
    deviceToken: string
  ) {
    this.validateScope(scope);
    if (!uuid.test(installationId)) throw invalid();
    const token = await this.protectToken(deviceToken);
    return this.transaction(scope, async (tx) => {
      const rows = await tx.$queryRaw<{ targetKey: string }[]>`
        INSERT INTO device_push_registrations
          ("targetKey", "teamId", "principalKind", "principalId", "ownerUserId", "notificationMemberId",
           "installationId", platform, "encryptedToken", "tokenHash", "tokenVersion", status, "createdAt", "lastSeenAt")
        VALUES (${randomUUID()}::uuid, ${scope.teamId}::uuid, ${scope.principalKind}::"PushPrincipalKind",
          ${scope.principalId}::uuid, ${scope.principalKind === "OWNER" ? scope.principalId : null}::uuid,
          ${scope.principalKind === "MEMBER" ? scope.principalId : null}::uuid, ${installationId}::uuid,
          'APNS', ${token.encrypted}, ${token.hash}, 1, 'ACTIVE', clock_timestamp(), clock_timestamp())
        ON CONFLICT ("teamId", "principalKind", "principalId", platform, "installationId") DO UPDATE
          SET "encryptedToken"=EXCLUDED."encryptedToken", "tokenHash"=EXCLUDED."tokenHash",
            "tokenVersion"=device_push_registrations."tokenVersion"+1, status='ACTIVE',
            "lastSeenAt"=clock_timestamp(), "rotatedAt"=clock_timestamp()
        RETURNING "targetKey"`;
      return tx.devicePushRegistration.findUniqueOrThrow({
        where: { targetKey: rows[0]!.targetKey },
        select: publicSelect
      });
    });
  }

  public async get(scope: PushPrincipal, targetKey: string) {
    this.validateScope(scope, targetKey);
    return this.transaction(scope, async (tx) => {
      const row = await tx.devicePushRegistration.findFirst({
        where: { ...scope, targetKey },
        select: publicSelect
      });
      if (!row) throw notFound();
      return row;
    });
  }

  public async rotate(
    scope: PushPrincipal,
    targetKey: string,
    tokenVersion: number,
    deviceToken: string
  ) {
    this.validateScope(scope, targetKey, tokenVersion);
    const token = await this.protectToken(deviceToken);
    return this.transaction(scope, async (tx) => {
      const row = await this.lockTarget(tx, scope, targetKey);
      if (row.tokenVersion !== tokenVersion || row.status !== "ACTIVE")
        throw conflict();
      return tx.devicePushRegistration.update({
        where: { targetKey },
        data: {
          encryptedToken: token.encrypted,
          tokenHash: token.hash,
          tokenVersion: { increment: 1 },
          lastSeenAt: new Date(row.dbNow),
          rotatedAt: new Date(row.dbNow)
        },
        select: publicSelect
      });
    });
  }

  public async revoke(
    scope: PushPrincipal,
    targetKey: string,
    tokenVersion: number
  ) {
    this.validateScope(scope, targetKey, tokenVersion);
    return this.transaction(scope, async (tx) => {
      const row = await this.lockTarget(tx, scope, targetKey);
      if (row.status === "REVOKED")
        return tx.devicePushRegistration.findUniqueOrThrow({
          where: { targetKey },
          select: publicSelect
        });
      if (row.tokenVersion !== tokenVersion) throw conflict();
      return tx.devicePushRegistration.update({
        where: { targetKey },
        data: {
          status: "REVOKED",
          encryptedToken: null,
          tokenHash: null,
          tokenVersion: { increment: 1 }
        },
        select: publicSelect
      });
    });
  }

  private async lockTarget(
    tx: Prisma.TransactionClient,
    scope: PushPrincipal,
    targetKey: string
  ) {
    const rows = await tx.$queryRaw<
      { tokenVersion: number; status: string; dbNow: Date }[]
    >`
      SELECT "tokenVersion", status, clock_timestamp() AS "dbNow"
      FROM device_push_registrations
      WHERE "targetKey"=${targetKey}::uuid AND "teamId"=${scope.teamId}::uuid
        AND "principalKind"=${scope.principalKind}::"PushPrincipalKind" AND "principalId"=${scope.principalId}::uuid
      FOR UPDATE`;
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  private async transaction<T>(
    scope: PushPrincipal,
    action: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    try {
      // READ COMMITTED + row locks + atomic UPSERT. No SELECT-then-INSERT race.
      // Authorization rows remain locked until the write commits; concurrent disable/removal cannot pass unnoticed.
      return await this.database.$transaction(
        async (tx) => {
          const teams = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM teams WHERE id=${scope.teamId}::uuid AND status='ACTIVE' FOR SHARE`;
          if (teams.length !== 1) throw forbidden();
          const principals =
            scope.principalKind === "OWNER"
              ? await tx.$queryRaw<{ id: string }[]>`
            SELECT u.id FROM users u JOIN team_memberships m ON m."userId"=u.id
            WHERE u.id=${scope.principalId}::uuid AND u.status='ACTIVE' AND u."deletedAt" IS NULL
              AND m."teamId"=${scope.teamId}::uuid AND m.role='OWNER' AND m.status='ACTIVE'
            FOR SHARE OF u,m`
              : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM notification_members WHERE id=${scope.principalId}::uuid
              AND "teamId"=${scope.teamId}::uuid AND status='ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
          if (principals.length !== 1) throw forbidden();
          return action(tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isUniqueConflict(error))
        throw new AppError(
          "PUSH_REGISTRATION_CONFLICT",
          "この端末情報では登録できません。",
          409
        );
      // Never expose adapter SQL, parameters, ciphertext, provider errors or connection details.
      throw new AppError(
        "PUSH_REGISTRY_UNAVAILABLE",
        "端末の登録を完了できませんでした。",
        503
      );
    }
  }

  private async protectToken(value: string) {
    // Native client contract: hex encoding of opaque APNs bytes, not a fixed 32-byte assumption.
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      !/^(?:[0-9a-f]{2})+$/iu.test(value)
    )
      throw invalid();
    try {
      const normalized = value.toLowerCase();
      const encrypted = await this.encryption.encrypt(normalized);
      return {
        encrypted: JSON.stringify(encrypted),
        hash: createHmac("sha256", this.tokenPepper)
          .update(`push-registry:APNS:${normalized}`)
          .digest("hex")
      };
    } catch {
      throw new AppError(
        "PUSH_REGISTRY_UNAVAILABLE",
        "端末の登録を完了できませんでした。",
        503
      );
    }
  }

  private validateScope(
    scope: PushPrincipal,
    targetKey?: string,
    version?: number
  ) {
    if (
      !uuid.test(scope.teamId) ||
      !uuid.test(scope.principalId) ||
      !["OWNER", "MEMBER"].includes(scope.principalKind) ||
      (targetKey !== undefined && !uuid.test(targetKey)) ||
      (version !== undefined &&
        (!Number.isInteger(version) || version < 1 || version >= 2147483647))
    )
      throw invalid();
  }
}

function invalid() {
  return new AppError(
    "INVALID_PUSH_REGISTRATION",
    "端末の登録内容を確認してください。",
    400
  );
}
function notFound() {
  return new AppError(
    "PUSH_REGISTRATION_NOT_FOUND",
    "端末登録が見つかりません。",
    404
  );
}
function forbidden() {
  return new AppError(
    "PUSH_REGISTRATION_FORBIDDEN",
    "この操作は許可されていません。",
    403
  );
}
function conflict() {
  return new AppError(
    "PUSH_REGISTRATION_VERSION_CONFLICT",
    "端末登録を再取得してから操作してください。",
    409
  );
}
function isUniqueConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const row = error as Record<string, unknown>;
  return (
    [row.code, row.originalCode].some(
      (code) => code === "P2002" || code === "23505"
    ) ||
    [row.cause, row.meta, row.driverAdapterError].some((nested) =>
      isUniqueConflict(nested, depth + 1)
    )
  );
}
