import type { DatabaseClient } from "../../../db/client.js";
import { PrismaAtomicMailIngestion } from "./prisma-atomic-mail-ingestion.js";
import { PrismaMailLedger } from "./prisma-mail-ledger.js";

export function mailReliabilityOptions(
  database: DatabaseClient,
  mode: "off" | "legacy" | "legacy-outbox"
): {
  mailLedger?: PrismaMailLedger;
  atomicMailIngestion?: PrismaAtomicMailIngestion;
} {
  if (mode === "off") return {};
  const mailLedger = new PrismaMailLedger(database);
  return {
    mailLedger,
    ...(mode === "legacy-outbox"
      ? {
          atomicMailIngestion: new PrismaAtomicMailIngestion(
            database,
            mailLedger
          )
        }
      : {})
  };
}
