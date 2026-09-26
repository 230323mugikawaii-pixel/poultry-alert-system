import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { loadEnvironment } from "../src/config/env.js";
import { MonitoringStateService } from "../src/modules/mail/reliability/monitoring-state-service.js";
import { monitoringStateReference } from "../src/modules/mail/reliability/monitoring-state-reference.js";

const scope = {
  connectionId: randomUUID(),
  teamId: randomUUID(),
  mailboxId: randomUUID()
};
describe("PR04 off/shadow boundary", () => {
  it("flag defaults off and rejects live/unknown modes", () => {
    expect(loadEnvironment({ APP_ENV: "test" }).MONITORING_STATE_MODE).toBe(
      "off"
    );
    expect(
      loadEnvironment({ APP_ENV: "test", MONITORING_STATE_MODE: "shadow" })
        .MONITORING_STATE_MODE
    ).toBe("shadow");
    expect(() =>
      loadEnvironment({ APP_ENV: "test", MONITORING_STATE_MODE: "live" })
    ).toThrow();
  });
  it("all OFF methods and reference creation perform zero DB access", async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("DB accessed while OFF");
        }
      }
    ) as DatabaseClient;
    const service = new MonitoringStateService(db);
    expect(await service.read(scope)).toEqual({ kind: "OFF" });
    expect(
      await service.setDesired({
        ...scope,
        desired: "RUNNING",
        expectedGeneration: 0n
      })
    ).toEqual({ kind: "OFF" });
    expect(
      await service.observe({
        ...scope,
        expectedGeneration: 0n,
        observation: { kind: "AUTH_FAILURE", reason: "INVALID_GRANT" }
      })
    ).toEqual({ kind: "OFF" });
    expect(await service.classifyReceivedAt(scope, new Date())).toEqual({
      kind: "OFF"
    });
    expect(monitoringStateReference(db)).toBeUndefined();
  });
  it("shadow lookup failure emits only UNAVAILABLE, never the raw database error", async () => {
    const read = vi
      .fn()
      .mockRejectedValue(
        new Error("synthetic private diagnostic must not escape")
      );
    const report = vi.fn();
    const db = {
      monitoringState: { findFirst: read }
    } as unknown as DatabaseClient;
    await monitoringStateReference(db, "shadow", report)!(scope);
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: "UNAVAILABLE" });
  });
  it("shadow logs only state enums and generation; missing rows stay missing", async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      desired: "RUNNING",
      observed: "AUTH_REQUIRED",
      generation: 2n,
      extra: "must-not-report"
    });
    const report = vi.fn();
    const db = {
      monitoringState: { findFirst: read }
    } as unknown as DatabaseClient;
    const reference = monitoringStateReference(db, "shadow", report)!;
    await reference(scope);
    await reference(scope);
    expect(report.mock.calls).toEqual([
      [{ kind: "MISSING" }],
      [
        {
          kind: "STATE",
          desired: "RUNNING",
          observed: "AUTH_REQUIRED",
          generation: "2"
        }
      ]
    ]);
  });
});
