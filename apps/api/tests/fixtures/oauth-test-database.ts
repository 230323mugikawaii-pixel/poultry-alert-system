import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createDatabaseClient } from "../../src/db/client.js";
import { createLegacySchemaClient } from "./legacy-schema-client.js";
import { assertTestDatabase } from "./mail-ledger-harness.js";

export const oauthMigration = "20260924000200_oauth_refresh_fencing";
export const migrationRoot = new URL(
  "../../prisma/migrations/",
  import.meta.url
);
export const newColumns = [
  "encryptedAccessToken",
  "accessTokenExpiresAt",
  "credentialVersion",
  "refreshLeaseToken",
  "refreshLeaseUntil",
  "refreshLeaseGeneration"
];
export async function oauthTestDatabase(priorOnly = false) {
  const value = process.env.DATABASE_URL ?? "";
  assertTestDatabase(value);
  const admin = new Pool({ connectionString: value });
  const name = `callnow_pr05a_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(value);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  const db = createDatabaseClient(url.toString());
  const oldDb = createLegacySchemaClient(url.toString());
  let created = false;
  const close = async () => {
    await db.$disconnect();
    await oldDb.$disconnect();
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
    const position = migrations.indexOf(oauthMigration);
    if (position !== 27)
      throw new Error("PR05a baseline migration count changed");
    for (const m of priorOnly ? migrations.slice(0, position) : migrations)
      await pool.query(
        await readFile(new URL(`${m}/migration.sql`, migrationRoot), "utf8")
      );
    return { db, oldDb, pool, admin, migrations, close };
  } catch {
    await close();
    throw new Error("PR05a disposable database setup failed");
  }
}

/** Compare every OLD column/row/constraint/index. Assertion output contains a hash, not records. */
export async function oldSnapshot(pool: Pool) {
  const names = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    )
  ).rows.map((r) => r.tablename);
  const data: Record<string, unknown> = {};
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected test table name");
    data[name] = (
      await pool.query(
        `SELECT (to_jsonb(t) - $1::text[])::text AS row FROM "${name}" t ORDER BY (to_jsonb(t) - $1::text[])::text`,
        [name === "mail_authorizations" ? newColumns : []]
      )
    ).rows;
  }
  const columns = (
    await pool.query(
      "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND NOT (table_name='mail_authorizations' AND column_name=ANY($1)) ORDER BY table_name,ordinal_position",
      [newColumns]
    )
  ).rows;
  const constraints = (
    await pool.query(
      "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY c.conname"
    )
  ).rows;
  const indexes = (
    await pool.query(
      "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname"
    )
  ).rows;
  return createHash("sha256")
    .update(JSON.stringify({ data, columns, constraints, indexes }))
    .digest("hex");
}
