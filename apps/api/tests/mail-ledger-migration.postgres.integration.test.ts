import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createDatabaseClient } from "../src/db/client.js";
import {
  assertTestDatabase,
  ledgerHarness,
  seedLedgerFixture
} from "./fixtures/mail-ledger-harness.js";

const postgres =
  process.env.RUN_PR01_POSTGRES_TESTS === "true" ? describe : describe.skip;
const migrationName = "20260923000100_mail_message_ledger";

postgres("PR01 PostgreSQL 17 migration round trip", () => {
  it("up/down/up preserves all pre-existing synthetic data and schema; normal deploy has 25/25 migrations", async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    assertTestDatabase(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl });
    // This database is created by THIS test, on an acknowledged disposable server.
    // No existing database or Prisma migration record is reset/deleted/rewritten.
    const name = `callnow_pr01_migration_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    let created = false;
    const pool = new Pool({ connectionString: url.toString() });
    const client = createDatabaseClient(url.toString());
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const root = new URL("../prisma/migrations/", import.meta.url);
      const migrations = (await readdir(root))
        .filter((entry) => /^\d/.test(entry))
        .sort();
      expect(migrations).toHaveLength(25);
      expect(migrations.at(-1)).toBe(migrationName);
      // SQL-only fixture construction, intentionally without _prisma_migrations.
      // This is NOT a claimed Prisma rollback or a fabricated applied history.
      for (const migration of migrations.slice(0, -1)) {
        await pool.query(
          await readFile(new URL(`${migration}/migration.sql`, root), "utf8")
        );
      }
      const fixture = await seedLedgerFixture(client);
      await (
        await ledgerHarness(client, fixture.connection.id, { mode: "off" })
      ).run();
      const tables = (
        await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        )
      ).rows.map(({ tablename }) => tablename);
      const snapshot = async () => {
        const data: Record<string, unknown> = {};
        for (const table of tables) {
          if (!/^[a-z_]+$/.test(table))
            throw new Error("Unexpected fixture table");
          data[table] = (
            await pool.query(
              `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`
            )
          ).rows;
        }
        const columns = (
          await pool.query(
            "SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position",
            [tables]
          )
        ).rows;
        const constraints = (
          await pool.query(
            "SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname = ANY($1) ORDER BY c.conname",
            [tables]
          )
        ).rows;
        const indexes = (
          await pool.query(
            "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename, indexname",
            [tables]
          )
        ).rows;
        return JSON.stringify({ data, columns, constraints, indexes });
      };
      const before = await snapshot();
      const up = await readFile(
        new URL(`${migrationName}/migration.sql`, root),
        "utf8"
      );
      expect(up).not.toMatch(
        /\b(?:DROP|TRUNCATE|DELETE|UPDATE)\s+(?:TABLE|FROM|"?teams"?|"?alerts"?)/i
      );
      await pool.query(up);
      expect(await snapshot()).toBe(before);
      await (await ledgerHarness(client, fixture.connection.id)).run();
      expect(await client.mailMessageLedger.count()).toBe(1);
      expect(await snapshot()).toBe(before);
      const down = await readFile(
        new URL("./fixtures/mail-ledger-down.sql", import.meta.url),
        "utf8"
      );
      await pool.query(down);
      expect(await snapshot()).toBe(before);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('mail_message_ledger') AS ledger, to_regclass('mail_evaluations') AS evaluation"
          )
        ).rows[0]
      ).toEqual({ ledger: null, evaluation: null });
      await pool.query(up);
      expect(await snapshot()).toBe(before);
      await (await ledgerHarness(client, fixture.connection.id)).run();
      expect(await client.mailMessageLedger.count()).toBe(1);
      expect(
        (
          await pool.query<{ history: string | null }>(
            "SELECT to_regclass('_prisma_migrations') AS history"
          )
        ).rows[0]!.history
      ).toBeNull();
      const applied = (
        await admin.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
        )
      ).rows.map((row) => row.migration_name);
      expect(applied).toEqual(migrations);
      expect(
        (
          await admin.query<{ pending: number }>(
            "SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
          )
        ).rows[0]!.pending
      ).toBe(0);
    } finally {
      await client.$disconnect();
      await pool.end();
      // Only the exact, freshly allocated synthetic round-trip DB is removed.
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  }, 60_000);
});
