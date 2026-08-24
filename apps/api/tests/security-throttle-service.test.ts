import { describe, expect, it } from "vitest";
import { SecurityThrottleService } from "../src/modules/security/security-throttle-service.js";
import { MemorySecurityThrottleRepository } from "./helpers/memory-security-throttle.js";

const pepper = "security-throttle-test-pepper-at-least-thirty-two-characters";
const rule = {
  scope: "magic_req_email",
  dimensions: ["member@example.com"],
  maximumAttempts: 2,
  windowMinutes: 15,
  lockMinutes: 15
} as const;

describe("SecurityThrottleService", () => {
  it("allows the configured attempts and returns stable 429 afterwards", async () => {
    const service = new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      pepper
    );

    await expect(service.consume([rule])).resolves.toBeUndefined();
    await expect(service.consume([rule])).resolves.toBeUndefined();
    await expect(service.consume([rule])).rejects.toMatchObject({
      code: "SECURITY_RATE_LIMITED",
      statusCode: 429
    });
  });

  it("locks at the failure threshold and can clear only the requested key", async () => {
    const service = new SecurityThrottleService(
      new MemorySecurityThrottleRepository(),
      pepper
    );
    const error = {
      code: "INVITATION_TEMPORARILY_LOCKED",
      message: "locked",
      statusCode: 429
    } as const;

    await service.recordFailure([rule]);
    await service.recordFailure([rule]);
    await expect(
      service.assertFailuresAllowed([rule], error)
    ).rejects.toMatchObject({ code: error.code, statusCode: 429 });
    await service.clear([rule]);
    await expect(
      service.assertFailuresAllowed([rule], error)
    ).resolves.toBeUndefined();
  });
});
