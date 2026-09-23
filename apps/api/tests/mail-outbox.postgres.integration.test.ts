import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import {
  PrismaAtomicMailIngestion,
  alertOutboxKey
} from "../src/modules/mail/reliability/prisma-atomic-mail-ingestion.js";
import { PrismaMailLedger } from "../src/modules/mail/reliability/prisma-mail-ledger.js";
import { PrismaAlertRepository } from "../src/modules/alerts/prisma-alert-repository.js";
import {
  assertTestDatabase,
  fixtureNow,
  ledgerHarness,
  seedLedgerFixture,
  syntheticBody
} from "./fixtures/mail-ledger-harness.js";
import { atomicTestDatabase } from "./fixtures/atomic-mail-test-database.js";

const postgres =
  process.env.RUN_PR02B_POSTGRES_TESTS === "true" ? describe : describe.skip;
const children = new Set<ChildProcess>();
let database: DatabaseClient;

async function counts(teamId: string) {
  return {
    ledger: await database.mailMessageLedger.count({ where: { teamId } }),
    evaluation: await database.mailEvaluation.count({
      where: { message: { teamId } }
    }),
    matched: await database.mailEvaluation.count({
      where: { message: { teamId }, state: "MATCHED" }
    }),
    alerts: await database.alert.count({ where: { teamId } }),
    recipients: await database.alertRecipient.count({
      where: { alert: { teamId } }
    }),
    outbox: await database.reliabilityOutbox.count({ where: { teamId } }),
    audit: await database.auditEvent.count({
      where: { teamId, action: "ALERT_CREATED" }
    })
  };
}
async function expectMatched(teamId: string) {
  expect(await counts(teamId)).toEqual({
    ledger: 1,
    evaluation: 1,
    matched: 1,
    alerts: 1,
    recipients: 2,
    outbox: 2,
    audit: 1
  });
  const message = await database.mailMessageLedger.findFirstOrThrow({
    where: { teamId }
  });
  const rows = await database.reliabilityOutbox.findMany({ where: { teamId } });
  expect(new Set(rows.map((row) => row.recipientId)).size).toBe(2);
  for (const row of rows) {
    expect(row).toMatchObject({
      alertId: message.alertId,
      kind: "ALERT_AVAILABLE",
      status: "PENDING",
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
      dispatchedAt: null,
      payload: { schemaVersion: 1 }
    });
    expect(row.eventKey).toBe(
      alertOutboxKey(message.messageKey, row.recipientId!)
    );
  }
  expect(
    JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value
    )
  ).not.toContain(syntheticBody);
}

function startChild(connectionId: string, phase: string, missing = false) {
  const child = fork(
    fileURLToPath(
      new URL("./fixtures/mail-outbox-crash-child.ts", import.meta.url)
    ),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        PR02B_CONNECTION_ID: connectionId,
        PR02B_CRASH_PHASE: phase,
        PR02B_RETRY_MESSAGE_MISSING: String(missing)
      }
    }
  );
  children.add(child);
  const message = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("PR02b child checkpoint timeout")),
      15_000
    );
    child.once("message", (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("PR02b premature child exit"));
    });
  });
  const exited = once(child, "exit");
  return { child, message, exited };
}

