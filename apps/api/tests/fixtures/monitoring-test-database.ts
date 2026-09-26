import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createDatabaseClient } from "../../src/db/client.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";

export const monitoringMigration = "20260924000100_monitoring_state_epochs";
export const migrationRoot = new URL(
  "../../prisma/migrations/",
  import.meta.url
);
export async function monitoringTestDatabase(priorOnly = false) {
  const value = process.env.DATABASE_URL ?? "";
  assertTestDatabase(value);
  const admin = new Pool({ connectionString: value });
  const name = `callnow_pr04_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(value);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() }),
    db = createDatabaseClient(url.toString());
  let created = false;
  const close = async () => {
    await db.$disconnect();
    await pool.end();
    if (created) {
      await admin.query(`DROP DATABASE "${name}"`);
      created = false;
    }
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const migrations = (await readdir(migrationRoot))
      .filter((n) => /^\d/.test(n))
      .sort();
    const position = migrations.indexOf(monitoringMigration);
    if (position !== 27)
      throw new Error("PR04 baseline migration count changed");
    for (const m of priorOnly ? migrations.slice(0, position) : migrations)
      await pool.query(
        await readFile(new URL(`${m}/migration.sql`, migrationRoot), "utf8")
      );
    return { admin, pool, db, migrations, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Hash, not raw records, in assertion output (synthetic data only). */
export async function priorSnapshot(pool: Pool, tables?: string[]) {
  const names =
    tables ??
    (
      await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      )
    ).rows.map((r) => r.tablename);
  const data: Record<string, unknown> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected test table name");
    data[name] = (
      await pool.query(
        `SELECT to_jsonb(t)::text AS row FROM "${name}" t ORDER BY to_jsonb(t)::text`
      )
    ).rows;
  }
  const columns = (
    await pool.query(
      "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",
      [names]
    )
  ).rows;
  const constraints = (
    await pool.query(
      "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY c.conname",
      [names]
    )
  ).rows;
  const indexes = (
    await pool.query(
      "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname",
      [names]
    )
  ).rows;
  return {
    tables: names,
    digest: createHash("sha256")
      .update(JSON.stringify({ data, columns, constraints, indexes }))
      .digest("hex")
  };
}
