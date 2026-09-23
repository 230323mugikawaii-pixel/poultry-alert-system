import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { PrismaOutboxQueue } from "../src/modules/mail/reliability/prisma-outbox-queue.js";
import {
  FakeTransport,
  type OutboxTransport
} from "../src/modules/mail/reliability/outbox-transport.js";
import { OutboxDispatcher } from "../src/modules/mail/reliability/outbox-dispatcher.js";
import {
  assertTestDatabase,
  ledgerHarness,
  seedLedgerFixture
} from "./fixtures/mail-ledger-harness.js";

const postgres =
  process.env.RUN_PR03A_POSTGRES_TESTS === "true" ? describe : describe.skip;
const children = new Set<ChildProcess>();
let database: DatabaseClient;
let admin: Pool;
let pool: Pool;
let testUrl: string;
let name: string;
let created = false;

async function fixture(messages = 1, recipientCount = 1) {
  const f = await seedLedgerFixture(database);
  for (let i = 0; i < messages; i++)
    await (
      await ledgerHarness(database, f.connection.id, {
        mode: "legacy-outbox",
        messageId: `pr03a-${i}`
      })
    ).run();
  const all = await database.reliabilityOutbox.findMany({
    where: { teamId: f.team.id },
    orderBy: { id: "asc" }
  });
  const rows = all.slice(0, recipientCount);
  // Only synthetic fixtures in this suite's freshly-created DB. No live counters reset.
  await database.reliabilityOutbox.updateMany({
    where: { id: { in: all.slice(recipientCount).map((r) => r.id) } },
    data: { availableAt: new Date(Date.now() + 3600_000) }
  });
  return { ...f, rows };
}
async function row(id: string) {
  return database.reliabilityOutbox.findUniqueOrThrow({ where: { id } });
}
async function expireNaturally(id: string) {
  // Wait on DB's clock instead of changing leaseUntil to manufacture a reclaim.
  for (let i = 0; i < 150; i++) {
    const result = await database.$queryRaw<Array<{ expired: boolean }>>`
      SELECT "leaseUntil" <= clock_timestamp() AS expired FROM reliability_outbox WHERE id = ${id}::uuid
    `;
    if (result[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PR03a lease did not expire");
}
function child(phase: string) {
  const process = fork(
    fileURLToPath(
      new URL("./fixtures/outbox-dispatcher-crash-child.ts", import.meta.url)
    ),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...globalThis.process.env,
        DATABASE_URL: testUrl,
        PR03A_CRASH_PHASE: phase
      }
    }
  );
  children.add(process);
  const message = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PR03a child checkpoint timeout")),
      15_000
    );
    process.once("message", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    process.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("PR03a premature child exit"));
    });
  });
  return { process, message, exited: once(process, "exit") };
}

