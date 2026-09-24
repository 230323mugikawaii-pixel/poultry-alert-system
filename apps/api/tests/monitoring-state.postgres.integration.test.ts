import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MonitoringStateService } from "../src/modules/mail/reliability/monitoring-state-service.js";
import { monitoringStateReference } from "../src/modules/mail/reliability/monitoring-state-reference.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import { PrismaGmailJobQueue } from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import {
  seedJobFixture,
  jobHarness,
  jobTopic,
  notification,
  jobCounts
} from "./fixtures/gmail-job-harness.js";
import {
  monitoringTestDatabase,
  priorSnapshot
} from "./fixtures/monitoring-test-database.js";

const postgres =
  process.env.RUN_PR04_POSTGRES_TESTS === "true" ? describe : describe.skip;
let database: Awaited<ReturnType<typeof monitoringTestDatabase>>;
const at = (ms: number) => new Date(Date.UTC(2030, 0, 1) + ms);
async function fixture() {
  const f = await seedJobFixture(database.db);
  const scope = {
    teamId: f.team.id,
    mailboxId: f.authorization.id,
    connectionId: f.connection.id
  };
  const service = new MonitoringStateService(database.db, "shadow");
  const state = () =>
    database.db.monitoringState.findUniqueOrThrow({
      where: { connectionId: scope.connectionId }
    });
  const epochs = () =>
    database.db.monitoringEpoch.findMany({
      where: { connectionId: scope.connectionId },
      orderBy: { revision: "asc" }
    });
  return { ...f, scope, service, state, epochs };
}
postgres("PR04 state and epoch: real PostgreSQL", () => {
  beforeAll(async () => {
    database = await monitoringTestDatabase();
    const v = Number(
      (
        await database.pool.query<{ server_version_num: string }>(
          "SHOW server_version_num"
        )
      ).rows[0]!.server_version_num
    );
    expect(v).toBeGreaterThanOrEqual(170000);
    expect(v).toBeLessThan(180000);
  }, 60000);
  afterAll(async () => {
    await database?.close();
  });

  it.each(["INVALID_GRANT", "HTTP_401"] as const)(
    "%s changes observed only; reauthorization preserves the same open epoch",
    async (reason) => {
      const f = await fixture();
      await f.service.setDesired({
        ...f.scope,
        desired: "RUNNING",
        expectedGeneration: 0n,
        at: at(0)
      });
      const before = await f.epochs();
      expect(
        await f.service.observe({
          ...f.scope,
          expectedGeneration: 1n,
          at: at(10),
          observation: { kind: "AUTH_FAILURE", reason }
        })
      ).toMatchObject({
        kind: "APPLIED",
        state: { desired: "RUNNING", observed: "AUTH_REQUIRED", generation: 2n }
      });
      expect(await f.epochs()).toEqual(before);
      expect(
        await f.service.observe({
          ...f.scope,
          expectedGeneration: 2n,
          at: at(20),
          observation: { kind: "OAUTH_RECOVERED" }
        })
      ).toMatchObject({
        kind: "APPLIED",
        state: {
          desired: "RUNNING",
          observed: "UNKNOWN",
          generation: 3n,
          lastErrorCode: null
        }
      });
      expect(await f.epochs()).toEqual(before);
      expect(await f.service.classifyReceivedAt(f.scope, at(15))).toMatchObject(
        { kind: "IN_EPOCH", revision: 1 }
      );
      expect((await f.state()).coverageKnownFrom).toBeNull();
      // Old credential/connection status is not rewritten by the new state model.
      expect(
        await database.db.mailAuthorization.findUniqueOrThrow({
          where: { id: f.authorization.id }
        })
      ).toMatchObject({ status: "ACTIVE" });
      expect(
        await database.db.mailConnection.findUniqueOrThrow({
          where: { id: f.connection.id }
        })
      ).toEqual(f.connection);
    }
  );

  it("pause gap remains excluded after resume; [start,end) and resume boundary are correct at +/-1ms", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(100)
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "PAUSED",
      expectedGeneration: 1n,
      at: at(200)
    });
    for (const ms of [200, 201, 250, 299])
      expect(await f.service.classifyReceivedAt(f.scope, at(ms))).toEqual({
        kind: "OUTSIDE_EPOCH"
      });
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 2n,
      at: at(300)
    });
    expect(await f.service.classifyReceivedAt(f.scope, at(99))).toEqual({
      kind: "UNKNOWN"
    });
    for (const ms of [100, 101, 199])
      expect(await f.service.classifyReceivedAt(f.scope, at(ms))).toMatchObject(
        { kind: "IN_EPOCH", revision: 1 }
      );
    for (const ms of [200, 201, 250, 299])
      expect(await f.service.classifyReceivedAt(f.scope, at(ms))).toEqual({
        kind: "OUTSIDE_EPOCH"
      });
    for (const ms of [300, 301])
      expect(await f.service.classifyReceivedAt(f.scope, at(ms))).toMatchObject(
        { kind: "IN_EPOCH", revision: 2 }
      );
    const epochs = await f.epochs();
    expect(
      epochs.map((e) => [e.revision, e.startedAt, e.endedAt, e.closeReason])
    ).toEqual([
      [1, at(100), at(200), "USER_PAUSED"],
      [2, at(300), null, null]
    ]);
  });

  it("only explicit user intent creates epochs; repeated start does not split interval or reset snapshot", async () => {
    const f = await fixture();
    expect(
      await f.service.observe({
        ...f.scope,
        expectedGeneration: 0n,
        observation: { kind: "OAUTH_RECOVERED" },
        at: at(0)
      })
    ).toEqual({ kind: "MISSING" });
    expect(await f.service.read(f.scope)).toEqual({ kind: "MISSING" });
    expect(await f.epochs()).toEqual([]);
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(10)
    });
    const first = (await f.epochs())[0]!;
    expect(first).toMatchObject({
      keywordsSnapshot: ["停電"],
      boundaryCursor: "100",
      matcherVersion: "existing-matcher-v1",
      revision: 1
    });
    expect(
      await f.service.setDesired({
        ...f.scope,
        desired: "RUNNING",
        expectedGeneration: 1n,
        at: at(20)
      })
    ).toMatchObject({ kind: "UNCHANGED", state: { generation: 1n } });
    await database.db.mailConnection.update({
      where: { id: f.connection.id },
      data: { keywords: ["new-synthetic-rule"] }
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "PAUSED",
      expectedGeneration: 1n,
      at: at(30)
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 2n,
      at: at(40)
    });
    const epochs = await f.epochs();
    expect(epochs[0]!.keywordsSnapshot).toEqual(["停電"]);
    expect(epochs[1]!.keywordsSnapshot).toEqual(["new-synthetic-rule"]);
  });

  it.each(["PAUSED", "DISCONNECTED"] as const)(
    "auth failure/recovery never changes desired %s or opens an epoch",
    async (desired) => {
      const f = await fixture();
      await f.service.setDesired({
        ...f.scope,
        desired: "RUNNING",
        expectedGeneration: 0n,
        at: at(0)
      });
      await f.service.setDesired({
        ...f.scope,
        desired,
        expectedGeneration: 1n,
        at: at(10)
      });
      const epochs = await f.epochs();
      await f.service.observe({
        ...f.scope,
        expectedGeneration: 2n,
        at: at(20),
        observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
      });
      await f.service.observe({
        ...f.scope,
        expectedGeneration: 3n,
        at: at(30),
        observation: { kind: "OAUTH_RECOVERED" }
      });
      expect(await f.state()).toMatchObject({
        desired,
        observed: "UNKNOWN",
        generation: 4n
      });
      expect(await f.epochs()).toEqual(epochs);
      expect(await f.service.classifyReceivedAt(f.scope, at(15))).toEqual({
        kind: "OUTSIDE_EPOCH"
      });
    }
  );

  it("recovery observation preserves earliest unresolved point and never changes cursor or epochs", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(0)
    });
    const epochs = await f.epochs();
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 1n,
      at: at(100),
      observation: { kind: "RECOVERING", recoveryFrom: at(20) }
    });
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 2n,
      at: at(110),
      observation: { kind: "RECOVERING", recoveryFrom: at(30) }
    });
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 3n,
      at: at(120),
      observation: { kind: "AUTH_FAILURE", reason: "HTTP_401" }
    });
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 4n,
      at: at(130),
      observation: { kind: "OAUTH_RECOVERED" }
    });
    expect(await f.state()).toMatchObject({
      desired: "RUNNING",
      observed: "UNKNOWN",
      recoveryFrom: at(20),
      coverageKnownFrom: null
    });
    expect(await f.epochs()).toEqual(epochs);
    expect(
      (
        await database.db.mailConnection.findUniqueOrThrow({
          where: { id: f.connection.id }
        })
      ).providerCursor
    ).toBe("100");
  });

  it("missing-state stale command cannot initialize; explicit initial pause keeps safe defaults and no guessed coverage", async () => {
    const f = await fixture();
    expect(
      await f.service.setDesired({
        ...f.scope,
        desired: "RUNNING",
        expectedGeneration: 9n,
        at: at(0)
      })
    ).toEqual({ kind: "STALE" });
    expect(await f.service.read(f.scope)).toEqual({ kind: "MISSING" });
    expect(
      await f.service.setDesired({
        ...f.scope,
        desired: "PAUSED",
        expectedGeneration: 0n,
        at: at(0)
      })
    ).toMatchObject({
      kind: "UNCHANGED",
      state: {
        desired: "PAUSED",
        observed: "UNKNOWN",
        generation: 0n,
        ingestionOwner: "LEGACY",
        shadowEnabled: false,
        coverageKnownFrom: null,
        recoveryFrom: null,
        checkedAt: null
      }
    });
    expect(await f.epochs()).toEqual([]);
  });

  it("HEALTHY/DEGRADED/UNKNOWN are observations only; invalid clocks are rejected without mutations", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(0)
    });
    const epochs = await f.epochs();
    for (const [i, kind] of (
      ["HEALTHY", "DEGRADED", "UNKNOWN"] as const
    ).entries()) {
      expect(
        await f.service.observe({
          ...f.scope,
          expectedGeneration: BigInt(i + 1),
          at: at(i + 1),
          observation: { kind }
        })
      ).toMatchObject({
        kind: "APPLIED",
        state: { desired: "RUNNING", observed: kind }
      });
    }
    const before = await f.state();
    await expect(
      f.service.observe({
        ...f.scope,
        expectedGeneration: 4n,
        at: at(10),
        observation: { kind: "RECOVERING", recoveryFrom: at(11) }
      })
    ).rejects.toThrow("MONITORING_RECOVERY_TIME_INVALID");
    await expect(
      f.service.setDesired({
        ...f.scope,
        expectedGeneration: 4n,
        at: new Date(NaN),
        desired: "PAUSED"
      })
    ).rejects.toThrow("MONITORING_TIME_INVALID");
    expect(await f.state()).toEqual(before);
    expect(await f.epochs()).toEqual(epochs);
  });

  it("concurrent 100 starts and 100 resumes: one winner, one epoch/revision, monotonic generation", async () => {
    const f = await fixture();
    const starts = await Promise.all(
      Array.from({ length: 100 }, () =>
        f.service.setDesired({
          ...f.scope,
          desired: "RUNNING",
          expectedGeneration: 0n,
          at: at(0)
        })
      )
    );
    expect(starts.filter((r) => r.kind === "APPLIED")).toHaveLength(1);
    expect(starts.filter((r) => r.kind === "STALE")).toHaveLength(99);
    await f.service.setDesired({
      ...f.scope,
      desired: "PAUSED",
      expectedGeneration: 1n,
      at: at(10)
    });
    const resumes = await Promise.all(
      Array.from({ length: 100 }, () =>
        f.service.setDesired({
          ...f.scope,
          desired: "RUNNING",
          expectedGeneration: 2n,
          at: at(20)
        })
      )
    );
    expect(resumes.filter((r) => r.kind === "APPLIED")).toHaveLength(1);
    expect(resumes.filter((r) => r.kind === "STALE")).toHaveLength(99);
    expect((await f.state()).generation).toBe(3n);
    expect((await f.epochs()).map((e) => e.revision)).toEqual([1, 2]);
    expect((await f.epochs()).filter((e) => e.endedAt === null)).toHaveLength(
      1
    );
  }, 30000);

  it("competing user pause and auth failure fence each other; stale failure cannot overwrite OAuth recovery", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(0)
    });
    const outcomes = await Promise.all([
      f.service.setDesired({
        ...f.scope,
        desired: "PAUSED",
        expectedGeneration: 1n,
        at: at(10)
      }),
      f.service.observe({
        ...f.scope,
        expectedGeneration: 1n,
        at: at(10),
        observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
      })
    ]);
    expect(outcomes.filter((r) => r.kind === "APPLIED")).toHaveLength(1);
    expect(outcomes.filter((r) => r.kind === "STALE")).toHaveLength(1);
    if ((await f.state()).desired === "RUNNING")
      await f.service.setDesired({
        ...f.scope,
        desired: "PAUSED",
        expectedGeneration: 2n,
        at: at(20)
      });
    else
      await f.service.observe({
        ...f.scope,
        expectedGeneration: 2n,
        at: at(20),
        observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
      });
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 3n,
      at: at(30),
      observation: { kind: "OAUTH_RECOVERED" }
    });
    const before = await f.state();
    expect(
      await f.service.observe({
        ...f.scope,
        expectedGeneration: 2n,
        at: at(40),
        observation: { kind: "AUTH_FAILURE", reason: "HTTP_401" }
      })
    ).toEqual({ kind: "STALE" });
    expect(await f.state()).toEqual(before);
    expect(before).toMatchObject({
      desired: "PAUSED",
      observed: "UNKNOWN",
      generation: 4n
    });
    expect((await f.epochs())[0]!.endedAt).not.toBeNull();
  });

  it("rejects backdated transitions/observations, invalid intervals, duplicate revision and second open epoch", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(100)
    });
    const before = await f.state(),
      epochs = await f.epochs();
    await expect(
      f.service.setDesired({
        ...f.scope,
        desired: "PAUSED",
        expectedGeneration: 1n,
        at: at(99)
      })
    ).rejects.toThrow("MONITORING_TIME_REGRESSION");
    await expect(
      f.service.observe({
        ...f.scope,
        expectedGeneration: 1n,
        at: at(99),
        observation: { kind: "HEALTHY" }
      })
    ).rejects.toThrow("MONITORING_TIME_REGRESSION");
    await expect(
      database.db.monitoringEpoch.update({
        where: { id: epochs[0]!.id },
        data: { endedAt: at(99) }
      })
    ).rejects.toThrow();
    const data = {
      connectionId: f.connection.id,
      revision: 2,
      startedAt: at(200),
      matcherVersion: "test"
    };
    await expect(
      database.db.monitoringEpoch.create({ data })
    ).rejects.toThrow();
    await expect(
      database.db.monitoringEpoch.create({
        data: { ...data, revision: 1, endedAt: at(201) }
      })
    ).rejects.toThrow();
    await expect(
      database.db.monitoringState.update({
        where: { connectionId: f.connection.id },
        data: { generation: -1n }
      })
    ).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect(await f.epochs()).toEqual(epochs);
  });

  it("empty [t,t) interval excludes t; same-ms explicit resume belongs only to next revision", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(0)
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "PAUSED",
      expectedGeneration: 1n,
      at: at(0)
    });
    expect(await f.service.classifyReceivedAt(f.scope, at(0))).toEqual({
      kind: "OUTSIDE_EPOCH"
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 2n,
      at: at(0)
    });
    expect(await f.service.classifyReceivedAt(f.scope, at(0))).toMatchObject({
      kind: "IN_EPOCH",
      revision: 2
    });
  });

  it("Team/mailbox mismatch cannot read or mutate another connection", async () => {
    const f = await fixture();
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n,
      at: at(0)
    });
    const before = await f.state();
    for (const scope of [
      { ...f.scope, teamId: randomUUID() },
      { ...f.scope, mailboxId: randomUUID() }
    ]) {
      expect(await f.service.read(scope)).toEqual({ kind: "MISSING" });
      expect(await f.service.classifyReceivedAt(scope, at(1))).toEqual({
        kind: "UNKNOWN"
      });
      await expect(
        f.service.setDesired({
          ...scope,
          desired: "PAUSED",
          expectedGeneration: 1n,
          at: at(10)
        })
      ).rejects.toThrow("MONITORING_SCOPE_NOT_FOUND");
      await expect(
        f.service.observe({
          ...scope,
          expectedGeneration: 1n,
          at: at(10),
          observation: { kind: "HEALTHY" }
        })
      ).rejects.toThrow("MONITORING_SCOPE_NOT_FOUND");
    }
    expect(await f.state()).toEqual(before);
  });

  it("all state changes leave existing tables/data untouched; no implicit legacy backfill", async () => {
    const f = await fixture();
    const tables = (await priorSnapshot(database.pool)).tables.filter(
      (t) => !["monitoring_states", "monitoring_epochs"].includes(t)
    );
    const before = await priorSnapshot(database.pool, tables);
    expect(await f.service.classifyReceivedAt(f.scope, at(0))).toEqual({
      kind: "UNKNOWN"
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "RUNNING",
      expectedGeneration: 0n
    });
    const epoch = (await f.epochs())[0]!;
    expect(epoch.startedAt.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 1n,
      observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
    });
    await f.service.observe({
      ...f.scope,
      expectedGeneration: 2n,
      observation: { kind: "OAUTH_RECOVERED" }
    });
    await f.service.setDesired({
      ...f.scope,
      desired: "DISCONNECTED",
      expectedGeneration: 3n
    });
    expect(await priorSnapshot(database.pool, tables)).toEqual(before);
  });

  it.each(["off", "shadow"] as const)(
    "worker %s reference does not gate or replace legacy decisions",
    async (mode) => {
      const f = await fixture(),
        q = new PrismaGmailJobQueue(database.db, jobTopic),
        h = await jobHarness(database.db, f.connection.id);
      // Shadow deliberately disagrees with the ACTIVE legacy connection: read-only, no cutover.
      await f.service.setDesired({
        ...f.scope,
        desired: "DISCONNECTED",
        expectedGeneration: 0n,
        at: at(0)
      });
      const before = await f.state(),
        report = vi.fn();
      await q.accept(notification(f.authorization.email, randomUUID()));
      expect(
        await new GmailJobWorker(
          q,
          h.service,
          "durable",
          120000,
          monitoringStateReference(database.db, mode, report)
        ).runOnce()
      ).toBe("DONE");
      expect(await jobCounts(database.db, f.team.id)).toEqual({
        ledger: 1,
        evaluation: 1,
        alert: 1,
        recipient: 2,
        audit: 1,
        outbox: 2
      });
      expect(await f.state()).toEqual(before);
      expect(await f.epochs()).toEqual([]);
      if (mode === "off") expect(report).not.toHaveBeenCalled();
      else
        expect(report).toHaveBeenCalledExactlyOnceWith({
          kind: "STATE",
          desired: "DISCONNECTED",
          observed: "UNKNOWN",
          generation: "1"
        });
    }
  );

  it("failing shadow observer cannot change old job outcome", async () => {
    const f = await fixture(),
      q = new PrismaGmailJobQueue(database.db, jobTopic),
      h = await jobHarness(database.db, f.connection.id);
    await q.accept(notification(f.authorization.email, randomUUID()));
    expect(
      await new GmailJobWorker(q, h.service, "durable", 120000, async () => {
        throw new Error("synthetic shadow unavailable");
      }).runOnce()
    ).toBe("DONE");
    expect(await jobCounts(database.db, f.team.id)).toMatchObject({
      alert: 1,
      outbox: 2
    });
    expect(await f.service.read(f.scope)).toEqual({ kind: "MISSING" });
  });
});
