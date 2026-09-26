import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MonitoringStateService } from "../src/modules/mail/reliability/monitoring-state-service.js";
import { monitoringStateReference } from "../src/modules/mail/reliability/monitoring-state-reference.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import {
  seedJobFixture,
  jobHarness,
  jobTopic,
  notification
} from "./fixtures/gmail-job-harness.js";
import {
  monitoringTestDatabase,
  monitoringMigration,
  migrationRoot,
  priorSnapshot
} from "./fixtures/monitoring-test-database.js";

const postgres =
  process.env.RUN_PR04_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR04 additive migration", () => {
  it("create-only SQL up/down/up preserves prior tables, constraints and synthetic data; OFF works with no new tables", async () => {
    const env = await monitoringTestDatabase(true);
    const { db, pool, admin, migrations } = env;
    try {
      const f = await seedJobFixture(db),
        scope = {
          connectionId: f.connection.id,
          teamId: f.team.id,
          mailboxId: f.authorization.id
        };
      const off = new MonitoringStateService(db);
      expect(await off.read(scope)).toEqual({ kind: "OFF" });
      expect(
        await off.setDesired({
          ...scope,
          desired: "RUNNING",
          expectedGeneration: 0n
        })
      ).toEqual({ kind: "OFF" });
      expect(
        await off.observe({
          ...scope,
          expectedGeneration: 0n,
          observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
        })
      ).toEqual({ kind: "OFF" });
      expect(await off.classifyReceivedAt(scope, new Date())).toEqual({
        kind: "OFF"
      });
      const h = await jobHarness(db, f.connection.id),
        q = new PrismaGmailJobQueue(db, jobTopic);
      await q.accept(notification(f.authorization.email));
      expect(
        await new GmailJobWorker(
          q,
          h.service,
          "durable",
          120000,
          monitoringStateReference(db, "off")
        ).runOnce()
      ).toBe("DONE");
      expect(await db.reliabilityOutbox.count()).toBe(2);
      const before = await priorSnapshot(pool);
      const up = await readFile(
        new URL(`${monitoringMigration}/migration.sql`, migrationRoot),
        "utf8"
      );
      expect(up).not.toMatch(/^\s*(DROP|TRUNCATE|UPDATE|DELETE|INSERT)\b/im);
      expect(up).not.toMatch(
        /ALTER TABLE "?(mail_|alerts|alert_recipients|teams|reliability_)/i
      );
      const down = await readFile(
        new URL("./fixtures/monitoring-state-down.sql", import.meta.url),
        "utf8"
      );
      expect(down).not.toMatch(/\bCASCADE\s*;/i);
      await pool.query(up);
      expect(await db.monitoringState.count()).toBe(0);
      expect(await db.monitoringEpoch.count()).toBe(0);
      expect(await priorSnapshot(pool, before.tables)).toEqual(before);
      const service = new MonitoringStateService(db, "shadow");
      await service.setDesired({
        ...scope,
        desired: "RUNNING",
        expectedGeneration: 0n
      });
      await service.observe({
        ...scope,
        expectedGeneration: 1n,
        observation: { kind: "AUTH_FAILURE", reason: "HTTP_401" }
      });
      await service.setDesired({
        ...scope,
        desired: "PAUSED",
        expectedGeneration: 2n
      });
      expect(await priorSnapshot(pool, before.tables)).toEqual(before);
      await pool.query(down);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('monitoring_states') AS state,to_regclass('monitoring_epochs') AS epoch,to_regtype('\"MonitorDesired\"') AS desired,to_regtype('\"MonitorObserved\"') AS observed,to_regtype('\"IngestionOwner\"') AS owner"
          )
        ).rows[0]
      ).toEqual({
        state: null,
        epoch: null,
        desired: null,
        observed: null,
        owner: null
      });
      expect(await priorSnapshot(pool)).toEqual(before);
      await pool.query(up);
      expect(await db.monitoringState.count()).toBe(0);
      expect(await db.monitoringEpoch.count()).toBe(0);
      expect(await priorSnapshot(pool, before.tables)).toEqual(before);
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
      expect(applied).toHaveLength(28);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
          )
        ).rows[0]
      ).toEqual({ pending: 0 });
    } finally {
      await env.close();
    }
  }, 60000);
});
