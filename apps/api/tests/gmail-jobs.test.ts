import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { GmailJobWorker } from "../src/modules/mail/reliability/gmail-job-worker.js";
import {
  gmailJobKey,
  parseGmailJobPayload,
  type PrismaGmailJobQueue
} from "../src/modules/mail/reliability/prisma-gmail-job-queue.js";
import {
  jobApp,
  jobEnvelope,
  jobHeaders,
  jobPath,
  jobEnvironment,
  jobTopic
} from "./fixtures/gmail-job-harness.js";

describe("PR03b intake boundary", () => {
  it("defaults OFF and rejects durable without monitoring/atomic ledger", () => {
    expect(loadEnvironment({ APP_ENV: "test" }).GMAIL_PUSH_JOB_MODE).toBe(
      "off"
    );
    expect(() =>
      loadEnvironment({ APP_ENV: "test", GMAIL_PUSH_JOB_MODE: "durable" })
    ).toThrow();
    expect(jobEnvironment().GMAIL_PUSH_JOB_MODE).toBe("durable");
  });
  it("OFF never touches queue and waits for legacy completion before 204", async () => {
    let complete!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const accept = vi.fn();
    const legacy = vi.fn(async () => {
      entered();
      await pending;
    });
    const app = await jobApp(
      { accept },
      { processPushNotification: legacy },
      "off"
    );
    try {
      let ack = false;
      const response = app
        .inject({
          method: "POST",
          url: jobPath,
          headers: jobHeaders,
          payload: jobEnvelope("synthetic@example.invalid")
        })
        .then((r) => {
          ack = true;
          return r;
        });
      await started;
      expect(ack).toBe(false);
      expect(accept).not.toHaveBeenCalled();
      complete();
      expect((await response).statusCode).toBe(204);
      expect(legacy).toHaveBeenCalledTimes(1);
    } finally {
      complete();
      await app.close();
    }
  });
  it("durable ACK waits for commit, never starts legacy inline", async () => {
    const order: string[] = [];
    const legacy = vi.fn();
    const app = await jobApp(
      {
        accept: async () => {
          order.push("commit");
        }
      },
      { processPushNotification: legacy }
    );
    try {
      const r = await app.inject({
        method: "POST",
        url: jobPath,
        headers: jobHeaders,
        payload: jobEnvelope("synthetic@example.invalid")
      });
      order.push(`ACK${r.statusCode}`);
      expect(order).toEqual(["commit", "ACK204"]);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    {},
    { body: "must-not-store" },
    {
      schemaVersion: 1,
      historyId: "1",
      eventFingerprint: "f".repeat(64),
      targets: [{ connectionId: "invalid" }]
    }
  ])("rejects non-identifier job payload", (p) => {
    expect(() => parseGmailJobPayload(p)).toThrow("GMAIL_JOB_PAYLOAD_INVALID");
  });
  it("scopes dedupe to trusted topic and exact Pub/Sub ID", () => {
    expect(gmailJobKey(jobTopic, "ID")).toMatch(/^[a-f0-9]{64}$/);
    expect(gmailJobKey(jobTopic, "ID")).not.toBe(gmailJobKey(jobTopic, "id"));
    expect(gmailJobKey(jobTopic, "ID")).not.toBe(
      gmailJobKey(`${jobTopic}2`, "ID")
    );
  });
  it("OFF worker performs no queue or provider access", async () => {
    const queue = new Proxy(
      {},
      {
        get: () => {
          throw new Error("queue touched");
        }
      }
    ) as PrismaGmailJobQueue;
    const syncConnectionById = vi.fn();
    expect(
      await new GmailJobWorker(queue, { syncConnectionById }).runOnce()
    ).toBe("OFF");
    expect(syncConnectionById).not.toHaveBeenCalled();
  });
});
