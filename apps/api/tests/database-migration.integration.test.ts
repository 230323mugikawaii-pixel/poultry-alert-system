import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migration =
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000100_phase1_foundation/migration.sql",
      import.meta.url
    ),
    "utf8"
  ) +
  readFileSync(
    new URL(
      "../prisma/migrations/20260824000200_security_throttles/migration.sql",
      import.meta.url
    ),
    "utf8"
  );

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => database.close())
  );
});

describe("initial PostgreSQL migration", () => {
  it("applies cleanly and enforces team and owner invariants", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(migration);

    await database.exec(`
      INSERT INTO users (id, email, "updatedAt") VALUES
        ('00000000-0000-0000-0000-000000000001', 'owner@example.com', now()),
        ('00000000-0000-0000-0000-000000000002', 'second@example.com', now());
      INSERT INTO teams (id, "publicCode", "updatedAt") VALUES
        ('10000000-0000-0000-0000-000000000001', '482731', now());
      INSERT INTO team_memberships (id, "teamId", "userId", role, status) VALUES
        ('20000000-0000-0000-0000-000000000001',
         '10000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000001',
         'OWNER', 'ACTIVE');
    `);

    await expect(
      database.exec(`
        INSERT INTO team_memberships (id, "teamId", "userId", role, status)
        VALUES (
          '20000000-0000-0000-0000-000000000002',
          '10000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'OWNER', 'ACTIVE'
        );
      `)
    ).rejects.toThrow();

    await expect(
      database.exec(`
        INSERT INTO teams (id, "publicCode", "updatedAt")
        VALUES ('10000000-0000-0000-0000-000000000002', 'ABC123', now());
      `)
    ).rejects.toThrow();
  });
});
