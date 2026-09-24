import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createDeliveryDatabase,
  deliveryFixture,
  oldDeliverySnapshot,
  deliveryMigration,
  deliveryMigrationRoot
} from "./fixtures/delivery-test-database.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import { PrismaOutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
import { FakeTransport } from "../src/modules/mail/reliability/outbox-transport.js";
const postgres =
  process.env.RUN_PR07A_POSTGRES_TESTS === "true" ? describe : describe.skip;
postgres("PR07a isolated migration", () => {
  it("28 prior migrations + up/down/up: old data/schema unchanged, off works even without new table", async () => {
    const d = await createDeliveryDatabase(true);
    try {
      const version = await d.pool.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::int AS version"
      );
      expect(version.rows[0]!.version).toBeGreaterThanOrEqual(170000);
      expect(version.rows[0]!.version).toBeLessThan(180000);
      expect(d.migrations.filter((m) => m < deliveryMigration)).toHaveLength(
        28
      );
      const f = await deliveryFixture(d.db);
      const w = new OutboxDispatcher(
        new PrismaOutboxQueue(d.db),
        new FakeTransport(),
        { mode: "fake" }
      );
      expect(await w.runOnce()).toBe("DISPATCHED");
      expect(await w.runOnce()).toBe("DISPATCHED");
      const before = await oldDeliverySnapshot(d.pool);
      const up = await readFile(
        new URL(`${deliveryMigration}/migration.sql`, deliveryMigrationRoot),
        "utf8"
      );
      expect(/^\s*(DROP|TRUNCATE|UPDATE|DELETE)\b/imu.test(up)).toBe(false);
      const down = await readFile(
        new URL("./fixtures/notification-delivery-down.sql", import.meta.url),
        "utf8"
      );
      expect(/\bCASCADE\s*;/iu.test(down)).toBe(false);
      await d.pool.query(up);
      expect(await oldDeliverySnapshot(d.pool)).toBe(before);
      await d.db.notificationDelivery.create({
        data: {
          outboxId: f.ownerJob.id,
          targetKey: f.targets[0]!.targetKey,
          targetVersion: 1
        }
      });
      await d.pool.query(down);
      expect(await oldDeliverySnapshot(d.pool)).toBe(before);
      expect(await w.runOnce()).toBe("IDLE");
      await d.pool.query(up);
      expect(await oldDeliverySnapshot(d.pool)).toBe(before);
      expect(await d.db.notificationDelivery.count()).toBe(0);
      // Manual SQL round-trip DB has no fake Prisma migration history. Deploy/drift is verified separately.
      expect(
        (
          await d.pool.query<{ history: string | null }>(
            "SELECT to_regclass('public._prisma_migrations') AS history"
          )
        ).rows[0]!.history
      ).toBeNull();
    } finally {
      await d.close();
    }
  });
});
