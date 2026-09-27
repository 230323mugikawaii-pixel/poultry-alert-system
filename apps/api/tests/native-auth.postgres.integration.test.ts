import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createDeviceTestDatabase,
  migrationRoot
} from "./fixtures/device-test-database.js";
import { seedLedgerFixture } from "./fixtures/mail-ledger-harness.js";
import { PrismaAuthRepository } from "../src/modules/auth/prisma-auth-repository.js";
import { PrismaNativeGrantRepository } from "../src/modules/auth/prisma-native-grant-repository.js";
import { nativeFixture } from "./helpers/native-auth-fixture.js";
import { pkceChallenge } from "../src/modules/auth/native-auth-service.js";
import type { Pool } from "pg";

const postgres =
  process.env.RUN_NATIVE_AUTH_POSTGRES_TESTS === "true"
    ? describe
    : describe.skip;
const random = () => randomBytes(32).toString("base64url");
const hash = () => createHash("sha256").update(random()).digest("hex");
async function snapshot(pool: Pool) {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'native_login_grants' ORDER BY tablename"
    )
  ).rows.map((r) => r.tablename);
  const digest = createHash("sha256");
  for (const table of tables) {
    if (!/^[a-z_]+$/u.test(table)) throw new Error("UNEXPECTED_TEST_TABLE");
    digest.update(
      JSON.stringify(
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`
          )
        ).rows
      )
    );
  }
  for (const query of [
    "SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name,ordinal_position",
    "SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY($1) ORDER BY c.conname",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname"
  ])
    digest.update(JSON.stringify((await pool.query(query, [tables])).rows));
  return digest.digest("hex");
}
postgres("native PKCE durable grants (isolated PostgreSQL)", () => {
  it("up/down/up preserves every existing table, row, constraint and index; off needs no new table", async () => {
    const test = await createDeviceTestDatabase();
    try {
      await seedLedgerFixture(test.db);
      const before = await snapshot(test.pool);
      const down = await readFile(
        new URL("./fixtures/native-auth-down.sql", import.meta.url),
        "utf8"
      );
      const up = await readFile(
        new URL(
          "20260927000100_native_login_grants/migration.sql",
          migrationRoot
        ),
        "utf8"
      );
      expect(/\b(?:DROP|ALTER|UPDATE|TRUNCATE|DELETE)\b/iu.test(up)).toBe(
        false
      );
      await test.pool.query(down);
      expect(await snapshot(test.pool)).toBe(before);
      const off = await nativeFixture({
        mode: "off",
        authRepository: new PrismaAuthRepository(test.db),
        grants: new PrismaNativeGrantRepository(test.db)
      });
      try {
        expect(off.constructed()).toBe(0);
        expect(
          (await off.app.inject("/api/v1/auth/native/providers")).statusCode
        ).toBe(404);
        expect((await off.app.inject("/healthz")).statusCode).toBe(200);
      } finally {
        await off.app.close();
      }
      await test.pool.query(up);
      expect(await snapshot(test.pool)).toBe(before);
      expect(await test.db.nativeLoginGrant.count()).toBe(0);
      expect(
        (
          await test.pool.query(
            "SELECT to_regclass('_prisma_migrations') AS history"
          )
        ).rows[0]
      ).toEqual({ history: null });
      // Raw SQL round-trip never forges migration history. CI's separate disposable
      // manager uses prisma migrate deploy and drift checking.
      const applied = (
        await test.admin.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
        )
      ).rows.map((r) => r.migration_name);
      expect(applied).toEqual(test.migrations);
    } finally {
      await test.close();
    }
  }, 60000);
  it("100 concurrent callbacks and exchanges each have exactly one winner; duplicates never mint a second session", async () => {
    const test = await createDeviceTestDatabase();
    try {
      const f = await seedLedgerFixture(test.db),
        repository = new PrismaNativeGrantRepository(test.db);
      const now = new Date(),
        stateHash = hash(),
        bindingHash = hash(),
        codeHash = hash(),
        challenge = pkceChallenge(random());
      await repository.create({
        stateHash,
        bindingHash,
        provider: "GOOGLE",
        clientState: random(),
        codeChallenge: challenge,
        expiresAt: new Date(now.getTime() + 600000)
      });
      const callbacks = await Promise.all(
        Array.from({ length: 100 }, () =>
          repository.claimCallback(stateHash, bindingHash, "GOOGLE", now)
        )
      );
      expect(callbacks.filter(Boolean)).toHaveLength(1);
      await repository.issueCode(
        callbacks.find(Boolean)!.id,
        f.owner.id,
        codeHash,
        now
      );
      expect(
        await repository.consumeCode(codeHash, pkceChallenge(random()), now)
      ).toBeNull();
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          repository.consumeCode(codeHash, challenge, now)
        )
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)?.id === f.owner.id).toBe(true);
      expect(await repository.consumeCode(codeHash, challenge, now)).toBeNull();
    } finally {
      await test.close();
    }
  }, 60000);
  it("real persisted identity + session exchange works with fake Google/Microsoft; no upstream network", async () => {
    const test = await createDeviceTestDatabase();
    const f = await nativeFixture({
      authRepository: new PrismaAuthRepository(test.db),
      grants: new PrismaNativeGrantRepository(test.db)
    });
    try {
      for (const provider of ["GOOGLE", "MICROSOFT"] as const) {
        const verifier = random(),
          state = random();
        const start = await f.native.start(
          provider,
          state,
          pkceChallenge(verifier)
        );
        const upstream = new URL(start.authorizationUrl).searchParams.get(
          "state"
        )!;
        const callback = new URL(
          await f.native.callback(provider, upstream, start.binding, upstream)
        );
        const code = callback.searchParams.get("code")!;
        expect(typeof code).toBe("string");
        const result = await f.native.exchange(code, verifier, {});
        expect(
          (await f.auth.authenticate(result.sessionToken)).user.id ===
            result.user.id
        ).toBe(true);
        await expect(
          f.native.exchange(code, verifier, {})
        ).rejects.toMatchObject({ code: "NATIVE_GRANT_INVALID" });
      }
      expect(await test.db.session.count()).toBe(2);
      expect(
        await test.db.nativeLoginGrant.count({
          where: { consumedAt: { not: null } }
        })
      ).toBe(2);
    } finally {
      await f.app.close();
      await test.close();
    }
  }, 60000);
  it("expired, missing and soft-deleted-user grants fail closed without a session", async () => {
    const test = await createDeviceTestDatabase();
    try {
      const f = await seedLedgerFixture(test.db),
        repo = new PrismaNativeGrantRepository(test.db);
      const now = new Date(),
        challenge = pkceChallenge(random());
      const row = await test.db.nativeLoginGrant.create({
        data: {
          stateHash: hash(),
          bindingHash: hash(),
          provider: "GOOGLE",
          clientState: random(),
          codeChallenge: challenge,
          codeHash: hash(),
          userId: f.owner.id,
          expiresAt: new Date(now.getTime() + 600000),
          codeExpiresAt: now
        }
      });
      expect(await repo.consumeCode(row.codeHash!, challenge, now)).toBeNull();
      await test.db.nativeLoginGrant.update({
        where: { id: row.id },
        data: {
          codeExpiresAt: new Date(now.getTime() + 60000),
          userId: "00000000-0000-4000-8000-000000000099"
        }
      });
      expect(await repo.consumeCode(row.codeHash!, challenge, now)).toBeNull();
      const softDeleted = await test.db.nativeLoginGrant.create({
        data: {
          stateHash: hash(),
          bindingHash: hash(),
          provider: "GOOGLE",
          clientState: random(),
          codeChallenge: challenge,
          codeHash: hash(),
          userId: f.owner.id,
          expiresAt: new Date(now.getTime() + 600000),
          codeExpiresAt: new Date(now.getTime() + 60000)
        }
      });
      await test.db.user.update({
        where: { id: f.owner.id },
        data: { deletedAt: now }
      });
      expect(
        await repo.consumeCode(softDeleted.codeHash!, challenge, now)
      ).toBeNull();
      expect(await test.db.session.count()).toBe(0);
    } finally {
      await test.close();
    }
  }, 60000);
});
