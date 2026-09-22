// Integration example, NOT compiled against the user's generated Prisma client.
// Suggested destination: apps/api/src/modules/reliability/job-claim.ts
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseClient } from '../../db/client.js';

type Kind = 'SYNC' | 'RECONCILE' | 'EVALUATE' | 'RENEW_PROVIDER'
  | 'HEALTH_AUDIT' | 'SYNTHETIC_SEND';

interface ClaimedJob {
  id: string;
  kind: Kind;
  payload: unknown;
  leaseToken: string;
  leaseGeneration: bigint;
  attempts: number;
}

export async function claimOne(db: DatabaseClient, kind: Kind): Promise<ClaimedJob | null> {
  const token = randomUUID();
  const rows = await db.$queryRaw<ClaimedJob[]>(Prisma.sql`
    WITH candidate AS (
      SELECT id FROM reliability_jobs
      WHERE kind = ${kind}::"ReliabilityJobKind"
        AND (
          (status IN ('READY', 'RETRY_WAIT') AND "availableAt" <= now())
          OR (status = 'RUNNING' AND "leaseUntil" < now())
        )
      ORDER BY "availableAt", id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE reliability_jobs j
    SET status = 'RUNNING',
        "leaseToken" = ${token}::uuid,
        "leaseGeneration" = j."leaseGeneration" + 1,
        "leaseUntil" = now() + interval '45 seconds',
        attempts = j.attempts + 1,
        "updatedAt" = now()
    FROM candidate c WHERE j.id = c.id
    RETURNING j.id, j.kind, j.payload, j."leaseToken", j."leaseGeneration", j.attempts
  `);
  return rows[0] ?? null;
}

// Call INSIDE the same transaction that commits results/decisions/outbox.
// All committers lock in a documented consistent order, e.g.
// MonitoringState -> job -> ledger message -> evaluation -> Alert.
export async function lockOwnedJob(tx: Prisma.TransactionClient, job: ClaimedJob): Promise<void> {
  const rows = await tx.$queryRaw<Array<{id: string}>>(Prisma.sql`
    SELECT id FROM reliability_jobs
    WHERE id = ${job.id}::uuid
      AND status = 'RUNNING'
      AND "leaseToken" = ${job.leaseToken}::uuid
      AND "leaseGeneration" = ${job.leaseGeneration}
      AND "leaseUntil" > clock_timestamp()
    FOR UPDATE
  `);
  if (rows.length !== 1) throw new Error('JOB_LEASE_LOST');
}

export async function finishOwnedJob(tx: Prisma.TransactionClient, job: ClaimedJob): Promise<void> {
  // Caller has just acquired the row lock via lockOwnedJob in this transaction.
  const changed = await tx.reliabilityJob.updateMany({
    where: { id: job.id, status: 'RUNNING', leaseToken: job.leaseToken,
      leaseGeneration: job.leaseGeneration },
    data: { status: 'DONE', finishedAt: new Date(), leaseToken: null, leaseUntil: null },
  });
  if (changed.count !== 1) throw new Error('JOB_LEASE_LOST');
}
