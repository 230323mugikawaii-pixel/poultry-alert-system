import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createLegacySchemaClient as createDatabaseClient } from "./fixtures/legacy-schema-client.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import { assertTestDatabase } from "./fixtures/mail-ledger-harness.js";
import {
  seedJobFixture,
  jobHarness,
  jobTopic,
  notification,
  jobApp,
  jobHeaders,
  jobPath,
  jobEnvelope
} from "./fixtures/gmail-job-harness.js";

const postgres =
  process.env.RUN_PR03B_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR03b migration round trip", () => {
  it("up/down/up leaves prior synthetic data/schema intact; OFF works before job table; managed history has no pending", async () => {
    const value = process.env.DATABASE_URL ?? "";
    assertTestDatabase(value);
    const admin = new Pool({ connectionString: value });
    const name = `callnow_pr03b_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(value);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() }),
      db = createDatabaseClient(url.toString());
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const root = new URL("../prisma/migrations/", import.meta.url);
      const migrations = (await readdir(root))
        .filter((n) => /^\d/.test(n))
        .sort();
      const migration = "20260923000300_gmail_durable_jobs";
      expect(migrations.indexOf(migration)).toBe(26);
      for (const m of migrations.slice(0, 26))
        await pool.query(
          await readFile(new URL(`${m}/migration.sql`, root), "utf8")
        );
      const f = await seedJobFixture(db),
        h = await jobHarness(db, f.connection.id);
      const app = await jobApp(
        new PrismaGmailJobQueue(db, jobTopic),
        h.service,
        "off"
      );
      try {
        expect(
          (
            await app.inject({
              method: "POST",
              url: jobPath,
              headers: jobHeaders,
              payload: jobEnvelope(f.authorization.email)
            })
          ).statusCode
        ).toBe(204);
      } finally {
        await app.close();
      }
      expect(await db.reliabilityOutbox.count()).toBe(2);
      const tables = (
        await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        )
      ).rows.map((r) => r.tablename);
      const snapshot = async () => {
        const data: Record<string, unknown> = {};
        for (const t of tables) {
          if (!/^[a-z_]+$/.test(t)) throw new Error("Unexpected table");
          data[t] = (
            await pool.query(
              `SELECT to_jsonb(t)::text AS row FROM "${t}" t ORDER BY to_jsonb(t)::text`
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
          await pool.query(
            "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname",
            [tables]
          )
        ).rows;
        return JSON.stringify({ data, columns, constraints, indexes });
      };
      const before = await snapshot();
      const up = await readFile(
        new URL(`${migration}/migration.sql`, root),
        "utf8"
      );
      const down = await readFile(
        new URL("./fixtures/reliability-jobs-down.sql", import.meta.url),
        "utf8"
      );
      await pool.query(up);
      expect(await snapshot()).toBe(before);
      expect(await db.reliabilityJob.count()).toBe(0);
      await new PrismaGmailJobQueue(db, jobTopic).accept(
        notification(f.authorization.email)
      );
      expect(await db.reliabilityJob.count()).toBe(1);
      expect(await snapshot()).toBe(before);
      await pool.query(down);
      expect(await snapshot()).toBe(before);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('reliability_jobs') AS jobs,to_regprocedure('reliability_sync_payload_valid(jsonb)') AS checker"
          )
        ).rows[0]
      ).toEqual({ jobs: null, checker: null });
      await pool.query(up);
      expect(await snapshot()).toBe(before);
      expect(await db.reliabilityJob.count()).toBe(0);
      // Disposable round-trip DB uses SQL directly, never fabricates Prisma migration history.
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
      ).rows.map((r) => r.migration_name);
      expect(applied).toEqual(migrations);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
          )
        ).rows[0]
      ).toEqual({ pending: 0 });
    } finally {
      await db.$disconnect();
      await pool.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  }, 60000);
});
