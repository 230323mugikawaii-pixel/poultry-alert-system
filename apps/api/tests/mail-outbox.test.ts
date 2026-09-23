import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { alertOutboxKey } from "../src/modules/mail/reliability/prisma-atomic-mail-ingestion.js";
import { mailReliabilityOptions } from "../src/modules/mail/reliability/mail-reliability-options.js";

it("PR02b key is messageKey + recipient identity, versioned UTF-8 SHA256", () => {
  const message = "a".repeat(64),
    recipient = "A0000000-0000-4000-8000-000000000001";
  const key = alertOutboxKey(message, recipient);
  expect(key).toBe(
    createHash("sha256")
      .update(
        JSON.stringify([
          "alert-available-v1",
          message,
          recipient.toLowerCase()
        ]),
        "utf8"
      )
      .digest("hex")
  );
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(alertOutboxKey(message, recipient.toLowerCase())).toBe(key);
  expect(alertOutboxKey("b".repeat(64), recipient)).not.toBe(key);
  expect(alertOutboxKey(message, recipient.slice(0, -1) + "2")).not.toBe(key);
});

it.each([
  ["bad", "a0000000-0000-4000-8000-000000000001"],
  ["a".repeat(64), "bad"]
])("PR02b rejects malformed key inputs", (message, recipient) => {
  expect(() => alertOutboxKey(message, recipient)).toThrow(
    "OUTBOX_IDENTITY_INVALID"
  );
});

it("PR02b off/legacy cannot enable atomic persistence and configuration performs no DB I/O", () => {
  const database = new Proxy({} as DatabaseClient, {
    get() {
      throw new Error("unexpected database access");
    }
  });
  expect(mailReliabilityOptions(database, "off")).toEqual({});
  expect(
    mailReliabilityOptions(database, "legacy").atomicMailIngestion
  ).toBeUndefined();
  expect(
    mailReliabilityOptions(database, "legacy-outbox").atomicMailIngestion
  ).toBeDefined();
});
