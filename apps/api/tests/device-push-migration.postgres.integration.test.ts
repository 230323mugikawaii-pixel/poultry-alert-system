import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  deviceApp,
  deviceFixture,
  makeDeviceToken,
  registry
} from "./fixtures/device-push-harness.js";
import {
  createDeviceTestDatabase,
  deviceMigration,
  migrationRoot,
  oldTablesSnapshot
} from "./fixtures/device-test-database.js";
import {
  jobApp,
  jobEnvelope,
  jobHeaders,
  jobPath,
  jobTopic,
  seedJobFixture,
  jobHarness
} from "./fixtures/gmail-job-harness.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";

const postgres =
  process.env.RUN_PR06_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR06 additive migration", () => {
  it("off works without registry table; up/down/up preserves all previous schema/data and old include behavior", async () => {
    const test = await createDeviceTestDatabase(true);
    try {
      const f = await deviceFixture(test.db),
        previous = await seedJobFixture(test.db),
        harness = await jobHarness(test.db, previous.connection.id);
      const legacy = await jobApp(
        new PrismaGmailJobQueue(test.db, jobTopic),
        harness.service,
        "off"
      );
      try {
        expect(
          (
            await legacy.inject({
              method: "POST",
              url: jobPath,
              headers: jobHeaders,
              payload: jobEnvelope(previous.authorization.email)
            })
          ).statusCode
        ).toBe(204);
        expect(
          await test.db.alert.count({ where: { teamId: previous.team.id } })
        ).toBe(1);
        expect(
          await test.db.reliabilityOutbox.count({
            where: { teamId: previous.team.id }
          })
        ).toBe(2);
      } finally {
        await legacy.close();
      }
      const included = () =>
        test.db.mailConnection.findUniqueOrThrow({
          where: { id: previous.connection.id },
          include: { mailAuthorization: true }
        });
      const original = JSON.stringify(await included());
      const before = await oldTablesSnapshot(test.pool);
      const off = async () => {
        let constructed = 0;
        const app = await deviceApp(test.db, "off", () => {
          constructed++;
          throw new Error("OFF_CONSTRUCTION_FORBIDDEN");
        });
        try {
          for (const base of [f.ownerPath, f.memberPath])
            for (const method of ["POST", "GET", "PUT", "DELETE"] as const) {
              const res = await app.inject({
                method,
                url: method === "POST" ? base : `${base}/${randomUUID()}`,
                headers: f.ownerHeaders
              });
              expect(res.statusCode).toBe(404);
            }
          expect(constructed).toBe(0);
          expect((await app.inject("/healthz")).statusCode).toBe(200);
        } finally {
          await app.close();
        }
      };
      await off();
      const up = await readFile(
        new URL(`${deviceMigration}/migration.sql`, migrationRoot),
        "utf8"
      );
      const down = await readFile(
        new URL("./fixtures/device-push-down.sql", import.meta.url),
        "utf8"
      );
      expect(
        /\b(?:DROP|TRUNCATE|UPDATE|DELETE)\s+(?:TABLE|COLUMN|FROM|"?(?:users|mail_|teams))/iu.test(
          up
        )
      ).toBe(false);
      await test.pool.query(up);
      expect(await oldTablesSnapshot(test.pool)).toBe(before);
      await registry(test.db).register(
        f.memberScope,
        randomUUID(),
        makeDeviceToken()
      );
      expect(await oldTablesSnapshot(test.pool)).toBe(before);
      expect(JSON.stringify(await included()) === original).toBe(true);
      await off();
      await test.pool.query(down);
      expect(await oldTablesSnapshot(test.pool)).toBe(before);
      await off();
      expect(
        (
          await test.pool.query(
            "SELECT to_regclass('device_push_registrations') AS registry"
          )
        ).rows[0]
      ).toEqual({ registry: null });
      await test.pool.query(up);
      expect(await test.db.devicePushRegistration.count()).toBe(0);
      expect(await oldTablesSnapshot(test.pool)).toBe(before);
      expect(JSON.stringify(await included()) === original).toBe(true);
      // SQL round-trip DB has no fabricated Prisma history. The separate manager is deployed by Prisma.
      expect(
        (
          await test.pool.query(
            "SELECT to_regclass('_prisma_migrations') AS history"
          )
        ).rows[0]
      ).toEqual({ history: null });
      const applied = (
        await test.admin.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
        )
      ).rows.map((r) => r.migration_name);
      expect(applied).toEqual(test.migrations);
      expect(
        (
          await test.admin.query(
            "SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
          )
        ).rows[0]
      ).toEqual({ pending: 0 });
    } finally {
      await test.close();
    }
  }, 60000);
});
