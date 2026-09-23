import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../../db/client.js";
import type {
  MailEvaluation,
  MailMessageLedger,
  Prisma
} from "../../../generated/prisma/client.js";
import {
  assertSameIdentity,
  messageKey,
  type MessageIdentity
} from "./message-key.js";

export interface LedgerEntry {
  readonly message: MailMessageLedger;
  readonly evaluation: MailEvaluation;
}

type EvaluationOutcome =
  | { state: "MATCHED"; alertId: string; keyword: string }
  | { state: "NOT_MATCHED" }
  | {
      state: "EXCLUDED";
      code: "OUTSIDE_MONITORING_WINDOW" | "NOT_INCOMING_INBOX";
    }
  | { state: "UNDETERMINED"; code: "MESSAGE_GET_404" };

const pendingStates = ["DISCOVERED", "FETCH_PENDING", "EVALUATING"] as const;
export function isSettled(entry: LedgerEntry): boolean {
  // UNDETERMINED is terminal for automatic retries, NOT a successful decision.
  return !pendingStates.some((state) => state === entry.evaluation.state);
}

export class PrismaMailLedger {
  public constructor(private readonly database: DatabaseClient) {}

  public async discover(
    input: MessageIdentity & {
      readonly connectionId: string;
      readonly keywords: readonly string[];
      readonly now: Date;
    }
  ): Promise<LedgerEntry> {
    const key = messageKey(input);
    const matcherVersion = "existing-matcher-v1";
    const ruleHash = createHash("sha256")
      .update(JSON.stringify([matcherVersion, input.keywords]), "utf8")
      .digest("hex");
    return this.database.$transaction(async (tx) => {
      const connection = await tx.mailConnection.findUniqueOrThrow({
        where: { id: input.connectionId }
      });
      if (
        connection.teamId !== input.teamId.toLowerCase() ||
        connection.provider !== input.provider ||
        connection.mailAuthorizationId !== input.mailboxId.toLowerCase()
      ) {
        throw new Error("LEDGER_CONNECTION_SCOPE_MISMATCH");
      }
      // Uniqueness is decided by PostgreSQL, never by a SELECT-before-INSERT.
      await tx.$executeRaw`
        INSERT INTO mail_message_ledger
          (id, "teamId", provider, "mailboxId", "firstConnectionId", "providerMessageId", "messageKey", "firstSeenAt", "lastSeenAt")
        VALUES (${randomUUID()}::uuid, ${connection.teamId}::uuid, ${input.provider}::"MailProvider",
          ${connection.mailAuthorizationId}::uuid, ${connection.id}::uuid, ${input.providerMessageId}, ${key}, ${input.now}, ${input.now})
        ON CONFLICT ("messageKey") DO NOTHING
      `;
      const message = await tx.mailMessageLedger.findUniqueOrThrow({
        where: { messageKey: key }
      });
      assertSameIdentity(message, input);
      const first = await tx.mailConnection.findUniqueOrThrow({
        where: { id: message.firstConnectionId }
      });
      if (
        first.teamId !== message.teamId ||
        first.provider !== message.provider ||
        first.mailAuthorizationId !== message.mailboxId ||
        first.id !== connection.id
      ) {
        throw new Error("LEDGER_FIRST_CONNECTION_SCOPE_MISMATCH");
      }
      await tx.$executeRaw`
        UPDATE mail_message_ledger SET "lastSeenAt" = GREATEST("lastSeenAt", ${input.now}) WHERE id = ${message.id}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO mail_evaluations
          (id, "messageId", "connectionId", lane, "keywordsSnapshot", "ruleHash", "matcherVersion", "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${message.id}::uuid, ${connection.id}::uuid, 'LEGACY',
          ${[...input.keywords]}::text[], ${ruleHash}, ${matcherVersion}, ${input.now}, ${input.now})
        ON CONFLICT ("messageId", lane) DO NOTHING
      `;
      const evaluation = await tx.mailEvaluation.findUniqueOrThrow({
        where: { messageId_lane: { messageId: message.id, lane: "LEGACY" } }
      });
      if (evaluation.connectionId !== connection.id)
        throw new Error("LEDGER_EVALUATION_SCOPE_MISMATCH");
      return { message, evaluation };
    });
  }

  public async markFetching(entry: LedgerEntry): Promise<void> {
    await this.database.mailEvaluation.updateMany({
      where: { id: entry.evaluation.id, state: "DISCOVERED" },
      data: { state: "FETCH_PENDING", revision: { increment: 1 } }
    });
  }

