import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  createDatabaseClient,
  type DatabaseClient
} from "../../src/db/client.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";
import {
  deliveryFixture,
  deliveryMigrationRoot
} from "./delivery-test-database.js";
import { PrismaMobileDeliveryPlanner } from "../../src/modules/device-push/mobile-delivery-planner.js";
import { PrismaOutboxQueue } from "../../src/modules/mail/reliability/prisma-outbox-queue.js";
import { OutboxDispatcher } from "../../src/modules/mail/reliability/outbox-dispatcher.js";
import { FakeTransport } from "../../src/modules/mail/reliability/outbox-transport.js";
import {
  FakePushTransport,
  type PushTransportInput,
  type PushTransportResult
} from "../../src/modules/device-push/push-transport.js";

export async function createPushWorkerDatabase() {
  const value = process.env.DATABASE_URL ?? "";
  assertTestDatabase(value);
  const name = `callnow_pr07b_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: value });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(value);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() }),
    db = createDatabaseClient(url.toString());
  const close = async () => {
    await db.$disconnect();
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  };
  try {
    for (const m of (await readdir(deliveryMigrationRoot))
      .filter((m) => /^\d/u.test(m))
      .sort())
      await pool.query(
        await readFile(
          new URL(`${m}/migration.sql`, deliveryMigrationRoot),
          "utf8"
        )
      );
    // Test-only durable Fake receiver. No production table/migration/real provider.
    await pool.query(
      'CREATE TABLE push_worker_fake_receipts ("idempotencyKey" char(64) PRIMARY KEY, "providerRequestId" uuid NOT NULL, "sendCalls" integer NOT NULL DEFAULT 1)'
    );
  } catch {
    await close();
    throw new Error("PR07B_MIGRATION_FAILED");
  }
  return { db, pool, url: url.toString(), close };
}
export async function pushFixture(
  db: DatabaseClient,
  ownerTargets = 1,
  memberTargets = 0
) {
  const f = await deliveryFixture(db, ownerTargets, memberTargets);
  const dispatcher = new OutboxDispatcher(
    new PrismaOutboxQueue(db),
    new FakeTransport(),
    {
      mode: "fake",
      mobileDeliveryMode: "shadow",
      mobilePlanner: new PrismaMobileDeliveryPlanner(db, "validated")
    }
  );
  await dispatcher.runOnce();
  await dispatcher.runOnce();
  const deliveries = await db.notificationDelivery.findMany({
    where: { outbox: { teamId: f.team.id } },
    orderBy: { id: "asc" }
  });
  return { ...f, deliveries };
}
export class DurableFakePushTransport extends FakePushTransport {
  public constructor(private readonly pool: Pool) {
    super();
  }
  public override async send(
    input: PushTransportInput,
    signal: AbortSignal
  ): Promise<PushTransportResult> {
    const result = await super.send(input, signal);
    if (result.kind !== "ACCEPTED")
      throw new Error("PR07B_FAKE_RECEIPT_REQUIRED");
    const rows = await this.pool.query<{ providerRequestId: string }>(
      'INSERT INTO push_worker_fake_receipts ("idempotencyKey","providerRequestId") VALUES ($1,$2) ON CONFLICT ("idempotencyKey") DO UPDATE SET "sendCalls"=push_worker_fake_receipts."sendCalls"+1 RETURNING "providerRequestId"',
      [input.idempotencyKey, result.providerRequestId]
    );
    return {
      kind: "ACCEPTED",
      providerRequestId: rows.rows[0]!.providerRequestId
    };
  }
}
