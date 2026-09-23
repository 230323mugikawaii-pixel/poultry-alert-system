import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertSameIdentity,
  messageKey,
  sourceEventId,
  type MessageIdentity
} from "../src/modules/mail/reliability/message-key.js";
import { loadEnvironment } from "../src/config/env.js";

const base: MessageIdentity = {
  teamId: "A0000000-0000-4000-8000-000000000001",
  provider: "GOOGLE",
  mailboxId: "B0000000-0000-4000-8000-000000000002",
  providerMessageId: "18aBcD"
};

describe("PR01 canonical message identity", () => {
  it("uses exact UTF-8 JSON array SHA256 lower-case hex and normalizes only UUID case", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "mail-v1",
          base.teamId.toLowerCase(),
          "GOOGLE",
          base.mailboxId.toLowerCase(),
          "18aBcD"
        ]),
        "utf8"
      )
      .digest("hex");
    expect(messageKey(base)).toBe(expected);
    expect(messageKey(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      messageKey({
        ...base,
        teamId: base.teamId.toLowerCase(),
        mailboxId: base.mailboxId.toLowerCase()
      })
    ).toBe(expected);
  });
  it.each([
    { teamId: "a0000000-0000-4000-8000-000000000009" },
    { mailboxId: "b0000000-0000-4000-8000-000000000009" },
    { provider: "MICROSOFT" as const },
    { providerMessageId: "18abcd" },
    { providerMessageId: " 18aBcD " },
    { providerMessageId: "18aBcD " }
  ])("does not conflate distinct identities: %j", (change) => {
    expect(messageKey({ ...base, ...change })).not.toBe(messageKey(base));
    expect(() => assertSameIdentity(base, { ...base, ...change })).toThrow(
      "MESSAGE_KEY_COLLISION_OR_IDENTITY_MISMATCH"
    );
  });
  it("does not Unicode-normalize provider IDs", () => {
    expect(messageKey({ ...base, providerMessageId: "é" })).not.toBe(
      messageKey({ ...base, providerMessageId: "e\u0301" })
    );
  });
  it("keeps Gmail source IDs raw; long Microsoft IDs produce distinct 67-character source IDs", () => {
    expect(sourceEventId(base)).toBe(base.providerMessageId);
    const first = {
      ...base,
      provider: "MICROSOFT" as const,
      providerMessageId: "X".repeat(4_000) + "a"
    };
    const second = { ...first, providerMessageId: "X".repeat(4_000) + "b" };
    expect(sourceEventId(first)).toBe(`m1:${messageKey(first)}`);
    expect(sourceEventId(first)).toHaveLength(67);
    expect(sourceEventId(first)).not.toBe(sourceEventId(second));
    expect(first.providerMessageId).toHaveLength(4_001);
  });
  it.each([
    { teamId: "invalid" },
    { mailboxId: "invalid" },
    { providerMessageId: "" },
    { providerMessageId: "id\n" },
    { provider: "GMAIL" }
  ])("rejects invalid identity %j", (change) => {
    expect(() =>
      messageKey({ ...base, ...change } as MessageIdentity)
    ).toThrow();
  });
  it("flag defaults off, explicitly permits legacy observation or legacy-outbox composition", () => {
    expect(loadEnvironment({}).MAIL_LEDGER_MODE).toBe("off");
    expect(
      loadEnvironment({ MAIL_LEDGER_MODE: "legacy" }).MAIL_LEDGER_MODE
    ).toBe("legacy");
    expect(
      loadEnvironment({ MAIL_LEDGER_MODE: "legacy-outbox" }).MAIL_LEDGER_MODE
    ).toBe("legacy-outbox");
    expect(() => loadEnvironment({ MAIL_LEDGER_MODE: "live" })).toThrow();
  });
});
