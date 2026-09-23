import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../../db/client.js";
import { retrySerializableTransaction } from "../../../db/transaction-retry.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { GmailPubSubNotification } from "../gmail/gmail-pubsub-envelope.js";

export interface GmailJobIntake {
  accept(input: GmailPubSubNotification): Promise<void>;
}
export interface GmailJobTarget {
  connectionId: string;
  mailboxId: string;
  teamId: string;
}
export interface GmailJobPayload {
  schemaVersion: 1;
  historyId: string;
  eventFingerprint: string;
  targets: GmailJobTarget[];
}
export interface GmailJobClaim {
  id: string;
  leaseToken: string;
  leaseGeneration: bigint;
  attempts: number;
  payload: unknown;
}
export type GmailJobFailure =
  | "GMAIL_JOB_RETRY"
  | "GMAIL_JOB_TARGET_UNAVAILABLE"
  | "GMAIL_JOB_PROGRESS_UNCONFIRMED"
  | "GMAIL_JOB_PAYLOAD_INVALID"
  | "GMAIL_JOB_RETRY_EXHAUSTED";
const hash = (parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
export function gmailJobKey(topic: string, notificationId: string): string {
  return hash(["gmail-push-job-v1", topic, notificationId]);
}

export function parseGmailJobPayload(value: unknown): GmailJobPayload {
  const p = value as Partial<GmailJobPayload> | null;
  const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !p ||
    typeof p !== "object" ||
    Object.keys(p).sort().join() !==
      "eventFingerprint,historyId,schemaVersion,targets" ||
    p.schemaVersion !== 1 ||
    typeof p.historyId !== "string" ||
    !/^\d{1,64}$/.test(p.historyId) ||
    typeof p.eventFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.eventFingerprint) ||
    !Array.isArray(p.targets) ||
    p.targets.length > 500 ||
    p.targets.some(
      (t) =>
        !t ||
        typeof t !== "object" ||
        Object.keys(t).sort().join() !== "connectionId,mailboxId,teamId" ||
        ![t.connectionId, t.mailboxId, t.teamId].every(
          (id) => typeof id === "string" && uuid.test(id)
        )
    )
  )
    throw new Error("GMAIL_JOB_PAYLOAD_INVALID");
  return p as GmailJobPayload;
}

