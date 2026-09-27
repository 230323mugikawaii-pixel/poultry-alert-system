import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { retrySerializableTransaction } from "../../db/transaction-retry.js";
import { Prisma } from "../../generated/prisma/client.js";
import {
  pushIdempotencyKey,
  type PushTransportInput
} from "./push-transport.js";

export interface PushDeliveryClaim {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseGeneration: bigint;
  readonly attemptCount: number;
}
export type PushFailureCode =
  | "HTTP_429"
  | "HTTP_5XX"
  | "FAKE_TRANSIENT"
  | "FAKE_PERMANENT"
  | "HTTP_410"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_TIMEOUT"
  | "TRANSPORT_RESULT_INVALID"
  | "RETRY_EXHAUSTED"
  | "TARGET_OR_RECIPIENT_INELIGIBLE";
export type ApnsFailureCode =
  | "APNS_CONFIG"
  | "APNS_CONNECTION"
  | "APNS_TOKEN_REFRESH"
  | "APNS_BAD_DEVICE_TOKEN"
  | "APNS_TOKEN_NOT_FOR_TOPIC"
  | "APNS_TARGET_STALE"
  | "APNS_FORBIDDEN"
  | "APNS_PAYLOAD_TOO_LARGE";
export type PushDeliveryOutcome =
  | { readonly state: "PROVIDER_ACCEPTED"; readonly providerRequestId: string }
  | {
      readonly state: "RETRY_WAIT";
      readonly code: PushFailureCode | ApnsFailureCode;
      readonly delayMs: number;
    }
  | {
      readonly state: "PERMANENT_FAILURE" | "CANCELLED";
      readonly code: PushFailureCode | ApnsFailureCode;
    };
export interface PushDeliveryQueue {
  claimOne(leaseMs: number): Promise<PushDeliveryClaim | null>;
  prepare(
    claim: PushDeliveryClaim,
    mode?: "fake" | "apns"
  ): Promise<PushTransportInput | null>;
  finish(
    claim: PushDeliveryClaim,
    outcome: PushDeliveryOutcome
  ): Promise<boolean>;
}
export const maximumPushRetryDelayMs = 7 * 24 * 3600_000;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const validProviderRequestId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);

export class PrismaPushDeliveryQueue implements PushDeliveryQueue {
  public constructor(private readonly database: DatabaseClient) {}

