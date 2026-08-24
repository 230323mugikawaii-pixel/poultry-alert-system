import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppEnvironment } from "../src/config/env.js";

const environment: AppEnvironment = {
  APP_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 8080,
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "https://test.call-now.example",
  COOKIE_NAME: "callnow_test_session",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test"
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("system routes", () => {
  it.each(["/healthz", "/readyz"])("returns healthy status for %s", async (url) => {
    const app = await buildApp({ environment, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "call-now-api" });
  });

  it("returns a stable error envelope for unknown routes", async () => {
    const app = await buildApp({ environment, logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found."
      }
    });
  });
});
