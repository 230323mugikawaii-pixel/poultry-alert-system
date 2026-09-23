import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../src/db/client.js";
import { PrismaMailConnectionRepository } from "../src/modules/mail/prisma-mail-connection-repository.js";
import { messageKey } from "../src/modules/mail/reliability/message-key.js";
import {
  assertTestDatabase,
  fixtureNow,
  ledgerHarness,
  seedLedgerFixture,
  syntheticBody
} from "./fixtures/mail-ledger-harness.js";

const postgres =
  process.env.RUN_PR01_POSTGRES_TESTS === "true" ? describe : describe.skip;
let database: DatabaseClient;
const children = new Set<ChildProcess>();

postgres("PR01 real PostgreSQL acceptance", () => {
  beforeAll(async () => {
    assertTestDatabase(process.env.DATABASE_URL ?? "");
    database = createDatabaseClient(process.env.DATABASE_URL!);
    const version = await database.$queryRaw<
      Array<{ server_version_num: string }>
    >`SHOW server_version_num`;
    expect(Number(version[0]!.server_version_num)).toBeGreaterThanOrEqual(
      170000
    );
    expect(Number(version[0]!.server_version_num)).toBeLessThan(180000);
  });
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await database?.$disconnect();
  });

  for (const parallel of [false, true]) {
    it(`100 ${parallel ? "parallel" : "sequential"} deliveries: one ledger/evaluation/Alert/fan-out/audit`, async () => {
      const fixture = await seedLedgerFixture(database);
      const harness = await ledgerHarness(database, fixture.connection.id);
      const started = performance.now();
      if (parallel)
        await Promise.all(Array.from({ length: 100 }, () => harness.run()));
      else for (let i = 0; i < 100; i += 1) await harness.run();
      await expectOneMatched(fixture.team.id);
      expect(harness.calls.alertsCreated).toBe(1);
      expect(harness.calls.sseWakeups).toBe(1);
      console.info(
        `PR01 ${parallel ? "parallel" : "sequential"}: 100 deliveries, ${Math.round(performance.now() - started)}ms, ledger=1 evaluation=1 alert=1 recipients=2 audit=1`
      );
    }, 60_000);
  }

  for (const phase of ["before-fetch", "after-alert-commit"] as const) {
    it(`SIGKILL ${phase}: durable checkpoint and process restart`, async () => {
      const fixture = await seedLedgerFixture(database);
      const child = fork(
        fileURLToPath(
          new URL("./fixtures/mail-ledger-crash-child.ts", import.meta.url)
        ),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            PR01_CONNECTION_ID: fixture.connection.id,
            PR01_CRASH_PHASE: phase
          }
        }
      );
      children.add(child);
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Child checkpoint timeout")),
            15_000
          );
          child.once("message", (value) => {
            clearTimeout(timeout);
            if ((value as { checkpoint?: string }).checkpoint === phase)
              resolve();
            else reject(new Error("Child failed before durable checkpoint"));
          });
          child.once("exit", () => {
            clearTimeout(timeout);
            reject(new Error("Child exited before checkpoint"));
          });
        });
        // Verify persistence through the parent's independent database session.
        const ledger = await database.mailMessageLedger.findFirstOrThrow({
          where: { teamId: fixture.team.id },
          include: { evaluations: true }
        });
        expect(ledger.alertId).toBeNull();
        expect(ledger.evaluations).toHaveLength(1);
        expect(ledger.evaluations[0]!.state).toBe(
          phase === "before-fetch" ? "FETCH_PENDING" : "EVALUATING"
        );
        expect(
          await database.alert.count({ where: { teamId: fixture.team.id } })
        ).toBe(phase === "before-fetch" ? 0 : 1);
        const exited = once(child, "exit");
        expect(child.kill("SIGKILL")).toBe(true);
        const [, signal] = (await exited) as unknown[];
        expect(signal).toBe("SIGKILL");
        children.delete(child);
        // Restart a NEW OS process; after Alert commit even a now-missing
        // message must link to the existing Alert without refetch or fan-out.
        const restarted = fork(
          fileURLToPath(
            new URL("./fixtures/mail-ledger-crash-child.ts", import.meta.url)
          ),
          [],
          {
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
              ...process.env,
              PR01_CONNECTION_ID: fixture.connection.id,
              PR01_CRASH_PHASE: "resume",
              PR01_RETRY_MESSAGE_MISSING: String(phase === "after-alert-commit")
            }
          }
        );
        children.add(restarted);
        try {
          let completion: unknown;
          restarted.once("message", (message: unknown) => {
            completion = message;
          });
          const exit = await new Promise<{
            code: number | null;
            signal: string | null;
          }>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Restarted child timeout")),
              15_000
            );
            restarted.once("exit", (code, signal) => {
              clearTimeout(timeout);
              resolve({ code, signal });
            });
            restarted.once("error", () => {
              clearTimeout(timeout);
              reject(new Error("Child spawn failed"));
            });
          });
          expect(exit).toEqual({ code: 0, signal: null });
          expect(completion).toMatchObject({ completed: true });
          if (phase === "after-alert-commit") {
            expect(completion).toMatchObject({
              calls: { fetch: 0, alertsCreated: 0, sseWakeups: 0 }
            });
          }
          await expectOneMatched(fixture.team.id);
        } finally {
          if (restarted.exitCode === null) restarted.kill("SIGKILL");
          children.delete(restarted);
        }
      } finally {
        if (children.has(child)) {
          child.kill("SIGKILL");
          children.delete(child);
        }
      }
    }, 30_000);
  }

  it("message GET 404 remains UNDETERMINED and 100 redeliveries never refetch", async () => {
    const fixture = await seedLedgerFixture(database);
    const harness = await ledgerHarness(database, fixture.connection.id, {
      message404: true
    });
    for (let i = 0; i < 100; i += 1) await harness.run();
    const entry = await database.mailMessageLedger.findFirstOrThrow({
      where: { teamId: fixture.team.id },
      include: { evaluations: true }
    });
    expect(entry.evaluations[0]).toMatchObject({
      state: "UNDETERMINED",
      lastErrorCode: "MESSAGE_GET_404",
      decisionAt: null
    });
    expect(entry.evaluations[0]!.unresolvedSince).not.toBeNull();
    expect(harness.calls.fetch).toBe(1);
    expect(harness.calls.startWatch).toBe(0);
    expect(
      await database.alert.count({ where: { teamId: fixture.team.id } })
    ).toBe(0);
  }, 30_000);

  it("History 404 still recovers separately; paused-period messages stay excluded", async () => {
    const fixture = await seedLedgerFixture(database);
    const harness = await ledgerHarness(database, fixture.connection.id, {
      history404: true,
      message: { internalDate: String(fixtureNow.getTime() - 120_000) }
    });
    await harness.run();
    expect(harness.calls.startWatch).toBe(1);
    expect(
      await database.mailEvaluation.findFirst({
        where: { connectionId: fixture.connection.id }
      })
    ).toMatchObject({
      state: "EXCLUDED",
      exclusionCode: "OUTSIDE_MONITORING_WINDOW",
      lastErrorCode: null
    });
    expect(
      await database.alert.count({ where: { teamId: fixture.team.id } })
    ).toBe(0);
  });

  it("existing resolved/read/dismissed Alert and recipients are byte-for-byte unchanged", async () => {
    const fixture = await seedLedgerFixture(database);
    const old = await ledgerHarness(database, fixture.connection.id, {
      mode: "off"
    });
    await old.run();
    const alert = await database.alert.findFirstOrThrow({
      where: { teamId: fixture.team.id }
    });
    await database.alert.update({
      where: { id: alert.id },
      data: {
        status: "RESOLVED",
        acknowledgedAt: fixtureNow,
        acknowledgedByUserId: fixture.owner.id,
        resolvedAt: fixtureNow
      }
    });
    await database.alertRecipient.updateMany({
      where: { alertId: alert.id },
      data: { readAt: fixtureNow, dismissedAt: fixtureNow }
    });
    const snapshot = async () =>
      JSON.stringify({
        alert: await database.alert.findUnique({ where: { id: alert.id } }),
        recipients: await database.alertRecipient.findMany({
          where: { alertId: alert.id },
          orderBy: { id: "asc" }
        }),
        audit: await database.auditEvent.findMany({
          where: { teamId: fixture.team.id },
          orderBy: { id: "asc" }
        })
      });
    const before = await snapshot();
    const harness = await ledgerHarness(database, fixture.connection.id, {
      message404: true
    });
    await harness.run();
    expect(await snapshot()).toBe(before);
    expect(harness.calls.fetch).toBe(0);
    await expectOneMatched(fixture.team.id);
  });

  it("off never touches either ledger table and still creates the legacy Alert", async () => {
    const fixture = await seedLedgerFixture(database);
    const before = await database.mailMessageLedger.count();
    // Fail loudly if either Prisma model is even accessed.
    const guarded = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "mailMessageLedger" || property === "mailEvaluation")
          throw new Error("OFF_ACCESSED_LEDGER");
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    const harness = await ledgerHarness(guarded, fixture.connection.id, {
      mode: "off"
    });
    await harness.run();
    expect(await database.mailMessageLedger.count()).toBe(before);
    expect(harness.calls.alertsCreated).toBe(1);
  });

  it("transient failure persists safe pending code, retry succeeds, no body/token retained", async () => {
    const fixture = await seedLedgerFixture(database);
    const failed = await ledgerHarness(database, fixture.connection.id, {
      getError: new Error("SYNTHETIC_TOKEN_NEVER_STORE")
    });
    await expect(failed.run()).rejects.toThrow();
    const entry = await database.mailEvaluation.findFirstOrThrow({
      where: { connectionId: fixture.connection.id }
    });
    expect(entry.state).toBe("FETCH_PENDING");
    expect(entry.lastErrorCode).toBe("LEGACY_PROCESSING_FAILED");
    await (await ledgerHarness(database, fixture.connection.id)).run();
    const stored = JSON.stringify(
      await database.mailMessageLedger.findMany({
        where: { teamId: fixture.team.id },
        include: { evaluations: true }
      })
    );
    expect(stored).not.toContain(syntheticBody);
    expect(stored).not.toContain("SYNTHETIC_TOKEN_NEVER_STORE");
    expect(stored).not.toContain("synthetic-only");
    await expectOneMatched(fixture.team.id);
  });

  it("DB uniqueness, collision guard and Team/mailbox/provider scope cannot be bypassed", async () => {
    const fixture = await seedLedgerFixture(database);
    const harness = await ledgerHarness(database, fixture.connection.id);
    const input = {
      teamId: fixture.team.id,
      mailboxId: fixture.authorization.id,
      provider: "GOOGLE" as const,
      providerMessageId: harness.messageId,
      connectionId: fixture.connection.id,
      keywords: ["停電"],
      now: fixtureNow
    };
    await database.mailMessageLedger.create({
      data: {
        teamId: input.teamId,
        mailboxId: input.mailboxId,
        provider: "GOOGLE",
        firstConnectionId: input.connectionId,
        providerMessageId: "different-raw-id",
        messageKey: messageKey(input)
      }
    });
    await expect(harness.ledger.discover(input)).rejects.toThrow(
      "MESSAGE_KEY_COLLISION_OR_IDENTITY_MISMATCH"
    );
    await expect(
      harness.ledger.discover({ ...input, teamId: fixture.owner.id })
    ).rejects.toThrow("LEDGER_CONNECTION_SCOPE_MISMATCH");
    await expect(
      harness.ledger.discover({ ...input, mailboxId: fixture.owner.id })
    ).rejects.toThrow("LEDGER_CONNECTION_SCOPE_MISMATCH");
    await expect(
      harness.ledger.discover({ ...input, provider: "MICROSOFT" })
    ).rejects.toThrow("LEDGER_CONNECTION_SCOPE_MISMATCH");
    expect(
      await database.mailEvaluation.count({
        where: { connectionId: input.connectionId }
      })
    ).toBe(0);
  });

  it("long provider ID remains complete in TEXT; composite authorization FK preserves provider", async () => {
    const fixture = await seedLedgerFixture(database);
    const auth = await database.mailAuthorization.create({
      data: {
        userId: fixture.owner.id,
        provider: "MICROSOFT",
        providerSubject: `${fixture.authorization.providerSubject}-ms`,
        email: "synthetic-ms@example.invalid"
      }
    });
    const connection = await database.mailConnection.create({
      data: {
        teamId: fixture.team.id,
        mailAuthorizationId: auth.id,
        provider: "MICROSOFT"
      }
    });
    const harness = await ledgerHarness(database, fixture.connection.id);
    const providerMessageId =
      "LongCaseSensitive-ID=".repeat(200) + " \u00e9e\u0301 ";
    const entry = await harness.ledger.discover({
      teamId: fixture.team.id,
      mailboxId: auth.id,
      provider: "MICROSOFT",
      connectionId: connection.id,
      providerMessageId,
      keywords: [],
      now: fixtureNow
    });
    expect(entry.message.providerMessageId).toBe(providerMessageId);
    expect(entry.message.messageKey).toHaveLength(64);
    expect(entry.evaluation.lane).toBe("LEGACY");
    expect(
      await database.alert.count({ where: { teamId: fixture.team.id } })
    ).toBe(0);
  });

  it.each(["NOT_MATCHED", "EXCLUDED"] as const)(
    "%s is durable, with no repeat fetch or Alert",
    async (state) => {
      const fixture = await seedLedgerFixture(database);
      const harness = await ledgerHarness(database, fixture.connection.id, {
        message:
          state === "EXCLUDED"
            ? { labelIds: ["SENT"] }
            : {
                payload: {
                  mimeType: "text/plain",
                  filename: "",
                  headers: [],
                  parts: [],
                  body: { size: 0, data: null, attachmentId: null }
                }
              }
      });
      await harness.run();
      await harness.run();
      expect(harness.calls.fetch).toBe(1);
      expect(
        await database.mailEvaluation.findFirst({
          where: { connectionId: fixture.connection.id }
        })
      ).toMatchObject({ state });
      expect(
        await database.alert.count({ where: { teamId: fixture.team.id } })
      ).toBe(0);
    }
  );

  it("concurrent successful ingest cannot be rolled back by a late missing-message decision", async () => {
    const fixture = await seedLedgerFixture(database);
    const harness = await ledgerHarness(database, fixture.connection.id);
    const stale = await harness.ledger.discover({
      teamId: fixture.team.id,
      mailboxId: fixture.authorization.id,
      provider: "GOOGLE",
      providerMessageId: harness.messageId,
      connectionId: fixture.connection.id,
      keywords: ["停電"],
      now: fixtureNow
    });
    // Model two real provider responses in flight: 404 wins the initial decision,
    // but another already-fetched copy still commits through the existing path.
    await harness.ledger.finish(
      stale,
      { state: "UNDETERMINED", code: "MESSAGE_GET_404" },
      fixtureNow
    );
    await (
      await ledgerHarness(database, fixture.connection.id, { mode: "off" })
    ).run();
    await harness.run();
    await expectOneMatched(fixture.team.id);
    expect(harness.calls.fetch).toBe(0);
    await harness.ledger.finish(
      stale,
      { state: "UNDETERMINED", code: "MESSAGE_GET_404" },
      fixtureNow
    );
    await expectOneMatched(fixture.team.id);
  });

  it("final decisions and original rule snapshot never reset on redelivery or delayed writers", async () => {
    const fixture = await seedLedgerFixture(database);
    const harness = await ledgerHarness(database, fixture.connection.id);
    const input = {
      teamId: fixture.team.id,
      mailboxId: fixture.authorization.id,
      provider: "GOOGLE" as const,
      providerMessageId: harness.messageId,
      connectionId: fixture.connection.id,
      keywords: ["停電"],
      now: fixtureNow
    };
    const stale = await harness.ledger.discover(input);
    await harness.run();
    const original = await database.mailEvaluation.findUniqueOrThrow({
      where: { id: stale.evaluation.id }
    });
    await harness.ledger.discover({ ...input, keywords: ["new-rule"] });
    await harness.ledger.markFetching(stale);
    await harness.ledger.markEvaluating(stale, null);
    await harness.ledger.pendingFailure(stale, fixtureNow);
    await harness.ledger.finish(
      stale,
      { state: "UNDETERMINED", code: "MESSAGE_GET_404" },
      fixtureNow
    );
    expect(
      await database.mailEvaluation.findUnique({ where: { id: original.id } })
    ).toEqual(original);
    await expectOneMatched(fixture.team.id);
  });

  it("reauthorization and disconnect/reconnect retain verified-subject mailbox/connection IDs, never merge by email", async () => {
    const fixture = await seedLedgerFixture(database);
    const repository = new PrismaMailConnectionRepository(database);
    const base = {
      teamId: fixture.team.id,
      ownerUserId: fixture.owner.id,
      provider: "GOOGLE" as const,
      providerSubject: fixture.authorization.providerSubject,
      email: fixture.authorization.email,
      encryptedToken: {
        provider: "test",
        keyVersion: "test",
        ciphertext: "synthetic-not-a-token"
      },
      grantedScopes: ["synthetic"],
      deferActivation: true,
      requestId: null,
      now: fixtureNow
    };
    await repository.saveGrant({
      ...base,
      intent: "REAUTHORIZE",
      connectionId: fixture.connection.id
    });
    expect(
      (
        await database.mailConnection.findUniqueOrThrow({
          where: { id: fixture.connection.id }
        })
      ).mailAuthorizationId
    ).toBe(fixture.authorization.id);
    await repository.disconnect({
      teamId: fixture.team.id,
      ownerUserId: fixture.owner.id,
      connectionId: fixture.connection.id,
      requestId: null,
      now: fixtureNow
    });
    await repository.saveGrant({
      ...base,
      intent: "CONNECT",
      connectionId: null
    });
    const restored = await database.mailAuthorization.findUniqueOrThrow({
      where: {
        provider_providerSubject: {
          provider: "GOOGLE",
          providerSubject: base.providerSubject
        }
      }
    });
    expect(restored.id).toBe(fixture.authorization.id);
    expect(
      (
        await database.mailConnection.findUniqueOrThrow({
          where: { id: fixture.connection.id }
        })
      ).mailAuthorizationId
    ).toBe(restored.id);
    await repository.saveGrant({
      ...base,
      providerSubject: `${base.providerSubject}-different`,
      intent: "CONNECT",
      connectionId: null
    });
    expect(
      await database.mailAuthorization.count({
        where: { userId: fixture.owner.id, email: base.email }
      })
    ).toBe(2);
  });
});

async function expectOneMatched(teamId: string) {
  const rows = await database.mailMessageLedger.findMany({
    where: { teamId },
    include: { evaluations: true }
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.evaluations).toHaveLength(1);
  expect(rows[0]!.evaluations[0]).toMatchObject({
    lane: "LEGACY",
    state: "MATCHED",
    lastErrorCode: null
  });
  const alerts = await database.alert.findMany({
    where: { teamId },
    include: { recipients: true }
  });
  expect(alerts).toHaveLength(1);
  expect(rows[0]!.alertId).toBe(alerts[0]!.id);
  expect(alerts[0]!.sourceEventId).toBe("18abcdef12345678");
  expect(alerts[0]!.recipients).toHaveLength(2);
  expect(
    await database.auditEvent.count({
      where: { teamId, action: "ALERT_CREATED" }
    })
  ).toBe(1);
}
