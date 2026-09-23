import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import {
  assertTestDatabase,
  syntheticBody
} from "./fixtures/mail-ledger-harness.js";
import {
  jobApp,
  jobEnvelope,
  jobHeaders,
  jobPath,
  jobHarness,
  jobTopic,
  notification,
  seedJobFixture,
  jobCounts
} from "./fixtures/gmail-job-harness.js";

const postgres =
  process.env.RUN_PR03B_POSTGRES_TESTS === "true" ? describe : describe.skip;
let db: DatabaseClient, admin: Pool, pool: Pool, testUrl: string, name: string;
let created = false;
const children = new Set<ChildProcess>();
const logicalCounts = {
  ledger: 1,
  evaluation: 1,
  alert: 1,
  recipient: 2,
  audit: 1,
  outbox: 2
};
const emptyCounts = {
  ledger: 0,
  evaluation: 0,
  alert: 0,
  recipient: 0,
  audit: 0,
  outbox: 0
};
const queue = () => new PrismaGmailJobQueue(db, jobTopic);
const receipt = () => db.reliabilityJob.findFirstOrThrow();
async function expireNaturally(id: string) {
  for (let i = 0; i < 150; i++) {
    const r = await db.$queryRaw<
      Array<{ expired: boolean }>
    >`SELECT "leaseUntil" <= clock_timestamp() AS expired FROM reliability_jobs WHERE id=${id}::uuid`;
    if (r[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PR03b lease did not expire");
}
function child(phase: string, connectionId: string) {
  const p = fork(
    fileURLToPath(
      new URL("./fixtures/gmail-job-crash-child.ts", import.meta.url)
    ),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        DATABASE_URL: testUrl,
        PR03B_PHASE: phase,
        PR03B_CONNECTION_ID: connectionId
      }
    }
  );
  children.add(p);
  const message = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PR03b checkpoint timeout")),
      15000
    );
    p.once("message", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    p.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("PR03b premature child exit"));
    });
  });
  return { process: p, message, exited: once(p, "exit") };
}
postgres("PR03b durable Gmail intake: real PostgreSQL", () => {
  beforeAll(async () => {
    const value = process.env.DATABASE_URL ?? "";
    assertTestDatabase(value);
    admin = new Pool({ connectionString: value });
    name = `callnow_pr03b_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(value);
    url.pathname = `/${name}`;
    testUrl = url.toString();
    pool = new Pool({ connectionString: testUrl });
    db = createDatabaseClient(testUrl);
    const root = new URL("../prisma/migrations/", import.meta.url);
    for (const m of (await readdir(root)).filter((n) => /^\d/.test(n)).sort())
      await pool.query(
        await readFile(new URL(`${m}/migration.sql`, root), "utf8")
      );
    const version = Number(
      (
        await pool.query<{ server_version_num: string }>(
          "SHOW server_version_num"
        )
      ).rows[0]!.server_version_num
    );
    expect(version).toBeGreaterThanOrEqual(170000);
    expect(version).toBeLessThan(180000);
  }, 60000);
  beforeEach(async () => {
    await db.reliabilityJob.deleteMany();
  }); // Only this suite's newly-created synthetic DB.
  afterAll(async () => {
    for (const p of children)
      if (p.exitCode === null && p.signalCode === null) {
        const exited = once(p, "exit");
        p.kill("SIGKILL");
        await exited;
      }
    await db?.$disconnect();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin?.end();
  });

  it("100 sequential + 100 concurrent receipts: 1 durable job, then one legacy Alert and 2 recipient Outboxes", async () => {
    const f = await seedJobFixture(db),
      h = await jobHarness(db, f.connection.id),
      q = queue();
    const app = await jobApp(q, h.service);
    const request = () =>
      app.inject({
        method: "POST",
        url: jobPath,
        headers: jobHeaders,
        payload: jobEnvelope(f.authorization.email)
      });
    try {
      for (let i = 0; i < 100; i++)
        expect((await request()).statusCode).toBe(204);
      const responses = await Promise.all(Array.from({ length: 100 }, request));
      expect(responses.map((r) => r.statusCode)).toEqual(Array(100).fill(204));
      expect(await db.reliabilityJob.count()).toBe(1);
      expect(await receipt()).toMatchObject({ status: "READY", attempts: 0 });
      expect(h.calls.fetch).toBe(0);
      expect(await jobCounts(db, f.team.id)).toEqual(emptyCounts);
      expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
        "DONE"
      );
      expect(await jobCounts(db, f.team.id)).toEqual(logicalCounts);
      expect(h.calls.fetch).toBe(1);
      const done = await receipt();
      expect(done.status).toBe("DONE");
      await q.accept(notification(f.authorization.email));
      expect(await receipt()).toEqual(done); // No progress/targets/timestamps reset on redelivery.
      expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
        "IDLE"
      );
      const serialized = JSON.stringify(done.payload);
      for (const forbidden of [
        syntheticBody,
        f.authorization.email,
        "synthetic-encrypted-placeholder",
        "synthetic-only"
      ])
        expect(serialized).not.toContain(forbidden);
    } finally {
      await app.close();
    }
  }, 60000);

  it("real PostgreSQL read-only transaction failure before INSERT produces 503, never ACK", async () => {
    const f = await seedJobFixture(db),
      h = await jobHarness(db, f.connection.id);
    const readonlyUrl = new URL(testUrl);
    readonlyUrl.searchParams.set(
      "options",
      "-c default_transaction_read_only=on"
    );
    const readonlyDb = createDatabaseClient(readonlyUrl.toString());
    const app = await jobApp(
      new PrismaGmailJobQueue(readonlyDb, jobTopic),
      h.service
    );
    try {
      const r = await app.inject({
        method: "POST",
        url: jobPath,
        headers: jobHeaders,
        payload: jobEnvelope(f.authorization.email)
      });
      expect(r.statusCode).toBe(503);
      expect(r.json<{ error: { code: string } }>().error.code).toBe(
        "GMAIL_JOB_PERSIST_RETRY_REQUIRED"
      );
      expect(r.body).not.toContain("postgresql");
      expect(r.body).not.toContain("read-only");
      expect(await db.reliabilityJob.count()).toBe(0);
      expect(h.calls.fetch).toBe(0);
    } finally {
      await app.close();
      await readonlyDb.$disconnect();
    }
  });

  it.each(["missing", "audience", "service-account", "unverified", "expired"])(
    "rejects invalid OIDC %s before any durability",
    async (variant) => {
      const f = await seedJobFixture(db),
        h = await jobHarness(db, f.connection.id);
      const overrides =
        variant === "audience"
          ? { aud: "https://wrong.example" }
          : variant === "service-account"
            ? { email: "wrong@example.invalid" }
            : variant === "unverified"
              ? { email_verified: false }
              : variant === "expired"
                ? { exp: 1 }
                : {};
      const app = await jobApp(queue(), h.service, "durable", overrides);
      try {
        const r = await app.inject({
          method: "POST",
          url: jobPath,
          headers:
            variant === "missing"
              ? { "content-type": "application/json" }
              : jobHeaders,
          payload: jobEnvelope(f.authorization.email)
        });
        expect(r.statusCode).toBe(401);
        expect(await db.reliabilityJob.count()).toBe(0);
        expect(h.calls.fetch).toBe(0);
      } finally {
        await app.close();
      }
    }
  );
  it("rejects malformed envelope, enforces payload CHECK and collision guard", async () => {
    const f = await seedJobFixture(db),
      h = await jobHarness(db, f.connection.id),
      q = queue();
    const app = await jobApp(q, h.service);
    try {
      const r = await app.inject({
        method: "POST",
        url: jobPath,
        headers: jobHeaders,
        payload: { ...jobEnvelope(f.authorization.email), extra: true }
      });
      expect(r.statusCode).toBe(400);
      expect(await db.reliabilityJob.count()).toBe(0);
      await q.accept(notification(f.authorization.email));
      const original = await receipt();
      await expect(
        q.accept({ ...notification(f.authorization.email), historyId: "201" })
      ).rejects.toThrow("GMAIL_JOB_IDENTITY_COLLISION");
      await expect(
        db.$executeRaw`UPDATE reliability_jobs SET payload=payload || '{"body":"forbidden"}'::jsonb`
      ).rejects.toThrow();
      expect(await receipt()).toEqual(original);
    } finally {
      await app.close();
    }
  });
  it("different Pub/Sub IDs for the same history still produce one logical mail/Alert/recipient Outbox", async () => {
    const f = await seedJobFixture(db),
      h = await jobHarness(db, f.connection.id),
      q = queue();
    await q.accept(notification(f.authorization.email, "receipt-1"));
    await q.accept(notification(f.authorization.email, "receipt-2"));
    const worker = new GmailJobWorker(q, h.service, "durable");
    expect(await worker.runOnce()).toBe("DONE");
    expect(await worker.runOnce()).toBe("DONE");
    expect(h.calls.fetch).toBe(1);
    expect(await jobCounts(db, f.team.id)).toEqual(logicalCounts);
  });
  it.each(["PAUSED", "REAUTH_REQUIRED"] as const)(
    "%s target is held, never fetched or marked DONE",
    async (status) => {
      const f = await seedJobFixture(db),
        h = await jobHarness(db, f.connection.id),
        q = queue();
      await q.accept(notification(f.authorization.email));
      await db.mailConnection.update({
        where: { id: f.connection.id },
        data: { status }
      });
      expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
        "UNFINISHED"
      );
      const r = await receipt();
      expect(r).toMatchObject({
        status: "RETRY_WAIT",
        lastErrorCode: "GMAIL_JOB_TARGET_UNAVAILABLE",
        attempts: 1
      });
      expect(
        r.availableAt.getTime() - r.updatedAt.getTime()
      ).toBeGreaterThanOrEqual(990);
      expect(h.calls.fetch).toBe(0);
      expect(await jobCounts(db, f.team.id)).toEqual(emptyCounts);
    }
  );
  it("legacy successful return without committed cursor progress is RETRY_WAIT, not success", async () => {
    const f = await seedJobFixture(db),
      q = queue();
    await q.accept(notification(f.authorization.email));
    const service = {
      syncConnectionById: vi.fn().mockResolvedValue(undefined)
    };
    expect(await new GmailJobWorker(q, service, "durable").runOnce()).toBe(
      "UNFINISHED"
    );
    expect(await receipt()).toMatchObject({
      status: "RETRY_WAIT",
      lastErrorCode: "GMAIL_JOB_PROGRESS_UNCONFIRMED"
    });
  });

  it("frozen receipt targets are not expanded on redelivery; unavailable target does not starve another Team", async () => {
    const a = await seedJobFixture(db),
      b = await seedJobFixture(db),
      q = queue();
    await db.mailAuthorization.update({
      where: { id: b.authorization.id },
      data: { email: a.authorization.email }
    });
    await db.mailConnection.update({
      where: { id: a.connection.id },
      data: { status: "PAUSED" }
    });
    await q.accept(notification(a.authorization.email));
    const original = await receipt();
    const c = await seedJobFixture(db);
    await db.mailAuthorization.update({
      where: { id: c.authorization.id },
      data: { email: a.authorization.email }
    });
    await q.accept(notification(a.authorization.email));
    expect(await receipt()).toEqual(original);
    const h = await jobHarness(db, b.connection.id);
    expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
      "UNFINISHED"
    );
    expect(await jobCounts(db, a.team.id)).toEqual(emptyCounts);
    expect(await jobCounts(db, b.team.id)).toEqual(logicalCounts);
    expect(await jobCounts(db, c.team.id)).toEqual(emptyCounts);
    expect((await receipt()).status).toBe("RETRY_WAIT");
  });

  it("retry budget exhaustion is retained as BLOCKED, not silently ACK-as-processed or deleted", async () => {
    const f = await seedJobFixture(db),
      q = queue();
    await q.accept(notification(f.authorization.email));
    // Synthetic exhausted fixture; no real counters or clocks are reset.
    await db.reliabilityJob.update({
      where: { id: (await receipt()).id },
      data: { attempts: 10 }
    });
    const service = { syncConnectionById: vi.fn() };
    expect(await new GmailJobWorker(q, service, "durable").runOnce()).toBe(
      "UNFINISHED"
    );
    expect(service.syncConnectionById).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({
      status: "BLOCKED",
      attempts: 11,
      lastErrorCode: "GMAIL_JOB_RETRY_EXHAUSTED",
      finishedAt: null
    });
    expect(await q.claimOne()).toBeNull();
    expect(await db.reliabilityJob.count()).toBe(1);
  });

  it("unknown mailbox has an empty frozen receipt, no provider call, no invented delivery", async () => {
    const q = queue();
    await q.accept(notification("unknown@example.invalid"));
    const service = { syncConnectionById: vi.fn() };
    expect(await new GmailJobWorker(q, service, "durable").runOnce()).toBe(
      "DONE"
    );
    expect(service.syncConnectionById).not.toHaveBeenCalled();
    expect((await receipt()).payload).toMatchObject({ targets: [] });
  });

  it("worker OFF / aborted before claim leaves durable receipt untouched", async () => {
    const f = await seedJobFixture(db),
      q = queue();
    await q.accept(notification(f.authorization.email));
    const before = await receipt(),
      service = { syncConnectionById: vi.fn() };
    expect(await new GmailJobWorker(q, service).runOnce()).toBe("OFF");
    expect(
      await new GmailJobWorker(q, service, "durable").runOnce(
        AbortSignal.abort()
      )
    ).toBe("STOPPED");
    expect(await receipt()).toEqual(before);
    expect(service.syncConnectionById).not.toHaveBeenCalled();
  });
  it("rechecks current identity, authorization, Team and subscription without trusting payload scope", async () => {
    const f = await seedJobFixture(db),
      h = await jobHarness(db, f.connection.id),
      q = queue();
    const target = {
      connectionId: f.connection.id,
      mailboxId: f.authorization.id,
      teamId: f.team.id
    };
    expect(
      await q.targetState({ ...target, teamId: randomUUID() }, "200")
    ).toBe("UNAVAILABLE");
    expect(
      await q.targetState({ ...target, mailboxId: randomUUID() }, "200")
    ).toBe("UNAVAILABLE");
    await db.mailAuthorization.update({
      where: { id: f.authorization.id },
      data: { status: "REAUTH_REQUIRED" }
    });
    await q.accept(notification(f.authorization.email));
    expect(await new GmailJobWorker(q, h.service, "durable").runOnce()).toBe(
      "UNFINISHED"
    );
    expect(h.calls.fetch).toBe(0);
  });
  it("SKIP LOCKED allows one claimant; expired lease is recovered and old generation cannot finish", async () => {
    const f = await seedJobFixture(db),
      q = queue();
    await q.accept(notification(f.authorization.email));
    const claims = (
      await Promise.all(Array.from({ length: 20 }, () => q.claimOne(1000)))
    ).filter((c) => c !== null);
    expect(claims).toHaveLength(1);
    const old = claims[0]!;
    await expireNaturally(old.id);
    const next = await q.claimOne(30000);
    expect(next).not.toBeNull();
    expect(next!.leaseGeneration).toBe(old.leaseGeneration + 1n);
    expect(await q.finish(old)).toBe(false);
    expect(await q.finish(next!)).toBe(true);
    expect(await q.finish(next!)).toBe(false);
    expect((await receipt()).attempts).toBe(2);
  }, 10000);

  it.each([false, true])(
    "SIGKILL after commit before ACK; recover in new process (redelivery=%s)",
    async (redeliver) => {
      const f = await seedJobFixture(db);
      const killed = child("after-commit-before-ack", f.connection.id);
      expect(await killed.message).toEqual({
        checkpoint: "after-commit-before-ack"
      });
      expect(await db.reliabilityJob.count()).toBe(1);
      expect((await receipt()).status).toBe("READY");
      expect(await jobCounts(db, f.team.id)).toEqual(emptyCounts);
      killed.process.kill("SIGKILL");
      expect((await killed.exited)[1]).toBe("SIGKILL");
      if (redeliver) {
        const app = await jobApp(queue(), { processPushNotification: vi.fn() });
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
      }
      const restarted = child("resume", f.connection.id);
      expect(await restarted.message).toMatchObject({
        completed: "DONE",
        calls: { fetch: 1, alertsCreated: 1 }
      });
      expect((await restarted.exited)[0]).toBe(0);
      expect(await db.reliabilityJob.count()).toBe(1);
      expect((await receipt()).status).toBe("DONE");
      expect(await jobCounts(db, f.team.id)).toEqual(logicalCounts);
    },
    30000
  );
  it("SIGKILL after legacy commit before job finish: expired job replay creates no duplicate Alert/Outbox", async () => {
    const f = await seedJobFixture(db);
    await queue().accept(notification(f.authorization.email));
    const killed = child("after-processing-before-finish", f.connection.id);
    expect(await killed.message).toEqual({
      checkpoint: "after-processing-before-finish"
    });
    expect((await receipt()).status).toBe("RUNNING");
    expect(await jobCounts(db, f.team.id)).toEqual(logicalCounts);
    killed.process.kill("SIGKILL");
    expect((await killed.exited)[1]).toBe("SIGKILL");
    await expireNaturally((await receipt()).id);
    const restarted = child("resume", f.connection.id);
    expect(await restarted.message).toMatchObject({
      completed: "DONE",
      calls: { fetch: 0, alertsCreated: 0 }
    });
    expect((await restarted.exited)[0]).toBe(0);
    expect(await jobCounts(db, f.team.id)).toEqual(logicalCounts);
    expect((await receipt()).status).toBe("DONE");
  }, 30000);
});
