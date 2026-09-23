import type { GmailMonitoringService } from "../gmail/gmail-monitoring-service.js";
import {
  parseGmailJobPayload,
  type PrismaGmailJobQueue,
  type GmailJobFailure
} from "./prisma-gmail-job-queue.js";

export class GmailJobWorker {
  public constructor(
    private readonly queue: PrismaGmailJobQueue,
    private readonly service: Pick<
      GmailMonitoringService,
      "syncConnectionById"
    >,
    private readonly mode: "off" | "durable" = "off",
    private readonly leaseMs = 120_000
  ) {}

  public async runOnce(
    signal: AbortSignal = new AbortController().signal
  ): Promise<
    "OFF" | "IDLE" | "STOPPED" | "LEASE_LOST" | "DONE" | "UNFINISHED"
  > {
    if (this.mode === "off") return "OFF";
    if (signal.aborted) return "STOPPED";
    const claim = await this.queue.claimOne(this.leaseMs);
    if (!claim) return "IDLE";
    let failure: GmailJobFailure | undefined;
    try {
      let payload;
      try {
        payload = parseGmailJobPayload(claim.payload);
      } catch {
        failure = "GMAIL_JOB_PAYLOAD_INVALID";
      }
      if (claim.attempts > 10) failure = "GMAIL_JOB_RETRY_EXHAUSTED";
      if (payload && !failure)
        for (const target of payload.targets) {
          if (signal.aborted) return "STOPPED";
          if (!(await this.queue.owns(claim))) return "LEASE_LOST";
          const state = await this.queue.targetState(target, payload.historyId);
          if (state === "UNAVAILABLE") {
            failure = "GMAIL_JOB_TARGET_UNAVAILABLE";
            continue;
          }
          if (state === "COMPLETE") continue;
          try {
            // Same per-message service/ledger/Alert path, outside all DB retry TXs.
            await this.service.syncConnectionById(
              target.connectionId,
              payload.historyId
            );
            // Existing service can return after marking reauth-required. Never call
            // that success; require committed cursor progress and current eligibility.
            if (
              (await this.queue.targetState(target, payload.historyId)) !==
              "COMPLETE"
            )
              failure = "GMAIL_JOB_PROGRESS_UNCONFIRMED";
          } catch {
            failure = "GMAIL_JOB_RETRY";
          }
        }
    } catch {
      failure ??= "GMAIL_JOB_RETRY";
    }
    if (signal.aborted) return "STOPPED";
    if (!(await this.queue.finish(claim, failure))) return "LEASE_LOST";
    return failure ? "UNFINISHED" : "DONE";
  }
}
