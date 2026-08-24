import { describe, expect, it } from "vitest";
import { AuthService } from "../src/modules/auth/auth-service.js";
import {
  MemoryAuthRepository,
  MemoryMagicLinkEmailSender
} from "./helpers/memory-auth.js";

const tokenPepper = "test-token-pepper-at-least-thirty-two-characters";

function createFixture(now = new Date("2026-08-24T00:00:00.000Z")) {
  const repository = new MemoryAuthRepository();
  const emailSender = new MemoryMagicLinkEmailSender();
  let currentTime = now;
  const service = new AuthService({
    repository,
    emailSender,
    publicOrigin: "https://call-now.example",
    tokenPepper,
    magicLinkTtlMinutes: 15,
    sessionIdleDays: 30,
    sessionAbsoluteDays: 90,
    maxActiveSessions: 5,
    now: () => currentTime
  });
  return {
    repository,
    emailSender,
    service,
    setNow: (value: Date) => {
      currentTime = value;
    }
  };
}

describe("AuthService", () => {
  it("normalizes email, sends a one-time link, and creates an individual session", async () => {
    const fixture = createFixture();

    await fixture.service.requestMagicLink("  MEMBER@Example.COM ");

    expect(fixture.emailSender.messages).toHaveLength(1);
    expect(fixture.emailSender.messages[0]?.recipient).toBe(
      "member@example.com"
    );
    const link = new URL(fixture.emailSender.messages[0]?.magicLink ?? "");
    const token = link.searchParams.get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,100}$/);

    const login = await fixture.service.consumeMagicLink(token ?? "", {
      deviceName: "iPhone",
      ipAddress: "192.0.2.10",
      userAgent: "CallNow Test"
    });

    expect(login.user.email).toBe("member@example.com");
    expect(login.session.deviceName).toBe("iPhone");
    expect(login.sessionToken).not.toBe(
      fixture.repository.sessions[0]?.tokenHash
    );
    await expect(
      fixture.service.consumeMagicLink(token ?? "", {})
    ).rejects.toMatchObject({ code: "MAGIC_LINK_INVALID_OR_EXPIRED" });
  });

  it("rejects an expired magic link", async () => {
    const fixture = createFixture();
    await fixture.service.requestMagicLink("member@example.com");
    const token = new URL(
      fixture.emailSender.messages[0]?.magicLink ?? ""
    ).searchParams.get("token");
    fixture.setNow(new Date("2026-08-24T00:16:00.000Z"));

    await expect(
      fixture.service.consumeMagicLink(token ?? "", {})
    ).rejects.toMatchObject({ code: "MAGIC_LINK_INVALID_OR_EXPIRED" });
  });

  it("revokes older sessions when the configured active limit is reached", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 6; index += 1) {
      await fixture.service.requestMagicLink("member@example.com");
      const token = new URL(
        fixture.emailSender.messages[index]?.magicLink ?? ""
      ).searchParams.get("token");
      await fixture.service.consumeMagicLink(token ?? "", {
        deviceName: `Device ${index + 1}`
      });
    }

    const user = fixture.repository.users.get("member@example.com");
    expect(user).toBeDefined();
    expect(await fixture.repository.listSessions(user?.id ?? "")).toHaveLength(
      5
    );
  });
});