postgres("PR02b real PostgreSQL atomic mail persistence", () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    assertTestDatabase(url);
    database = createDatabaseClient(url);
    const version = await database.$queryRaw<
      Array<{ version: number }>
    >`SELECT current_setting('server_version_num')::int AS version`;
    expect(version[0]!.version).toBeGreaterThanOrEqual(170000);
    expect(version[0]!.version).toBeLessThan(180000);
  });
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await database?.$disconnect();
  });

  it.each([false, true])(
    "100 deliveries (parallel=%s) reserve exactly one Outbox per original recipient",
    async (parallel) => {
      const f = await seedLedgerFixture(database);
      const h = await ledgerHarness(database, f.connection.id, {
        mode: "legacy-outbox"
      });
      const started = performance.now();
      if (parallel)
        await Promise.all(Array.from({ length: 100 }, () => h.run()));
      else for (let i = 0; i < 100; i++) await h.run();
      await expectMatched(f.team.id);
      expect(h.calls.alertsCreated).toBe(1);
      expect(h.calls.sseWakeups).toBe(1);
      console.info(
        `PR02b ${parallel ? "parallel" : "sequential"}: 100 deliveries, ${Math.round(performance.now() - started)}ms, ledger=1 evaluation=1 alert=1 recipients=2 outbox=2 audit=1`
      );
    },
    60_000
  );

  it.each(["before-commit", "after-commit"])(
    "SIGKILL %s: real process rollback/commit and restart",
    async (phase) => {
      const f = await seedLedgerFixture(database);
      const { child, message, exited } = startChild(f.connection.id, phase);
      try {
        expect(await message).toEqual({
          checkpoint: phase,
          counts: { matched: 1, alerts: 1, recipients: 2, outbox: 2, audit: 1 }
        });
        if (phase === "before-commit") {
          // The durable pre-fetch anchor remains; NONE of the final outcome is visible.
          expect(await counts(f.team.id)).toEqual({
            ledger: 1,
            evaluation: 1,
            matched: 0,
            alerts: 0,
            recipients: 0,
            outbox: 0,
            audit: 0
          });
          expect(
            await database.mailEvaluation.findFirst({
              where: { connectionId: f.connection.id }
            })
          ).toMatchObject({ state: "EVALUATING", decisionAt: null });
        } else await expectMatched(f.team.id);
        expect(child.kill("SIGKILL")).toBe(true);
        expect((await exited)[1]).toBe("SIGKILL");
        children.delete(child);
        if (phase === "before-commit")
          expect((await counts(f.team.id)).outbox).toBe(0);
        const restart = startChild(
          f.connection.id,
          "resume",
          phase === "after-commit"
        );
        expect(await restart.message).toMatchObject({
          completed: true,
          calls: {
            alertsCreated: phase === "before-commit" ? 1 : 0,
            sseWakeups: phase === "before-commit" ? 1 : 0,
            fetch: phase === "before-commit" ? 1 : 0
          }
        });
        expect((await restart.exited)[0]).toBe(0);
        children.delete(restart.child);
        await expectMatched(f.team.id);
      } finally {
        child.kill("SIGKILL");
        children.delete(child);
      }
    },
    60_000
  );

  it("SSE only after outer commit; provider fetch is outside atomic TX; failure rolls back everything", async () => {
    const f = await seedLedgerFixture(database);
    let txDone = false;
    let transactionsOpen = 0;
    const instrumented = atomicTestDatabase(database, {
      enter: () => {
        transactionsOpen += 1;
      },
      leave: () => {
        transactionsOpen -= 1;
      },
      beforeCommit: async (tx) => {
        expect(h.calls.fetch).toBe(1);
        expect(h.calls.sseWakeups).toBe(0);
        expect(
          await tx.reliabilityOutbox.count({ where: { teamId: f.team.id } })
        ).toBe(2);
        expect((await counts(f.team.id)).outbox).toBe(0);
      },
      afterCommit: async () => {
        expect(h.calls.sseWakeups).toBe(0);
        await expectMatched(f.team.id);
        txDone = true;
      }
    });
    const h: Awaited<ReturnType<typeof ledgerHarness>> = await ledgerHarness(
      database,
      f.connection.id,
      {
        mode: "legacy-outbox",
        reliabilityDatabase: instrumented,
        beforeFetch: async () => {
          expect(txDone).toBe(false);
          expect(transactionsOpen).toBe(0);
        }
      }
    );
    await h.run();
    expect(txDone).toBe(true);
    expect(h.calls.sseWakeups).toBe(1);

    const second = await seedLedgerFixture(database);
    const failed = await ledgerHarness(database, second.connection.id, {
      mode: "legacy-outbox",
      reliabilityDatabase: atomicTestDatabase(database, {
        beforeCommit: async () => {
          throw new Error("synthetic failure after reservations");
        }
      })
    });
    await expect(failed.run()).rejects.toThrow();
    expect(await counts(second.team.id)).toEqual({
      ledger: 1,
      evaluation: 1,
      matched: 0,
      alerts: 0,
      recipients: 0,
      outbox: 0,
      audit: 0
    });
    expect(failed.calls.sseWakeups).toBe(0);
  });

  it("SERIALIZABLE retry repeats DB work only, not message fetch or SSE", async () => {
    const f = await seedLedgerFixture(database);
    let attempts = 0;
    const h = await ledgerHarness(database, f.connection.id, {
      mode: "legacy-outbox",
      reliabilityDatabase: atomicTestDatabase(database, {
        beforeCommit: async () => {
          attempts += 1;
          if (attempts === 1)
            throw Object.assign(new Error("synthetic serialization conflict"), {
              code: "P2034"
            });
        }
      })
    });
    await h.run();
    expect(attempts).toBe(2);
    expect(h.calls.fetch).toBe(1);
    expect(h.calls.sseWakeups).toBe(1);
    await expectMatched(f.team.id);
  });

  it("repair of an existing raw-ID Alert preserves recipient state and audit; retries do not reset Outbox", async () => {
    const f = await seedLedgerFixture(database);
    await (
      await ledgerHarness(database, f.connection.id, { mode: "legacy" })
    ).run();
    const alert = await database.alert.findFirstOrThrow({
      where: { teamId: f.team.id }
    });
    const repo = new PrismaAlertRepository(database);
    await repo.markReadByOwner({
      teamId: f.team.id,
      userId: f.owner.id,
      alertId: alert.id,
      now: fixtureNow
    });
    await repo.resolveByOwner({
      teamId: f.team.id,
      userId: f.owner.id,
      alertId: alert.id,
      now: fixtureNow
    });
    await repo.dismissOwnerNotifications({
      teamId: f.team.id,
      userId: f.owner.id,
      items: [{ type: "ALERT", id: alert.id }],
      requestId: null,
      now: fixtureNow
    });
    const snapshot = async () => ({
      alert: await database.alert.findUnique({ where: { id: alert.id } }),
      recipients: await database.alertRecipient.findMany({
        where: { alertId: alert.id },
        orderBy: { id: "asc" }
      }),
      audit: await database.auditEvent.findMany({
        where: { teamId: f.team.id },
        orderBy: { id: "asc" }
      })
    });
    const before = await snapshot();
    const h = await ledgerHarness(database, f.connection.id, {
      mode: "legacy-outbox",
      message404: true
    });
    await h.run();
    await expectMatched(f.team.id);
    expect(await snapshot()).toEqual(before);
    expect(h.calls.fetch).toBe(0);
    expect(h.calls.sseWakeups).toBe(0);
    const outboxBefore = await database.reliabilityOutbox.findMany({
      where: { teamId: f.team.id },
      orderBy: { id: "asc" }
    });
    await h.run();
    expect(
      await database.reliabilityOutbox.findMany({
        where: { teamId: f.team.id },
        orderBy: { id: "asc" }
      })
    ).toEqual(outboxBefore);
  });

  it.each(["off", "legacy"] as const)(
    "%s retains old behavior with no Outbox writes",
    async (mode) => {
      const f = await seedLedgerFixture(database);
      const h = await ledgerHarness(database, f.connection.id, { mode });
      await h.run();
      const c = await counts(f.team.id);
      expect(c).toEqual({
        ledger: mode === "off" ? 0 : 1,
        evaluation: mode === "off" ? 0 : 1,
        matched: mode === "off" ? 0 : 1,
        alerts: 1,
        recipients: 2,
        outbox: 0,
        audit: 1
      });
      expect(h.calls.sseWakeups).toBe(1);
    }
  );

  it("only the original ACTIVE fan-out receives reservations; disabled/deleted participants are excluded", async () => {
    const f = await seedLedgerFixture(database);
    for (const deleted of [false, true]) {
      await database.notificationMember.create({
        data: {
          teamId: f.team.id,
          callNowId: `CN-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
          displayName: "Synthetic inactive recipient",
          status: "DISABLED",
          deletedAt: deleted ? fixtureNow : null,
          passwordHash: "synthetic-non-login-hash"
        }
      });
    }
    await (
      await ledgerHarness(database, f.connection.id, { mode: "legacy-outbox" })
    ).run();
    await expectMatched(f.team.id);
    const recipients = await database.alertRecipient.findMany({
      where: { alert: { teamId: f.team.id } }
    });
    expect(
      recipients.map((row) => row.notificationMemberId).filter(Boolean)
    ).toEqual([f.member.id]);
  });

  it("redelivery never resets an existing reservation's status, attempts or timestamp", async () => {
    const f = await seedLedgerFixture(database);
    const h = await ledgerHarness(database, f.connection.id, {
      mode: "legacy-outbox"
    });
    await h.run();
    // Synthetic future-consumer state, not a dispatcher or a real send.
    await database.reliabilityOutbox.updateMany({
      where: { teamId: f.team.id },
      data: {
        status: "RETRY_WAIT",
        attempts: 2,
        availableAt: fixtureNow,
        lastErrorCode: "SYNTHETIC_RETRY"
      }
    });
    const before = await database.reliabilityOutbox.findMany({
      where: { teamId: f.team.id },
      orderBy: { id: "asc" }
    });
    await h.run();
    expect(
      await database.reliabilityOutbox.findMany({
        where: { teamId: f.team.id },
        orderBy: { id: "asc" }
      })
    ).toEqual(before);
    expect(h.calls.sseWakeups).toBe(1);
  });

  it.each(["404", "unmatched", "paused-window"])(
    "%s never creates Alert or Outbox",
    async (scenario) => {
      const f = await seedLedgerFixture(database);
      const h = await ledgerHarness(database, f.connection.id, {
        mode: "legacy-outbox",
        message404: scenario === "404",
        history404: scenario === "paused-window",
        ...(scenario === "unmatched"
          ? {
              message: {
                payload: {
                  mimeType: "text/plain",
                  filename: "",
                  headers: [],
                  body: { size: 0, data: "", attachmentId: null },
                  parts: []
                },
                snippet: "synthetic no match"
              }
            }
          : {}),
        ...(scenario === "paused-window"
          ? {
              message: { internalDate: String(fixtureNow.getTime() - 120_000) }
            }
          : {})
      });
      await h.run();
      await h.run();
      expect(await counts(f.team.id)).toEqual({
        ledger: 1,
        evaluation: 1,
        matched: 0,
        alerts: 0,
        recipients: 0,
        outbox: 0,
        audit: 0
      });
      expect(h.calls.fetch).toBe(1);
      expect(
        await database.mailEvaluation.findFirst({
          where: { connectionId: f.connection.id }
        })
      ).toMatchObject({
        state:
          scenario === "404"
            ? "UNDETERMINED"
            : scenario === "unmatched"
              ? "NOT_MATCHED"
              : "EXCLUDED",
        lastErrorCode: scenario === "404" ? "MESSAGE_GET_404" : null
      });
    }
  );

  it("DB constraints reject missing recipient, cross-Team/cross-Alert recipient and unsafe payload; unique key is authoritative", async () => {
    const a = await seedLedgerFixture(database),
      b = await seedLedgerFixture(database);
    for (const f of [a, b])
      await (
        await ledgerHarness(database, f.connection.id, {
          mode: "legacy-outbox"
        })
      ).run();
    const row = await database.reliabilityOutbox.findFirstOrThrow({
      where: { teamId: a.team.id }
    });
    const other = await database.reliabilityOutbox.findFirstOrThrow({
      where: { teamId: b.team.id }
    });
    const make = () => ({
      id: randomUUID(),
      eventKey: randomUUID().replaceAll("-", "").repeat(2),
      kind: "ALERT_AVAILABLE" as const,
      teamId: row.teamId,
      alertId: row.alertId,
      recipientId: row.recipientId,
      payload: { schemaVersion: 1 }
    });
    for (const invalid of [
      { ...make(), recipientId: null },
      { ...make(), teamId: b.team.id },
      { ...make(), recipientId: other.recipientId },
      { ...make(), payload: { forbidden: "synthetic" } }
    ]) {
      await expect(
        database.reliabilityOutbox.create({ data: invalid })
      ).rejects.toThrow();
    }
    await expect(
      database.reliabilityOutbox.create({
        data: { ...make(), eventKey: row.eventKey }
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect((await counts(a.team.id)).outbox).toBe(2);
  });

  it("scope mismatch rolls back before creating any Alert or reservation", async () => {
    const f = await seedLedgerFixture(database);
    const ledger = new PrismaMailLedger(database);
    const entry = await ledger.discover({
      teamId: f.team.id,
      provider: "GOOGLE",
      mailboxId: f.authorization.id,
      connectionId: f.connection.id,
      providerMessageId: "scope-test",
      keywords: ["停電"],
      now: fixtureNow
    });
    const atomic = new PrismaAtomicMailIngestion(database, ledger);
    await expect(
      atomic.ingestMatched(entry, {
        teamId: randomUUID(),
        sourceMailConnectionId: f.connection.id,
        sourceEventId: "scope-test",
        kind: "REAL",
        matchedKeyword: "停電",
        detectedAt: fixtureNow,
        now: fixtureNow
      })
    ).rejects.toThrow("ATOMIC_MAIL_SCOPE_MISMATCH");
    expect((await counts(f.team.id)).alerts).toBe(0);
    expect((await counts(f.team.id)).outbox).toBe(0);
  });

  it("an occupied eventKey with a different recipient/Alert fails the collision guard without side effects", async () => {
    const a = await seedLedgerFixture(database),
      b = await seedLedgerFixture(database);
    for (const f of [a, b])
      await (
        await ledgerHarness(database, f.connection.id, { mode: "legacy" })
      ).run();
    const message = await database.mailMessageLedger.findFirstOrThrow({
      where: { teamId: a.team.id }
    });
    const recipient = await database.alertRecipient.findFirstOrThrow({
      where: { alertId: message.alertId! },
      orderBy: { id: "asc" }
    });
    const other = await database.alertRecipient.findFirstOrThrow({
      where: { alert: { teamId: b.team.id } }
    });
    await database.reliabilityOutbox.create({
      data: {
        eventKey: alertOutboxKey(message.messageKey, recipient.id),
        kind: "ALERT_AVAILABLE",
        teamId: b.team.id,
        alertId: other.alertId,
        recipientId: other.id,
        payload: { schemaVersion: 1 }
      }
    });
    const before = await counts(a.team.id);
    const h = await ledgerHarness(database, a.connection.id, {
      mode: "legacy-outbox"
    });
    await expect(h.run()).rejects.toThrow(
      "gmail_monitoring_temporarily_unavailable"
    );
    const ledger = new PrismaMailLedger(database);
    const evaluation = await database.mailEvaluation.findUniqueOrThrow({
      where: {
        messageId_lane: { messageId: message.id, lane: "LEGACY" }
      }
    });
    await expect(
      new PrismaAtomicMailIngestion(database, ledger).ingestMatched(
        { message, evaluation },
        {
          teamId: a.team.id,
          sourceMailConnectionId: a.connection.id,
          sourceEventId: message.providerMessageId,
          kind: "REAL",
          matchedKeyword: "停電",
          detectedAt: fixtureNow,
          now: fixtureNow
        }
      )
    ).rejects.toThrow("OUTBOX_KEY_COLLISION_OR_SCOPE_MISMATCH");
    expect(await counts(a.team.id)).toEqual(before);
    expect(h.calls.sseWakeups).toBe(0);
  });

  it("inactive connection is still rejected under the existing PR02a eligibility lock", async () => {
    const f = await seedLedgerFixture(database);
    await database.mailConnection.update({
      where: { id: f.connection.id },
      data: { status: "PAUSED" }
    });
    const h = await ledgerHarness(database, f.connection.id, {
      mode: "legacy-outbox"
    });
    await expect(h.run()).rejects.toThrow();
    expect((await counts(f.team.id)).alerts).toBe(0);
    expect((await counts(f.team.id)).outbox).toBe(0);
  });
});
