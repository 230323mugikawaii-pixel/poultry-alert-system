import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createLegacySchemaClient as createDatabaseClient } from "./fixtures/legacy-schema-client.js";
import {
  assertTestDatabase,
  ledgerHarness,
  seedLedgerFixture
} from "./fixtures/mail-ledger-harness.js";

const postgres =
  process.env.RUN_PR02B_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR02b migration round trip", () => {
  it("up/down/up preserves synthetic prior data/schema and all managed migrations are applied", async () => {
    const value = process.env.DATABASE_URL ?? "";
    assertTestDatabase(value);
    const admin = new Pool({ connectionString: value });
    const name = `callnow_pr02b_migration_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(value);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() });
    const client = createDatabaseClient(url.toString());
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const root = new URL("../prisma/migrations/", import.meta.url);
      const migrations = (await readdir(root))
        .filter((x) => /^\d/.test(x))
        .sort();
      const migration = "20260923000200_reliability_outbox";
      expect(migrations.indexOf(migration)).toBe(25);
      for (const item of migrations.slice(0, 25)) {
        await pool.query(
          await readFile(new URL(`${item}/migration.sql`, root), "utf8")
        );
      }
      // Exercise both old flag values BEFORE the Outbox table exists.
      const a = await seedLedgerFixture(client),
        b = await seedLedgerFixture(client);
      await (
        await ledgerHarness(client, a.connection.id, { mode: "off" })
      ).run();
      await (
        await ledgerHarness(client, b.connection.id, { mode: "legacy" })
      ).run();
      const tables = (
        await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        )
      ).rows.map((row) => row.tablename);
      const snapshot = async (ignoreNewIndexes = false) => {
        const data: Record<string, unknown> = {};
        for (const table of tables) {
          if (!/^[a-z_]+$/.test(table))
            throw new Error("Unexpected synthetic table name");
          data[table] = (
            await pool.query(
              `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`
            )
          ).rows;
        }
        const columns = (
          await pool.query(
            "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",
            [tables]
          )
        ).rows;
        const constraints = (
          await pool.query(
            "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY c.conname",
            [tables]
          )
        ).rows;
        const indexes = (
          await pool.query<{ indexname: string }>(
            "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname",
            [tables]
          )
        ).rows.filter(
          (row) =>
            !ignoreNewIndexes ||
            ![
              "alerts_id_teamId_key",
              "alert_recipients_id_alertId_key"
            ].includes(row.indexname)
        );
        return JSON.stringify({ data, columns, constraints, indexes });
      };
      const before = await snapshot();
      const up = await readFile(
        new URL(`${migration}/migration.sql`, root),
        "utf8"
      );
      const down = await readFile(
        new URL("./fixtures/reliability-outbox-down.sql", import.meta.url),
        "utf8"
      );
      await pool.query(up);
      expect(await snapshot(true)).toBe(before);
      expect(await client.reliabilityOutbox.count()).toBe(0); // No historical backfill by migration.
      const c = await seedLedgerFixture(client);
      await (
        await ledgerHarness(client, c.connection.id, { mode: "legacy-outbox" })
      ).run();
      expect(await client.reliabilityOutbox.count()).toBe(2);
      // Include the newly created synthetic legacy records in the preservation check.
      const beforeDown = await snapshot(true);
      await pool.query(down);
      expect(await snapshot()).toBe(beforeDown);
      expect(
        (await pool.query("SELECT to_regclass('reliability_outbox') AS outbox"))
          .rows[0]
      ).toEqual({ outbox: null });
      await pool.query(up);
      expect(await snapshot(true)).toBe(beforeDown);
      expect(await client.reliabilityOutbox.count()).toBe(0);
      await (
        await ledgerHarness(client, c.connection.id, {
          mode: "legacy-outbox",
          message404: true
        })
      ).run();
      expect(await client.reliabilityOutbox.count()).toBe(2);
      expect(await snapshot(true)).toBe(beforeDown);
      // SQL rollback is not a fabricated Prisma migration-history rollback.
      expect(
        (
          await pool.query(
            "SELECT to_regclass('_prisma_migrations') AS history"
          )
        ).rows[0]
      ).toEqual({ history: null });
      const applied = (
        await admin.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
        )
      ).rows.map((row) => row.migration_name);
      expect(applied).toEqual(migrations);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
          )
        ).rows[0]
      ).toEqual({ pending: 0 });
    } finally {
      await client.$disconnect();
      await pool.end();
      // Only this test's exact newly-created DB; no existing DB or volume removed.
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  }, 60_000);
});
