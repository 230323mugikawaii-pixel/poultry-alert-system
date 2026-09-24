import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import {
  createDatabaseClient,
  type DatabaseClient
} from "../../src/db/client.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import {
  assertTestDatabase,
  seedLedgerFixture,
  ledgerHarness
} from "./mail-ledger-harness.js";
import { registry, makeDeviceToken } from "./device-push-harness.js";

export const deliveryMigration = "20260924000400_notification_delivery_intents";
export const deliveryMigrationRoot = new URL(
  "../../prisma/migrations/",
  import.meta.url
);
export async function createDeliveryDatabase(priorOnly = false) {
  const value = process.env.DATABASE_URL ?? "";
  assertTestDatabase(value);
  const name = `callnow_pr07a_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: value });
  const url = new URL(value);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.toString() }),
    db = createDatabaseClient(url.toString());
  const close = async () => {
    await db.$disconnect();
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  };
  const migrations = (await readdir(deliveryMigrationRoot))
    .filter((m) => /^\d/u.test(m))
    .sort();
  try {
    for (const m of migrations.filter(
      (m) => !priorOnly || m < deliveryMigration
    ))
      await pool.query(
        await readFile(
          new URL(`${m}/migration.sql`, deliveryMigrationRoot),
          "utf8"
        )
      );
  } catch {
    await close();
    throw new Error("PR07A_DISPOSABLE_MIGRATION_FAILED");
  }
  return { db, pool, admin, migrations, url: url.toString(), close };
}
export async function deliveryFixture(
  db: DatabaseClient,
  ownerTargets = 2,
  memberTargets = 1
) {
  const f = await seedLedgerFixture(db);
  await (
    await ledgerHarness(db, f.connection.id, { mode: "legacy-outbox" })
  ).run();
  const rows = await db.reliabilityOutbox.findMany({
    where: { teamId: f.team.id },
    include: { recipient: true }
  });
  const ownerJob = rows.find((r) => r.recipient?.kind === "OWNER")!;
  const memberJob = rows.find(
    (r) => r.recipient?.kind === "NOTIFICATION_MEMBER"
  )!;
  const ownerScope = {
    teamId: f.team.id,
    principalKind: "OWNER" as const,
    principalId: f.owner.id
  };
  const memberScope = {
    teamId: f.team.id,
    principalKind: "MEMBER" as const,
    principalId: f.member.id
  };
  const targets = [];
  for (const [count, scope] of [
    [ownerTargets, ownerScope],
    [memberTargets, memberScope]
  ] as const)
    for (let i = 0; i < count; i++)
      targets.push(
        await registry(db).register(scope, randomUUID(), makeDeviceToken())
      );
  return { ...f, ownerJob, memberJob, ownerScope, memberScope, targets };
}
export async function oldDeliverySnapshot(pool: Pool) {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'notification_deliveries' ORDER BY tablename"
    )
  ).rows.map((r) => r.tablename);
  const hash = createHash("sha256");
  for (const t of tables) {
    if (!/^[a-z_]+$/u.test(t)) throw new Error("PR07A_UNEXPECTED_TABLE");
    hash.update(
      JSON.stringify(
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS row FROM "${t}" t ORDER BY to_jsonb(t)::text`
          )
        ).rows
      )
    );
  }
  for (const sql of [
    "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",
    "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY c.conname",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname"
  ])
    hash.update(JSON.stringify((await pool.query(sql, [tables])).rows));
  return hash.digest("hex");
}

// Test-only transaction interception. No crash hooks in production.
export function deliveryTxProbe(
  db: DatabaseClient,
  hooks: {
    before?: (tx: Prisma.TransactionClient) => Promise<void>;
    after?: () => Promise<void>;
  }
): DatabaseClient {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "$transaction")
        return Reflect.get(target, key, receiver) as unknown;
      return async (
        body: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: Parameters<DatabaseClient["$transaction"]>[1]
      ) => {
        const result = await target.$transaction(async (tx) => {
          const result = await body(tx);
          await hooks.before?.(tx);
          return result;
        }, options);
        await hooks.after?.();
        return result;
      };
    }
  });
}