  public async markEvaluating(
    entry: LedgerEntry,
    internalDate: string | null
  ): Promise<void> {
    const value =
      internalDate && /^\d{1,16}$/u.test(internalDate)
        ? Number(internalDate)
        : NaN;
    const receivedAt = new Date(value);
    await this.database.$transaction(async (tx) => {
      if (Number.isFinite(receivedAt.getTime())) {
        await tx.mailMessageLedger.updateMany({
          where: { id: entry.message.id, receivedAt: null },
          data: { receivedAt }
        });
      }
      await tx.mailEvaluation.updateMany({
        where: {
          id: entry.evaluation.id,
          state: { in: ["DISCOVERED", "FETCH_PENDING"] }
        },
        data: { state: "EVALUATING", revision: { increment: 1 } }
      });
    });
  }

  public async existingAlert(
    entry: LedgerEntry
  ): Promise<{ id: string; matchedKeyword: string } | null> {
    // Repair the PR01 commit window BEFORE refetching: the message may now be gone
    // or have different labels. Never recreate recipients or reset their state.
    return this.database.alert.findUnique({
      where: {
        sourceMailConnectionId_sourceEventId: {
          sourceMailConnectionId: entry.evaluation.connectionId,
          sourceEventId: entry.message.providerMessageId
        }
      },
      select: { id: true, matchedKeyword: true }
    });
  }

  public async finish(
    entry: LedgerEntry,
    outcome: EvaluationOutcome,
    now: Date
  ): Promise<void> {
    await this.database.$transaction((tx) =>
      this.finishWithinTransaction(tx, entry, outcome, now)
    );
  }

  public async finishWithinTransaction(
    tx: Prisma.TransactionClient,
    entry: LedgerEntry,
    outcome: EvaluationOutcome,
    now: Date
  ): Promise<void> {
    // Serialize decisions for this message. No provider I/O in this transaction.
    await tx.$queryRaw`SELECT id FROM mail_message_ledger WHERE id = ${entry.message.id}::uuid FOR UPDATE`;
    const current = await tx.mailEvaluation.findUniqueOrThrow({
      where: { id: entry.evaluation.id }
    });
    if (
      isSettled({ message: entry.message, evaluation: current }) &&
      (outcome.state !== "MATCHED" || current.state === "MATCHED")
    ) {
      const linked = await tx.mailMessageLedger.findUniqueOrThrow({
        where: { id: entry.message.id }
      });
      if (outcome.state === "MATCHED" && linked.alertId !== outcome.alertId) {
        throw new Error("LEDGER_CONCURRENT_DECISION_CONFLICT");
      }
      return;
    }
    if (outcome.state === "MATCHED") {
      const alert = await tx.alert.findUniqueOrThrow({
        where: { id: outcome.alertId }
      });
      if (
        alert.teamId !== entry.message.teamId ||
        alert.sourceMailConnectionId !== current.connectionId ||
        alert.sourceEventId !== entry.message.providerMessageId ||
        alert.kind !== "REAL" ||
        alert.matchedKeyword !== outcome.keyword
      )
        throw new Error("LEDGER_ALERT_SCOPE_MISMATCH");
      await tx.mailMessageLedger.update({
        where: { id: entry.message.id },
        data: { alertId: alert.id }
      });
    } else {
      // A concurrent successful ingest wins over a late 404 or exclusion.
      const alert = await tx.alert.findUnique({
        where: {
          sourceMailConnectionId_sourceEventId: {
            sourceMailConnectionId: current.connectionId,
            sourceEventId: entry.message.providerMessageId
          }
        }
      });
      if (alert) throw new Error("LEDGER_ALERT_REQUIRES_LINK");
    }
    await tx.mailEvaluation.update({
      where: { id: current.id },
      data: {
        state: outcome.state,
        matchedKeyword: outcome.state === "MATCHED" ? outcome.keyword : null,
        exclusionCode: outcome.state === "EXCLUDED" ? outcome.code : null,
        lastErrorCode: outcome.state === "UNDETERMINED" ? outcome.code : null,
        unresolvedSince: outcome.state === "UNDETERMINED" ? now : null,
        decisionAt: outcome.state === "UNDETERMINED" ? null : now,
        revision: { increment: 1 }
      }
    });
  }

  public async pendingFailure(entry: LedgerEntry, now: Date): Promise<void> {
    await this.database.mailEvaluation.updateMany({
      where: { id: entry.evaluation.id, state: { in: [...pendingStates] } },
      data: {
        lastErrorCode: "LEGACY_PROCESSING_FAILED",
        unresolvedSince: now,
        revision: { increment: 1 }
      }
    });
  }
}