export class PrismaGmailJobQueue implements GmailJobIntake {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly topic: string
  ) {
    if (
      !/^projects\/[a-z][a-z0-9-]+\/topics\/[A-Za-z][A-Za-z0-9._~+%-]+$/.test(
        topic
      )
    )
      throw new Error("GMAIL_JOB_TOPIC_INVALID");
  }

  public async accept(input: GmailPubSubNotification): Promise<void> {
    const dedupeKey = gmailJobKey(this.topic, input.messageId);
    const eventFingerprint = hash([
      input.emailAddress,
      input.historyId,
      input.publishTime.toISOString()
    ]);
    await retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (tx) => {
            // Freeze known connection identifiers at first intake. No future connection is
            // silently added on redelivery; email is only used for this trusted DB lookup.
            const connections = await tx.mailConnection.findMany({
              where: {
                provider: "GOOGLE",
                mailAuthorization: {
                  provider: "GOOGLE",
                  email: input.emailAddress
                }
              },
              select: { id: true, mailAuthorizationId: true, teamId: true },
              orderBy: { id: "asc" },
              take: 501
            });
            if (connections.length > 500)
              throw new Error("GMAIL_JOB_TOO_MANY_TARGETS");
            const payload: GmailJobPayload = {
              schemaVersion: 1,
              historyId: input.historyId,
              eventFingerprint,
              targets: connections.map((c) => ({
                connectionId: c.id,
                mailboxId: c.mailAuthorizationId,
                teamId: c.teamId
              }))
            };
            parseGmailJobPayload(payload);
            await tx.$executeRaw`
        INSERT INTO reliability_jobs (id, kind, "dedupeKey", payload, "updatedAt")
        VALUES (${randomUUID()}::uuid, 'SYNC', ${dedupeKey}, ${JSON.stringify(payload)}::jsonb, clock_timestamp())
        ON CONFLICT ("dedupeKey") DO NOTHING
      `;
            const stored = await tx.reliabilityJob.findUniqueOrThrow({
              where: { dedupeKey }
            });
            if (
              stored.kind !== "SYNC" ||
              parseGmailJobPayload(stored.payload).eventFingerprint !==
                eventFingerprint
            )
              throw new Error("GMAIL_JOB_IDENTITY_COLLISION");
            // No terminal-state reset, no API call, no wake-before-commit, no logging payload.
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () => new Error("GMAIL_JOB_ACCEPT_CONFLICT")
    );
  }

  public async claimOne(leaseMs = 120_000): Promise<GmailJobClaim | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000)
      throw new Error("GMAIL_JOB_LEASE_INVALID");
    const rows = await this.database.$queryRaw<GmailJobClaim[]>`
      WITH candidate AS (
        SELECT id FROM reliability_jobs WHERE kind='SYNC' AND (
          (status IN ('READY','RETRY_WAIT') AND "availableAt" <= clock_timestamp())
          OR (status='RUNNING' AND "leaseUntil" <= clock_timestamp())
        ) ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE reliability_jobs j SET status='RUNNING', "leaseToken"=${randomUUID()}::uuid,
        "leaseGeneration"=j."leaseGeneration"+1, attempts=j.attempts+1,
        "leaseUntil"=clock_timestamp()+(${leaseMs}::double precision * interval '1 millisecond'), "updatedAt"=clock_timestamp()
      FROM candidate c WHERE j.id=c.id
      RETURNING j.id, j."leaseToken", j."leaseGeneration", j.attempts, j.payload
    `;
    return rows[0] ?? null;
  }

  public async owns(claim: GmailJobClaim): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM reliability_jobs WHERE id=${claim.id}::uuid AND status='RUNNING'
        AND "leaseToken"=${claim.leaseToken}::uuid AND "leaseGeneration"=${claim.leaseGeneration}
        AND "leaseUntil">clock_timestamp()
    `;
    return rows.length === 1;
  }

  public async targetState(
    target: GmailJobTarget,
    historyId: string
  ): Promise<"READY" | "COMPLETE" | "UNAVAILABLE"> {
    const c = await this.database.mailConnection.findFirst({
      where: {
        id: target.connectionId,
        teamId: target.teamId,
        mailAuthorizationId: target.mailboxId,
        provider: "GOOGLE",
        status: "ACTIVE",
        team: { status: "ACTIVE", subscription: { is: { status: "ACTIVE" } } },
        mailAuthorization: {
          provider: "GOOGLE",
          status: "ACTIVE",
          encryptedRefreshToken: { not: null },
          encryptionProvider: { not: null },
          encryptionKeyVersion: { not: null }
        }
      },
      select: { providerCursor: true }
    });
    if (!c) return "UNAVAILABLE";
    return c.providerCursor &&
      /^\d+$/.test(c.providerCursor) &&
      BigInt(c.providerCursor) >= BigInt(historyId)
      ? "COMPLETE"
      : "READY";
  }

  public async finish(
    claim: GmailJobClaim,
    failure?: GmailJobFailure
  ): Promise<boolean> {
    const blocked =
      failure === "GMAIL_JOB_PAYLOAD_INVALID" ||
      (!!failure && claim.attempts >= 10);
    const status = !failure ? "DONE" : blocked ? "BLOCKED" : "RETRY_WAIT";
    const code =
      blocked && failure !== "GMAIL_JOB_PAYLOAD_INVALID"
        ? "GMAIL_JOB_RETRY_EXHAUSTED"
        : (failure ?? null);
    const delayMs = Math.min(
      1000 * 2 ** Math.min(Math.max(0, claim.attempts - 1), 12),
      300_000
    );
    const rows = await retrySerializableTransaction(
      () =>
        this.database.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM reliability_jobs WHERE id=${claim.id}::uuid FOR UPDATE`;
          return tx.$queryRaw<Array<{ id: string }>>`
        UPDATE reliability_jobs SET status=${status}::"ReliabilityJobStatus", "lastErrorCode"=${code},
          "leaseToken"=NULL, "leaseUntil"=NULL, "updatedAt"=clock_timestamp(),
          "finishedAt"=CASE WHEN ${status}='DONE' THEN clock_timestamp() ELSE NULL END,
          "availableAt"=CASE WHEN ${status}='RETRY_WAIT' THEN clock_timestamp()+(${delayMs}::double precision * interval '1 millisecond') ELSE "availableAt" END
        WHERE id=${claim.id}::uuid AND status='RUNNING' AND "leaseToken"=${claim.leaseToken}::uuid
          AND "leaseGeneration"=${claim.leaseGeneration} AND "leaseUntil">clock_timestamp()
        RETURNING id
      `;
        }),
      () => new Error("GMAIL_JOB_FINISH_CONFLICT")
    );
    return rows.length === 1;
  }
}
