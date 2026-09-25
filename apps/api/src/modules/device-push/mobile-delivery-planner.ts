import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { OutboxClaim } from "../mail/reliability/prisma-outbox-queue.js";

export function mobilePushDeliveryMode(
  value: string | undefined
): "off" | "shadow" | "apns" {
  if (value === undefined || value === "off") return "off";
  if (value === "shadow") return "shadow";
  if (value === "apns") return "apns";
  throw new Error("MOBILE_PUSH_DELIVERY_MODE_INVALID");
}

export type MobilePlanResult =
  "DISPATCHED" | "BLOCKED" | "LEASE_LOST" | "STOPPED";
export interface MobileDeliveryPlanner {
  plan(claim: OutboxClaim, signal: AbortSignal): Promise<MobilePlanResult>;
}

// Only a trusted, synchronous configuration snapshot; never a network callback.
// PR07b CLI validates only the Fake configuration; real APNs validation is deferred.
export type MobileConfiguration = "missing" | "validated";
class LostLease extends Error {}
class Stopped extends Error {}
type Eligible = {
  teamId: string;
  kind: "OWNER" | "NOTIFICATION_MEMBER";
  userId: string | null;
  notificationMemberId: string | null;
};

export class PrismaMobileDeliveryPlanner implements MobileDeliveryPlanner {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly configuration: MobileConfiguration = "missing"
  ) {
    if (!["missing", "validated"].includes(configuration))
      throw new Error("MOBILE_CONFIGURATION_INVALID");
  }

  public async plan(
    claim: OutboxClaim,
    signal: AbortSignal
  ): Promise<MobilePlanResult> {
    try {
      return await retrySerializableTransaction(
        () =>
          this.database.$transaction(
            async (tx) => {
              if (signal.aborted) throw new Stopped();
              // Lock first, then check DB clock. A claim may expire while waiting for any lock below.
              await tx.$queryRaw`SELECT id FROM reliability_outbox WHERE id=${claim.id}::uuid FOR UPDATE`;
              const owns = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM reliability_outbox WHERE id=${claim.id}::uuid AND status='RUNNING'
            AND "leaseToken"=${claim.leaseToken}::uuid AND "leaseGeneration"=${claim.leaseGeneration}
            AND "leaseUntil">clock_timestamp()
            AND kind='ALERT_AVAILABLE' AND payload='{"schemaVersion":1}'::jsonb`;
              if (!owns.length) throw new LostLease();
              const rows = await tx.$queryRaw<Eligible[]>`
          SELECT o."teamId", r.kind, r."userId", r."notificationMemberId"
          FROM reliability_outbox o
          JOIN alerts a ON a.id=o."alertId" AND a."teamId"=o."teamId"
          JOIN alert_recipients r ON r.id=o."recipientId" AND r."alertId"=a.id
          JOIN teams t ON t.id=o."teamId" AND t.status='ACTIVE'
          JOIN subscriptions s ON s."teamId"=t.id AND s.status='ACTIVE'
          WHERE o.id=${claim.id}::uuid
          FOR SHARE OF a,r,t,s`;
              const recipient = rows[0];
              if (!recipient || !(await this.livePrincipal(tx, recipient))) {
                return this.finish(
                  tx,
                  claim,
                  "BLOCKED",
                  "RECIPIENT_INELIGIBLE",
                  signal
                );
              }
              const principalKind =
                recipient.kind === "OWNER" ? "OWNER" : "MEMBER";
              const principalId =
                recipient.kind === "OWNER"
                  ? recipient.userId
                  : recipient.notificationMemberId;
              // No ciphertext, token hash, address or OAuth information is fetched.
              // Hold target locks so rotation/revocation cannot change the captured version before commit.
              const targets = await tx.$queryRaw<
                { targetKey: string; tokenVersion: number }[]
              >`
          SELECT "targetKey", "tokenVersion" FROM device_push_registrations
          WHERE "teamId"=${recipient.teamId}::uuid AND "principalKind"=${principalKind}::"PushPrincipalKind"
            AND "principalId"=${principalId}::uuid AND platform='APNS' AND status='ACTIVE'
          ORDER BY "targetKey" FOR SHARE`;
              if (!targets.length)
                return this.finish(
                  tx,
                  claim,
                  "BLOCKED",
                  "MOBILE_NO_ACTIVE_TARGET",
                  signal
                );
              // Rechecked in this transaction. Missing configuration is durable waiting, NOT accepted.
              const state =
                this.configuration === "validated"
                  ? "PENDING"
                  : "WAITING_CONFIGURATION";
              const code =
                state === "WAITING_CONFIGURATION"
                  ? "MOBILE_CONFIGURATION_MISSING"
                  : null;
              for (const target of targets) {
                await tx.$executeRaw`
            INSERT INTO notification_deliveries
              (id, "outboxId", "targetKey", "targetVersion", state, "lastErrorCode")
            VALUES (${randomUUID()}::uuid, ${claim.id}::uuid, ${target.targetKey}::uuid,
              ${target.tokenVersion}, ${state}::"NotificationDeliveryState", ${code})
            ON CONFLICT ("outboxId", "targetKey", "targetVersion") DO NOTHING`;
              }
              // DISPATCHED means intent expansion only, never APNs or device acceptance.
              // In PR07a's unconfigured runtime, waiting rows and a BLOCKED parent are committed together.
              return this.finish(
                tx,
                claim,
                code ? "BLOCKED" : "DISPATCHED",
                code,
                signal
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          ),
        () => new Error("MOBILE_INTENT_CONFLICT")
      );
    } catch (error) {
      if (error instanceof LostLease) return "LEASE_LOST";
      if (error instanceof Stopped) return "STOPPED";
      // No raw query/parameters, connection details or adapter exceptions escape.
    }
    throw new Error("MOBILE_INTENT_DATABASE_ERROR");
  }

  private async livePrincipal(
    tx: Prisma.TransactionClient,
    r: Eligible
  ): Promise<boolean> {
    if (r.kind === "OWNER" && r.userId && !r.notificationMemberId) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT u.id FROM users u JOIN team_memberships m ON m."userId"=u.id
        WHERE u.id=${r.userId}::uuid AND u.status='ACTIVE' AND u."deletedAt" IS NULL
          AND m."teamId"=${r.teamId}::uuid AND m.role='OWNER' AND m.status='ACTIVE'
        FOR SHARE OF u,m`;
      return rows.length === 1;
    }
    if (
      r.kind === "NOTIFICATION_MEMBER" &&
      r.notificationMemberId &&
      !r.userId
    ) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM notification_members WHERE id=${r.notificationMemberId}::uuid
          AND "teamId"=${r.teamId}::uuid AND status='ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      return rows.length === 1;
    }
    return false;
  }

  private async finish(
    tx: Prisma.TransactionClient,
    claim: OutboxClaim,
    status: "BLOCKED" | "DISPATCHED",
    code: string | null,
    signal: AbortSignal
  ): Promise<MobilePlanResult> {
    if (signal.aborted) throw new Stopped();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE reliability_outbox SET status=${status}::"ReliabilityOutboxStatus",
        "lastErrorCode"=${code}, "leaseToken"=NULL, "leaseUntil"=NULL,
        "dispatchedAt"=CASE WHEN ${status}='DISPATCHED' THEN clock_timestamp() ELSE "dispatchedAt" END
      WHERE id=${claim.id}::uuid AND status='RUNNING' AND "leaseToken"=${claim.leaseToken}::uuid
        AND "leaseGeneration"=${claim.leaseGeneration} AND "leaseUntil">clock_timestamp()
      RETURNING id`;
    // Throw rather than returning false: rollback every insert if the lease expired during work.
    if (rows.length !== 1) throw new LostLease();
    if (signal.aborted) throw new Stopped();
    return status;
  }
}
