import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../../db/client.js";
import { retrySerializableTransaction } from "../../../db/transaction-retry.js";
import type { OutboxTransportInput } from "./outbox-transport.js";

export interface OutboxClaim {
  readonly id: string;
  readonly eventKey: string;
  readonly leaseToken: string;
  readonly leaseGeneration: bigint;
  readonly attempts: number;
}
export type OutboxFailureCode =
  | "FAKE_TRANSIENT"
  | "FAKE_PERMANENT"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_TIMEOUT"
  | "TRANSPORT_RESULT_INVALID"
  | "RETRY_EXHAUSTED"
  | "RECIPIENT_INELIGIBLE";
export type OutboxOutcome =
  | { readonly status: "DISPATCHED" }
  | {
      readonly status: "RETRY_WAIT";
      readonly code: OutboxFailureCode;
      readonly delayMs: number;
    }
  | { readonly status: "BLOCKED"; readonly code: OutboxFailureCode };

export interface OutboxQueue {
  claimOne(leaseMs: number): Promise<OutboxClaim | null>;
  prepare(claim: OutboxClaim): Promise<OutboxTransportInput | null>;
  finish(claim: OutboxClaim, outcome: OutboxOutcome): Promise<boolean>;
}

// Claim is one auto-commit statement; finish is a short lock-then-update TX.
// No transport in DB retry closures. All lease/due-time decisions use DB time.
export class PrismaOutboxQueue implements OutboxQueue {
  public constructor(private readonly database: DatabaseClient) {}

  public async claimOne(leaseMs: number): Promise<OutboxClaim | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000)
      throw new Error("OUTBOX_LEASE_INVALID");
    const token = randomUUID();
    const rows = await retrySerializableTransaction(
      () => this.database.$queryRaw<OutboxClaim[]>`
        WITH candidate AS (
          SELECT id FROM reliability_outbox
          WHERE kind = 'ALERT_AVAILABLE' AND (
            (status IN ('PENDING', 'RETRY_WAIT') AND "availableAt" <= clock_timestamp())
            OR (status = 'RUNNING' AND "leaseUntil" <= clock_timestamp())
          )
          ORDER BY "availableAt", id
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE reliability_outbox o SET status = 'RUNNING',
          "leaseToken" = ${token}::uuid,
          "leaseGeneration" = o."leaseGeneration" + 1,
          "leaseUntil" = clock_timestamp() + (${leaseMs}::double precision * interval '1 millisecond'),
          attempts = o.attempts + 1
        FROM candidate c WHERE o.id = c.id
        RETURNING o.id, o."eventKey", o."leaseToken", o."leaseGeneration", o.attempts
      `,
      () => new Error("OUTBOX_CLAIM_CONFLICT")
    );
    return rows[0] ?? null;
  }

  public async prepare(
    claim: OutboxClaim
  ): Promise<OutboxTransportInput | null> {
    // Only identifiers leave the repository, never Alert text, OAuth or addresses.
    // Current eligibility is rechecked without changing read/dismissed/history state.
    const rows = await this.database.$queryRaw<
      Array<Omit<OutboxTransportInput, "attemptId">>
    >`
      SELECT o.id AS "outboxId", o."eventKey", o."teamId", o."alertId", o."recipientId"
      FROM reliability_outbox o
      JOIN alerts a ON a.id = o."alertId" AND a."teamId" = o."teamId"
      JOIN alert_recipients r ON r.id = o."recipientId" AND r."alertId" = a.id
      JOIN teams t ON t.id = o."teamId" AND t.status = 'ACTIVE'
      JOIN subscriptions s ON s."teamId" = t.id AND s.status = 'ACTIVE'
      WHERE o.id = ${claim.id}::uuid AND o.status = 'RUNNING'
        AND o."leaseToken" = ${claim.leaseToken}::uuid
        AND o."leaseGeneration" = ${claim.leaseGeneration}
        AND o."leaseUntil" > clock_timestamp()
        AND o.kind = 'ALERT_AVAILABLE' AND o.payload = '{"schemaVersion":1}'::jsonb
        AND (
          (r.kind = 'OWNER' AND EXISTS (
            SELECT 1 FROM team_memberships m JOIN users u ON u.id = m."userId"
            WHERE m."teamId" = t.id AND m."userId" = r."userId"
              AND m.role = 'OWNER' AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
          )) OR (r.kind = 'NOTIFICATION_MEMBER' AND EXISTS (
            SELECT 1 FROM notification_members n WHERE n.id = r."notificationMemberId"
              AND n."teamId" = t.id AND n.status = 'ACTIVE' AND n."deletedAt" IS NULL
          ))
        )
    `;
    const row = rows[0];
    return row ? { ...row, attemptId: claim.leaseToken } : null;
  }

  public async finish(
    claim: OutboxClaim,
    outcome: OutboxOutcome
  ): Promise<boolean> {
    const delay = outcome.status === "RETRY_WAIT" ? outcome.delayMs : 0;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 3_600_000)
      throw new Error("OUTBOX_DELAY_INVALID");
    const code = outcome.status === "DISPATCHED" ? null : outcome.code;
    const rows = await retrySerializableTransaction(
      () =>
        this.database.$transaction(async (tx) => {
          // Separate statement: a planner can evaluate WHERE before a CTE row-lock
          // wait. Check expiry only AFTER acquiring the lock, including after retry.
          await tx.$queryRaw`SELECT id FROM reliability_outbox WHERE id = ${claim.id}::uuid FOR UPDATE`;
          return tx.$queryRaw<Array<{ id: string }>>`
        UPDATE reliability_outbox o SET
          status = ${outcome.status}::"ReliabilityOutboxStatus",
          "lastErrorCode" = ${code}, "leaseToken" = NULL, "leaseUntil" = NULL,
          "availableAt" = CASE WHEN ${outcome.status} = 'RETRY_WAIT'
            THEN clock_timestamp() + (${delay}::double precision * interval '1 millisecond')
            ELSE o."availableAt" END,
          "dispatchedAt" = CASE WHEN ${outcome.status} = 'DISPATCHED'
            THEN clock_timestamp() ELSE o."dispatchedAt" END
        WHERE o.id = ${claim.id}::uuid AND o.status = 'RUNNING'
          AND o."leaseToken" = ${claim.leaseToken}::uuid
          AND o."leaseGeneration" = ${claim.leaseGeneration}
          AND o."leaseUntil" > clock_timestamp()
        RETURNING o.id
      `;
        }),
      () => new Error("OUTBOX_FINISH_CONFLICT")
    );
    return rows.length === 1;
  }
}
