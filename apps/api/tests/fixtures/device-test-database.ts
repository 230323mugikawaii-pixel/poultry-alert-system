import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createDatabaseClient } from "../../src/db/client.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";

export const deviceMigration = "20260924000300_device_push_registry";
export const migrationRoot = new URL(
  "../../prisma/migrations/",
  import.meta.url
);
export async function createDeviceTestDatabase(priorOnly = false) {
  const value = process.env.DATABASE_URL ?? "";
  assertTestDatabase(value);
  const admin = new Pool({ connectionString: value });
  const name = `callnow_pr06_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(value);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.toString() });
  const db = createDatabaseClient(url.toString());
  const close = async () => {
    await db.$disconnect();
    await pool.end();
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  };
  const migrations = (await readdir(migrationRoot))
    .filter((n) => /^\d/u.test(n))
    .sort();
  try {
    for (const m of migrations.filter(
      (m) => !priorOnly || m !== deviceMigration
    )) {
      await pool.query(
        await readFile(new URL(`${m}/migration.sql`, migrationRoot), "utf8")
      );
    }
  } catch {
    await close();
    throw new Error("PR06_DISPOSABLE_MIGRATION_FAILED");
  }
  return { db, pool, admin, migrations, close };
}

export async function oldTablesSnapshot(pool: Pool) {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'device_push_registrations' ORDER BY tablename"
    )
  ).rows.map((r) => r.tablename);
  const hash = createHash("sha256");
  for (const t of tables) {
    if (!/^[a-z_]+$/u.test(t)) throw new Error("PR06_UNEXPECTED_TABLE");
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
  for (const query of [
    "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",
    "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY c.conname",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname"
  ])
    hash.update(JSON.stringify((await pool.query(query, [tables])).rows));
  return hash.digest("hex");
}
