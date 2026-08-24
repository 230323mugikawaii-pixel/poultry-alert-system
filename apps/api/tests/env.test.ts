import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";

describe("loadEnvironment", () => {
  it("applies safe local defaults", () => {
    expect(loadEnvironment({})).toMatchObject({
      APP_ENV: "development",
      PORT: 8080,
      PUBLIC_ORIGIN: "http://127.0.0.1:8080"
    });
  });

  it("requires HTTPS in production", () => {
    expect(() =>
      loadEnvironment({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "http://call-now.example"
      })
    ).toThrow("PUBLIC_ORIGIN must use HTTPS in production");
  });

  it("rejects invalid ports", () => {
    expect(() => loadEnvironment({ PORT: "70000" })).toThrow(
      "Invalid environment configuration"
    );
  });
});