postgres("PR03a real PostgreSQL Outbox dispatcher", () => {
  beforeAll(async () => {
    const value = process.env.DATABASE_URL ?? "";
    assertTestDatabase(value);
    admin = new Pool({ connectionString: value });
    name = `callnow_pr03a_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(value);
    url.pathname = `/${name}`;
    testUrl = url.toString();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    pool = new Pool({ connectionString: testUrl });
    const root = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(root))
      .filter((x) => /^\d/.test(x))
      .sort();
    expect(migrations).toContain("20260923000200_reliability_outbox");
    for (const migration of migrations)
      await pool.query(
        await readFile(new URL(`${migration}/migration.sql`, root), "utf8")
      );
    await pool.query(
      'CREATE TABLE pr03a_fake_receipts ("eventKey" char(64) PRIMARY KEY)'
    );
    expect(
      Number(
        (
          await pool.query<{ server_version_num: string }>(
            "SHOW server_version_num"
          )
        ).rows[0]!.server_version_num
      )
    ).toBeGreaterThanOrEqual(170000);
    database = createDatabaseClient(testUrl);
  }, 60_000);
  beforeEach(async () => {
    // Explicitly scoped to the unique disposable DB created above; never shared DBs.
    if (!created || new URL(testUrl).pathname !== `/${name}`)
      throw new Error("PR03a isolation missing");
    await pool.query("TRUNCATE reliability_outbox, pr03a_fake_receipts");
  });
  afterAll(async () => {
    for (const process of children) {
      if (process.exitCode !== null || process.signalCode !== null) continue;
      const done = once(process, "exit");
      process.kill("SIGKILL");
      await done;
    }
    await database?.$disconnect();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin?.end();
  });

  it("100 workers claim 100 jobs exactly once; no omission or duplicate fake processing", async () => {
    const f = await fixture(50, 100);
    const seen: string[] = [];
    const transport: OutboxTransport = {
      mode: "fake",
      send: async (input) => {
        seen.push(input.eventKey);
        return { kind: "FAKE_COMPLETED" };
      }
    };
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        new OutboxDispatcher(new PrismaOutboxQueue(database), transport, {
          mode: "fake"
        }).runOnce()
      )
    );
    expect(results.every((r) => r === "DISPATCHED")).toBe(true);
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(
      await database.reliabilityOutbox.count({
        where: {
          status: "DISPATCHED",
          attempts: 1,
          leaseGeneration: 1n,
          leaseToken: null,
          leaseUntil: null
        }
      })
    ).toBe(100);
    expect(await new PrismaOutboxQueue(database).claimOne(45000)).toBeNull();
    expect(await database.alert.count({ where: { teamId: f.team.id } })).toBe(
      50
    );
    expect(
      await database.alertRecipient.count({
        where: { alert: { teamId: f.team.id } }
      })
    ).toBe(100);
    console.info(
      `PR03a parallel: 100 workers / 100 jobs, ${Math.round(performance.now() - start)}ms, dispatched=100 uniqueEventKeys=100 attemptsEach=1`
    );
  }, 60_000);

  it("100 workers contest one job: one fake call and one logical completion", async () => {
    await fixture();
    let calls = 0;
    const transport: OutboxTransport = {
      mode: "fake",
      send: async () => {
        calls++;
        return { kind: "FAKE_COMPLETED" };
      }
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        new OutboxDispatcher(new PrismaOutboxQueue(database), transport, {
          mode: "fake"
        }).runOnce()
      )
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r === "DISPATCHED")).toHaveLength(1);
    expect(results.filter((r) => r === "IDLE")).toHaveLength(99);
  });

  it("SKIP LOCKED takes the other row without waiting; locked row remains obtainable", async () => {
    const f = await fixture(1, 2);
    const locked = await pool.connect();
    try {
      await locked.query("BEGIN");
      await locked.query(
        "SELECT id FROM reliability_outbox WHERE id=$1 FOR UPDATE",
        [f.rows[0]!.id]
      );
      const queue = new PrismaOutboxQueue(database);
      const claim = await queue.claimOne(45_000);
      expect(claim?.id).toBe(f.rows[1]!.id);
      expect(await queue.claimOne(45_000)).toBeNull();
      await locked.query("ROLLBACK");
      expect((await queue.claimOne(45_000))?.id).toBe(f.rows[0]!.id);
    } finally {
      await locked.query("ROLLBACK");
      locked.release();
    }
  });

  it("expired lease is reclaimed; token/generation/expiry fence every result path", async () => {
    const f = await fixture();
    const q1 = new PrismaOutboxQueue(database),
      q2 = new PrismaOutboxQueue(database);
    const old = (await q1.claimOne(150))!;
    expect(await q2.claimOne(1000)).toBeNull();
    await expireNaturally(old.id);
    expect(await q1.finish(old, { status: "DISPATCHED" })).toBe(false);
    const next = (await q2.claimOne(3000))!;
    expect(next.id).toBe(old.id);
    expect(next.leaseGeneration).toBe(old.leaseGeneration + 1n);
    expect(next.leaseToken).not.toBe(old.leaseToken);
    expect(next.attempts).toBe(2);
    for (const outcome of [
      { status: "DISPATCHED" },
      { status: "BLOCKED", code: "FAKE_PERMANENT" },
      { status: "RETRY_WAIT", code: "FAKE_TRANSIENT", delayMs: 1000 }
    ] as const)
      expect(await q1.finish(old, outcome)).toBe(false);
    expect(
      await q2.finish(
        { ...next, leaseGeneration: old.leaseGeneration },
        { status: "DISPATCHED" }
      )
    ).toBe(false);
    expect(
      await q2.finish(
        { ...next, leaseToken: old.leaseToken },
        { status: "DISPATCHED" }
      )
    ).toBe(false);
    expect(await q2.finish(next, { status: "DISPATCHED" })).toBe(true);
    const finished = await row(f.rows[0]!.id);
    expect(await q2.finish(next, { status: "DISPATCHED" })).toBe(false);
    expect(await row(finished.id)).toEqual(finished);
  });

  it("lease expiring while finish waits for a row lock is rejected", async () => {
    await fixture();
    const queue = new PrismaOutboxQueue(database);
    const claim = (await queue.claimOne(250))!;
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        "SELECT id FROM reliability_outbox WHERE id=$1 FOR UPDATE",
        [claim.id]
      );
      const finish = queue.finish(claim, { status: "DISPATCHED" });
      await expireNaturally(claim.id);
      await lock.query("ROLLBACK");
      expect(await finish).toBe(false);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });

  it("transient failures use DB-clock exponential backoff; permanent failure remains BLOCKED", async () => {
    await fixture();
    const queue = new PrismaOutboxQueue(database);
    const transport: OutboxTransport = {
      mode: "fake",
      send: async () => ({ kind: "RETRY", code: "FAKE_TRANSIENT" })
    };
    const worker = new OutboxDispatcher(queue, transport, { mode: "fake" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = (
        await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")
      ).rows[0]!.t;
      expect(await worker.runOnce()).toBe("RETRY_WAIT");
      const saved = await database.reliabilityOutbox.findFirstOrThrow({
        where: { status: "RETRY_WAIT" }
      });
      const after = (
        await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")
      ).rows[0]!.t;
      const interval = 1000 * 2 ** (attempt - 1);
      expect(saved.availableAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime() + interval - 2
      );
      expect(saved.availableAt.getTime()).toBeLessThanOrEqual(
        after.getTime() + interval + 2
      );
      expect(saved.attempts).toBe(attempt);
      expect(saved.leaseToken).toBeNull();
      expect(saved.dispatchedAt).toBeNull();
      expect(await worker.runOnce()).toBe("IDLE");
      // Natural time progression; no manual counter/availableAt rewrite.
      await new Promise((resolve) => setTimeout(resolve, interval + 25));
    }
    const permanent: OutboxTransport = {
      mode: "fake",
      send: async () => ({ kind: "PERMANENT", code: "FAKE_PERMANENT" })
    };
    expect(
      await new OutboxDispatcher(queue, permanent, { mode: "fake" }).runOnce()
    ).toBe("BLOCKED");
    expect(
      await database.reliabilityOutbox.findFirst({
        where: { status: "BLOCKED" }
      })
    ).toMatchObject({
      attempts: 3,
      lastErrorCode: "FAKE_PERMANENT",
      dispatchedAt: null
    });
    expect(await queue.claimOne(1000)).toBeNull();
  }, 15_000);

  it.each(["during-send", "after-fake"])(
    "real SIGKILL %s: recover lease and preserve one logical fake receipt/completion",
    async (phase) => {
      const f = await fixture();
      const first = child(phase);
      expect(await first.message).toEqual({
        checkpoint: phase,
        id: f.rows[0]!.id
      });
      const claimed = await row(f.rows[0]!.id);
      expect(claimed).toMatchObject({
        status: "RUNNING",
        attempts: 1,
        leaseGeneration: 1n,
        dispatchedAt: null
      });
      expect(
        Number(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*) FROM pr03a_fake_receipts"
            )
          ).rows[0]!.count
        )
      ).toBe(phase === "after-fake" ? 1 : 0);
      expect(first.process.kill("SIGKILL")).toBe(true);
      expect((await first.exited)[1]).toBe("SIGKILL");
      children.delete(first.process);
      await expireNaturally(claimed.id);
      const next = child("resume");
      expect(await next.message).toEqual({
        completed: true,
        result: "DISPATCHED"
      });
      expect((await next.exited)[0]).toBe(0);
      children.delete(next.process);
      expect(await row(claimed.id)).toMatchObject({
        status: "DISPATCHED",
        attempts: 2,
        leaseGeneration: 2n,
        leaseToken: null,
        leaseUntil: null
      });
      expect(
        Number(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*) FROM pr03a_fake_receipts"
            )
          ).rows[0]!.count
        )
      ).toBe(1);
      expect(
        await new PrismaOutboxQueue(database).finish(
          {
            id: claimed.id,
            eventKey: claimed.eventKey,
            leaseToken: claimed.leaseToken!,
            leaseGeneration: 1n,
            attempts: 1
          },
          { status: "DISPATCHED" }
        )
      ).toBe(false);
      const again = child("resume");
      expect(await again.message).toEqual({ completed: true, result: "IDLE" });
      expect((await again.exited)[0]).toBe(0);
      children.delete(again.process);
    },
    20_000
  );

  it("database-only finish retry never repeats the transport and no transaction is held across send", async () => {
    const f = await fixture();
    let queriesOpen = 0,
      sendCount = 0,
      injected = false;
    const observed = new Proxy(database, {
      get(target, key, receiver) {
        if (key === "$transaction")
          return async (
            body: Parameters<DatabaseClient["$transaction"]>[0]
          ) => {
            queriesOpen++;
            try {
              if (!injected) {
                injected = true;
                throw Object.assign(new Error("synthetic retry"), {
                  code: "P2034"
                });
              }
              return await target.$transaction(body);
            } finally {
              queriesOpen--;
            }
          };
        if (key !== "$queryRaw")
          return Reflect.get(target, key, receiver) as unknown;
        return async (...args: Parameters<DatabaseClient["$queryRaw"]>) => {
          queriesOpen++;
          try {
            return await target.$queryRaw(...args);
          } finally {
            queriesOpen--;
          }
        };
      }
    });
    const transport: OutboxTransport = {
      mode: "fake",
      send: async () => {
        sendCount++;
        expect(queriesOpen).toBe(0);
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT id FROM reliability_outbox WHERE id=$1 FOR UPDATE NOWAIT",
            [f.rows[0]!.id]
          );
          await connection.query("ROLLBACK");
        } finally {
          connection.release();
        }
        return { kind: "FAKE_COMPLETED" };
      }
    };
    expect(
      await new OutboxDispatcher(new PrismaOutboxQueue(observed), transport, {
        mode: "fake"
      }).runOnce()
    ).toBe("DISPATCHED");
    expect(injected).toBe(true);
    expect(sendCount).toBe(1);
  });

  it.each(["member", "owner", "team", "subscription"])(
    "rechecks %s eligibility; no transport for ineligible recipient and no history mutation",
    async (which) => {
      const f = await fixture(1, 2);
      if (which === "member")
        await database.notificationMember.update({
          where: { id: f.member.id },
          data: { status: "DISABLED" }
        });
      if (which === "owner")
        await database.teamMembership.updateMany({
          where: { teamId: f.team.id },
          data: { status: "LEFT", leftAt: new Date() }
        });
      if (which === "team")
        await database.team.update({
          where: { id: f.team.id },
          data: { status: "SUSPENDED" }
        });
      if (which === "subscription")
        await database.subscription.update({
          where: { teamId: f.team.id },
          data: { status: "PAST_DUE" }
        });
      const before = await database.alertRecipient.findMany({
        where: { alert: { teamId: f.team.id } },
        orderBy: { id: "asc" }
      });
      let sends = 0;
      const transport: OutboxTransport = {
        mode: "fake",
        send: async () => {
          sends++;
          return { kind: "FAKE_COMPLETED" };
        }
      };
      const w = new OutboxDispatcher(
        new PrismaOutboxQueue(database),
        transport,
        { mode: "fake" }
      );
      await w.runOnce();
      await w.runOnce();
      const expected = ["member", "owner"].includes(which) ? 1 : 0;
      expect(sends).toBe(expected);
      expect(
        await database.reliabilityOutbox.count({
          where: { status: "BLOCKED", lastErrorCode: "RECIPIENT_INELIGIBLE" }
        })
      ).toBe(2 - expected);
      expect(
        await database.alertRecipient.findMany({
          where: { alert: { teamId: f.team.id } },
          orderBy: { id: "asc" }
        })
      ).toEqual(before);
    }
  );

  it("flag off leaves rows untouched; fixed payload CHECK remains enforced", async () => {
    const f = await fixture();
    const before = await row(f.rows[0]!.id);
    expect(
      await new OutboxDispatcher(
        new PrismaOutboxQueue(database),
        new FakeTransport()
      ).runOnce()
    ).toBe("OFF");
    expect(await row(before.id)).toEqual(before);
    await expect(
      database.reliabilityOutbox.update({
        where: { id: before.id },
        data: { payload: { arbitrary: "forbidden" } }
      })
    ).rejects.toThrow();
    expect(await row(before.id)).toEqual(before);
  });
});
