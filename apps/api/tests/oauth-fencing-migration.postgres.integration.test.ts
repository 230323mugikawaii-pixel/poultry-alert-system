import { readFile } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import {
  oauthTestDatabase,
  oauthMigration,
  migrationRoot,
  newColumns,
  oldSnapshot
} from "./fixtures/oauth-test-database.js";
import {
  seedJobFixture,
  jobHarness,
  jobTopic,
  notification
} from "./fixtures/gmail-job-harness.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import { createOAuthFencedRefresh } from "../src/modules/mail/reliability/oauth-fenced-refresh.js";

const postgres =
  process.env.RUN_PR05A_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR05a migration round trip", () => {
  it("prior 27 + synthetic data -> up/down/up; only six new columns differ, history is not edited", async () => {
    const env = await oauthTestDatabase(true),
      { db, oldDb, pool, admin, migrations } = env;
    try {
      // Test-only old-schema client omits nonexistent columns; production includes are unchanged.
      const f = await seedJobFixture(oldDb),
        q = new PrismaGmailJobQueue(oldDb, jobTopic),
        h = await jobHarness(oldDb, f.connection.id);
      await q.accept(notification(f.authorization.email));
      expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
        "DONE"
      );
      const before = await oldSnapshot(pool);
      const up = await readFile(
        new URL(`${oauthMigration}/migration.sql`, migrationRoot),
        "utf8"
      );
      const down = await readFile(
        new URL("./fixtures/oauth-fencing-down.sql", import.meta.url),
        "utf8"
      );
      expect(up).not.toMatch(/\b(DROP|TRUNCATE|UPDATE|DELETE|INSERT)\b/i);
      expect((up.match(/ADD COLUMN/g) ?? []).length).toBe(6);
      expect(down).not.toMatch(/CASCADE\s*;/i);
      await pool.query(up);
      expect(await oldSnapshot(pool)).toBe(before);
      const defaults = async () => {
        const r = await db.mailAuthorization.findUniqueOrThrow({
          where: { id: f.authorization.id },
          select: {
            encryptedAccessToken: true,
            accessTokenExpiresAt: true,
            credentialVersion: true,
            refreshLeaseToken: true,
            refreshLeaseUntil: true,
            refreshLeaseGeneration: true
          }
        });
        expect(r).toEqual({
          encryptedAccessToken: null,
          accessTokenExpiresAt: null,
          credentialVersion: 0,
          refreshLeaseToken: null,
          refreshLeaseUntil: null,
          refreshLeaseGeneration: 0n
        });
      };
      await defaults();
      const dependencies = vi.fn(() => {
        throw new Error("OFF must not construct");
      });
      expect(createOAuthFencedRefresh("off", dependencies)).toBeUndefined();
      expect(dependencies).not.toHaveBeenCalled();
      const included = await db.mailConnection.findUniqueOrThrow({
        where: { id: f.connection.id },
        include: { mailAuthorization: true }
      });
      expect(included.mailAuthorization.credentialVersion).toBe(0);
      expect(included.mailAuthorization.encryptedAccessToken).toBeNull();
      const after = await jobHarness(db, f.connection.id);
      await q.accept(notification(f.authorization.email));
      expect(
        await new GmailJobWorker(q, after.service, "durable").runOnce()
      ).toBe("IDLE");
      expect(await oldSnapshot(pool)).toBe(before);
      await pool.query(down);
      expect(await oldSnapshot(pool)).toBe(before);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='mail_authorizations' AND column_name=ANY($1)",
            [newColumns]
          )
        ).rows[0]
      ).toEqual({ count: 0 });
      await pool.query(up);
      await defaults();
      expect(await oldSnapshot(pool)).toBe(before);
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