  public async claimOne(leaseMs: number): Promise<PushDeliveryClaim | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000)
      throw new Error("PUSH_LEASE_INVALID");
    return safeDatabase(async () => {
      const rows = await retrySerializableTransaction(
        () => this.database.$queryRaw<PushDeliveryClaim[]>`
        WITH candidate AS (
          SELECT d.id FROM notification_deliveries d
          WHERE ((d.state IN ('PENDING','RETRY_WAIT') AND d."nextAttemptAt"<=clock_timestamp())
            OR (d.state='IN_FLIGHT' AND d."leaseUntil"<=clock_timestamp()))
            AND EXISTS (SELECT 1 FROM reliability_outbox o WHERE o.id=d."outboxId" AND o.status='DISPATCHED')
          ORDER BY d."nextAttemptAt", d.id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE notification_deliveries d SET state='IN_FLIGHT', "attemptCount"=d."attemptCount"+1,
          "leaseToken"=${randomUUID()}::uuid, "leaseGeneration"=d."leaseGeneration"+1,
          "leaseUntil"=clock_timestamp()+(${leaseMs}::double precision * interval '1 millisecond')
        FROM candidate c WHERE d.id=c.id
        RETURNING d.id,d."leaseToken",d."leaseGeneration",d."attemptCount"`,
        () => new Error("PUSH_CLAIM_CONFLICT")
      );
      return rows[0] ?? null;
    });
  }

  public async prepare(
    claim: PushDeliveryClaim,
    mode: "fake" | "apns" = "fake"
  ): Promise<PushTransportInput | null> {
    return safeDatabase(async () => {
      // Only APNs fetches version-bound ciphertext, in the SAME eligibility SELECT.
      // A rotation AFTER this check can race with external I/O; fence the result/version, never roll back a newer registration.
      const rows = await this.database.$queryRaw<
        {
          id: string;
          outboxId: string;
          alertId: string;
          recipientId: string;
          targetKey: string;
          targetVersion: number;
          encryptedToken?: string;
        }[]
      >`
        SELECT d.id,d."outboxId",o."alertId",o."recipientId",d."targetKey",d."targetVersion"
          ${mode === "apns" ? Prisma.sql`,p."encryptedToken"` : Prisma.empty}
        FROM notification_deliveries d
        JOIN reliability_outbox o ON o.id=d."outboxId" AND o.status='DISPATCHED'
        JOIN alerts a ON a.id=o."alertId" AND a."teamId"=o."teamId"
        JOIN alert_recipients r ON r.id=o."recipientId" AND r."alertId"=a.id
        JOIN teams t ON t.id=o."teamId" AND t.status='ACTIVE'
        JOIN subscriptions s ON s."teamId"=t.id AND s.status='ACTIVE'
        JOIN device_push_registrations p ON p."targetKey"=d."targetKey" AND p."teamId"=t.id
          AND p.platform='APNS' AND p.status='ACTIVE' AND p."tokenVersion"=d."targetVersion"
        WHERE d.id=${claim.id}::uuid AND d.state='IN_FLIGHT'
          AND d."leaseToken"=${claim.leaseToken}::uuid AND d."leaseGeneration"=${claim.leaseGeneration}
          AND d."leaseUntil">clock_timestamp() AND o.kind='ALERT_AVAILABLE' AND o.payload='{"schemaVersion":1}'::jsonb
          AND ((r.kind='OWNER' AND p."principalKind"='OWNER' AND p."principalId"=r."userId" AND EXISTS (
            SELECT 1 FROM users u JOIN team_memberships m ON m."userId"=u.id
            WHERE u.id=r."userId" AND u.status='ACTIVE' AND u."deletedAt" IS NULL
              AND m."teamId"=t.id AND m.role='OWNER' AND m.status='ACTIVE'
          )) OR (r.kind='NOTIFICATION_MEMBER' AND p."principalKind"='MEMBER' AND p."principalId"=r."notificationMemberId" AND EXISTS (
            SELECT 1 FROM notification_members n WHERE n.id=r."notificationMemberId" AND n."teamId"=t.id
              AND n.status='ACTIVE' AND n."deletedAt" IS NULL
          )))`;
      const row = rows[0];
      return row
        ? {
            deliveryId: row.id,
            idempotencyKey: pushIdempotencyKey(
              row.outboxId,
              row.targetKey,
              row.targetVersion
            ),
            alertId: row.alertId,
            recipientId: row.recipientId,
            endpointKey: row.targetKey,
            endpointVersion: row.targetVersion,
            attemptId: claim.leaseToken,
            ...(mode === "apns"
              ? {
                  encryptedToken: row.encryptedToken,
                  confirmCurrent: async () =>
                    Boolean(await this.prepare(claim, "fake"))
                }
              : {})
          }
        : null;
    });
  }

  public async finish(
    claim: PushDeliveryClaim,
    outcome: PushDeliveryOutcome
  ): Promise<boolean> {
    const delay = outcome.state === "RETRY_WAIT" ? outcome.delayMs : 0;
    if (
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      delay > maximumPushRetryDelayMs ||
      (outcome.state === "PROVIDER_ACCEPTED" &&
        !validProviderRequestId(outcome.providerRequestId))
    )
      throw new Error("PUSH_OUTCOME_INVALID");
    const code = outcome.state === "PROVIDER_ACCEPTED" ? null : outcome.code;
    const requestId =
      outcome.state === "PROVIDER_ACCEPTED" ? outcome.providerRequestId : null;
    return safeDatabase(() =>
      retrySerializableTransaction(
        () =>
          this.database.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM notification_deliveries WHERE id=${claim.id}::uuid FOR UPDATE`;
            const owned = await tx.$queryRaw<
              { targetKey: string; targetVersion: number }[]
            >`
        SELECT "targetKey","targetVersion" FROM notification_deliveries WHERE id=${claim.id}::uuid
          AND state='IN_FLIGHT' AND "leaseToken"=${claim.leaseToken}::uuid AND "leaseGeneration"=${claim.leaseGeneration}
          AND "leaseUntil">clock_timestamp()`;
            if (!owned[0]) return false;
            const unregister =
              outcome.state === "PERMANENT_FAILURE" && code === "HTTP_410";
            if (unregister)
              await tx.$queryRaw`SELECT "targetKey" FROM device_push_registrations WHERE "targetKey"=${owned[0].targetKey}::uuid FOR UPDATE`;
            // Re-evaluate clock AFTER all lock waits, before any writes (including 410 revocation).
            const finished = await tx.$queryRaw<{ id: string }[]>`
        UPDATE notification_deliveries SET state=${outcome.state}::"NotificationDeliveryState",
          "leaseToken"=NULL,"leaseUntil"=NULL,"lastErrorCode"=${code},
          "nextAttemptAt"=CASE WHEN ${outcome.state}='RETRY_WAIT'
            THEN clock_timestamp()+(${delay}::double precision * interval '1 millisecond') ELSE "nextAttemptAt" END,
          "apnsRequestId"=${requestId}::uuid,
          "acceptedAt"=CASE WHEN ${outcome.state}='PROVIDER_ACCEPTED' THEN clock_timestamp() ELSE NULL END
        WHERE id=${claim.id}::uuid AND state='IN_FLIGHT' AND "leaseToken"=${claim.leaseToken}::uuid
          AND "leaseGeneration"=${claim.leaseGeneration} AND "leaseUntil">clock_timestamp() RETURNING id`;
            if (finished.length !== 1) return false;
            if (unregister)
              await tx.$executeRaw`
        UPDATE device_push_registrations SET status='REVOKED',"encryptedToken"=NULL,"tokenHash"=NULL,"tokenVersion"="tokenVersion"+1
        WHERE "targetKey"=${owned[0].targetKey}::uuid AND "tokenVersion"=${owned[0].targetVersion} AND status='ACTIVE'`;
            return true;
          }),
        () => new Error("PUSH_FINISH_CONFLICT")
      )
    );
  }
}

async function safeDatabase<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new Error("PUSH_DELIVERY_DATABASE_ERROR");
  }
}
