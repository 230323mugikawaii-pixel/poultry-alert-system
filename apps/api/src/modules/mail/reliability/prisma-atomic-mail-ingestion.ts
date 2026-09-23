import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../../db/client.js";
import { retrySerializableTransaction } from "../../../db/transaction-retry.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../../lib/app-error.js";
import type {
  AlertIngestionResult,
  AlertRepository
} from "../../alerts/alert-repository.js";
import { PrismaAlertRepository } from "../../alerts/prisma-alert-repository.js";
import { assertSameIdentity, messageKey } from "./message-key.js";
import type { PrismaMailLedger, LedgerEntry } from "./prisma-mail-ledger.js";

export function alertOutboxKey(key: string, recipientId: string): string {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      recipientId
    )
  ) {
    throw new Error("OUTBOX_IDENTITY_INVALID");
  }
  return createHash("sha256")
    .update(
      JSON.stringify(["alert-available-v1", key, recipientId.toLowerCase()]),
      "utf8"
    )
    .digest("hex");
}

// Record-only: never dispatches, calls providers or emits SSE inside the TX.
export class PrismaAtomicMailIngestion {
  private readonly alerts: PrismaAlertRepository;
  public constructor(
    private readonly database: DatabaseClient,
    private readonly ledger: PrismaMailLedger
  ) {
    this.alerts = new PrismaAlertRepository(database);
  }

  public ingestMatched(
    entry: LedgerEntry,
    input: Parameters<AlertRepository["ingest"]>[0]
  ): Promise<AlertIngestionResult> {
    return retrySerializableTransaction(
      () =>
        this.database.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM mail_message_ledger WHERE id = ${entry.message.id}::uuid FOR UPDATE`;
            const message = await tx.mailMessageLedger.findUniqueOrThrow({
              where: { id: entry.message.id }
            });
            const evaluation = await tx.mailEvaluation.findUniqueOrThrow({
              where: {
                messageId_lane: { messageId: message.id, lane: "LEGACY" }
              }
            });
            assertSameIdentity(message, entry.message);
            const connection = await tx.mailConnection.findUniqueOrThrow({
              where: { id: input.sourceMailConnectionId }
            });
            if (
              message.messageKey !== messageKey(message) ||
              message.messageKey !== entry.message.messageKey ||
              evaluation.id !== entry.evaluation.id ||
              input.kind !== "REAL" ||
              message.provider !== "GOOGLE" ||
              input.teamId !== message.teamId ||
              input.sourceEventId !== message.providerMessageId ||
              connection.id !== message.firstConnectionId ||
              connection.id !== evaluation.connectionId ||
              connection.teamId !== message.teamId ||
              connection.provider !== message.provider ||
              connection.mailAuthorizationId !== message.mailboxId
            ) {
              throw new Error("ATOMIC_MAIL_SCOPE_MISMATCH");
            }
            // Reuses PR02a eligibility locks, existing raw Gmail ID, fan-out and audit.
            const result = await this.alerts.ingestWithinTransaction(tx, input);
            await this.ledger.finishWithinTransaction(
              tx,
              { message, evaluation },
              {
                state: "MATCHED",
                alertId: result.alert.id,
                keyword: result.alert.matchedKeyword
              },
              input.now
            );
            // Preserve the Alert's original recipients. No refan-out on retry/repair.
            const recipients = await tx.alertRecipient.findMany({
              where: { alertId: result.alert.id },
              select: { id: true }
            });
            for (const recipient of recipients) {
              const key = alertOutboxKey(message.messageKey, recipient.id);
              await tx.$executeRaw`
            INSERT INTO reliability_outbox
              (id, "eventKey", kind, "teamId", "alertId", "recipientId", payload)
            VALUES (${randomUUID()}::uuid, ${key}, 'ALERT_AVAILABLE',
              ${message.teamId}::uuid, ${result.alert.id}::uuid, ${recipient.id}::uuid,
              '{"schemaVersion":1}'::jsonb)
            ON CONFLICT ("eventKey") DO NOTHING
          `;
              const stored = await tx.reliabilityOutbox.findUniqueOrThrow({
                where: { eventKey: key }
              });
              if (
                stored.teamId !== message.teamId ||
                stored.alertId !== result.alert.id ||
                stored.recipientId !== recipient.id ||
                stored.kind !== "ALERT_AVAILABLE"
              ) {
                throw new Error("OUTBOX_KEY_COLLISION_OR_SCOPE_MISMATCH");
              }
            }
            return result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
      () =>
        new AppError(
          "ALERT_INGESTION_CONFLICT",
          "検知イベントの登録が競合しました。もう一度お試しください。",
          409
        )
    );
  }
}
