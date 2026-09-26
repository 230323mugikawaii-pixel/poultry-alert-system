import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { createOAuthFencedRefresh } from "../src/modules/mail/reliability/oauth-fenced-refresh.js";
import { readFile } from "node:fs/promises";
import type { DatabaseClient } from "../src/db/client.js";

describe("PR05a disconnected foundation", () => {
  it("raw DB failure is not exposed and no provider call follows failed TX1", async () => {
    const db = {
      $transaction: async () => {
        throw new Error("SYNTHETIC_PRIVATE_VALUE");
      }
    } as unknown as DatabaseClient;
    const encryption = { encrypt: vi.fn(), decrypt: vi.fn() },
      provider = { refresh: vi.fn() };
    const s = createOAuthFencedRefresh("shadow", () => ({
      db,
      encryption,
      provider
    }))!;
    const caught = await s
      .acquire({
        authorizationId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        provider: "GOOGLE"
      })
      .catch((e: unknown) => e);
    expect(
      caught instanceof Error &&
        caught.message === "OAUTH_REFRESH_DB_UNAVAILABLE"
    ).toBe(true);
    expect(caught instanceof Error && caught.cause === undefined).toBe(true);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });
  it("defaults off; off never constructs dependencies or service", () => {
    expect(loadEnvironment({ APP_ENV: "test" }).OAUTH_FENCED_REFRESH_MODE).toBe(
      "off"
    );
    const factory = vi.fn(() => {
      throw new Error("must not construct");
    });
    expect(createOAuthFencedRefresh(undefined, factory)).toBeUndefined();
    expect(createOAuthFencedRefresh("off", factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(
      loadEnvironment({ APP_ENV: "test", OAUTH_FENCED_REFRESH_MODE: "shadow" })
        .OAUTH_FENCED_REFRESH_MODE
    ).toBe("shadow");
    expect(() =>
      loadEnvironment({ APP_ENV: "test", OAUTH_FENCED_REFRESH_MODE: "live" })
    ).toThrow();
  });
  it("is not wired into real API, jobs, watch renewal or provider implementations", async () => {
    for (const path of [
      "server.ts",
      "app.ts",
      "cli/gmail-process-jobs.ts",
      "cli/gmail-renew-watches.ts",
      "modules/mail/gmail/gmail-monitoring-service.ts",
      "modules/mail/providers/google-mail-provider.ts",
      "modules/mail/providers/microsoft-mail-provider.ts",
      "modules/mail/mail-connection-service.ts"
    ])
      expect(
        await readFile(new URL(`../src/${path}`, import.meta.url), "utf8")
      ).not.toMatch(/createOAuthFencedRefresh|oauth-fenced-refresh/);
  });
});
