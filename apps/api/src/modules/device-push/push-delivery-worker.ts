import { retryDelayMs } from "../mail/reliability/outbox-dispatcher.js";
import {
  maximumPushRetryDelayMs,
  validProviderRequestId,
  type ApnsFailureCode,
  type PushDeliveryQueue,
  type PushDeliveryOutcome
} from "./prisma-push-delivery-queue.js";
import type { PushTransport, PushTransportResult } from "./push-transport.js";

export type PushStep =
  "OFF" | "STOPPED" | "IDLE" | "LEASE_LOST" | PushDeliveryOutcome["state"];
export function createPushDeliveryWorker(
  mode: "off" | "shadow" | "apns",
  dependencies: () => { queue: PushDeliveryQueue; transport: PushTransport }
): PushDeliveryWorker | undefined {
  if (mode === "off") return undefined;
  const { queue, transport } = dependencies();
  return new PushDeliveryWorker(queue, transport, { mode });
}

export class PushDeliveryWorker {
  private haltCode: string | undefined;
  public get haltReason(): string | undefined {
    return this.haltCode;
  }
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  public constructor(
    private readonly queue: PushDeliveryQueue,
    private readonly transport: PushTransport,
    private readonly options: {
      mode?: "off" | "shadow" | "apns";
      leaseMs?: number;
      timeoutMs?: number;
      maximumAttempts?: number;
    } = {}
  ) {
    this.leaseMs = options.leaseMs ?? 45_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumAttempts = options.maximumAttempts ?? 10;
    if (
      ![this.leaseMs, this.timeoutMs, this.maximumAttempts].every(
        Number.isSafeInteger
      ) ||
      this.leaseMs < 100 ||
      this.leaseMs > 300_000 ||
      this.timeoutMs < 1 ||
      this.timeoutMs >= this.leaseMs ||
      this.maximumAttempts < 1 ||
      this.maximumAttempts > 100
    )
      throw new Error("PUSH_WORKER_OPTIONS_INVALID");
  }
  public async runOnce(
    signal: AbortSignal = new AbortController().signal
  ): Promise<PushStep> {
    if ((this.options.mode ?? "off") === "off") return "OFF";
    if (this.haltCode) return "STOPPED";
    if (signal.aborted) return "STOPPED";
    if (this.options.mode === "shadow" && this.transport.mode !== "fake")
      throw new Error("PUSH_REAL_TRANSPORT_FORBIDDEN");
    if (this.options.mode === "apns" && this.transport.mode !== "apns")
      throw new Error("PUSH_TRANSPORT_MODE_MISMATCH");
    const claim = await this.queue.claimOne(this.leaseMs);
    if (!claim) return "IDLE";
    if (signal.aborted) return "STOPPED";
    const input = await this.queue.prepare(
      claim,
      this.options.mode === "apns" ? "apns" : "fake"
    );
    let outcome: PushDeliveryOutcome;
    if (!input)
      outcome = { state: "CANCELLED", code: "TARGET_OR_RECIPIENT_INELIGIBLE" };
    else if (claim.attemptCount > this.maximumAttempts)
      outcome = { state: "PERMANENT_FAILURE", code: "RETRY_EXHAUSTED" };
    else {
      const cancellation = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      let timedOut = false;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          stop = () => {
            cancellation.abort();
            reject(new Error("PUSH_STOPPED"));
          };
          signal.addEventListener("abort", stop, { once: true });
          timer = setTimeout(() => {
            timedOut = true;
            cancellation.abort();
            reject(new Error("PUSH_TIMEOUT"));
          }, this.timeoutMs);
        });
        if (signal.aborted) stop?.();
        // External side effects MUST stay outside DB transactions and retry closures.
        // A crash after acceptance can repeat send; stable idempotencyKey, not lease fencing, deduplicates the Fake receipt.
        const result = await Promise.race([
          interrupted,
          signal.aborted
            ? Promise.reject(new Error("PUSH_STOPPED"))
            : this.transport.send(input, cancellation.signal)
        ]);
        outcome = pushOutcome(result, claim.attemptCount, this.transport.mode);
        // Set the latch BEFORE finish: even a DB failure must not allow more claims.
        if (
          this.transport.mode === "apns" &&
          result.kind !== "ACCEPTED" &&
          ["APNS_CONFIG", "APNS_FORBIDDEN", "APNS_PAYLOAD_TOO_LARGE"].includes(
            result.code
          )
        )
          this.haltCode = result.code;
      } catch {
        if (signal.aborted) return "STOPPED";
        outcome = {
          state: "RETRY_WAIT",
          code: timedOut ? "TRANSPORT_TIMEOUT" : "TRANSPORT_ERROR",
          delayMs: retryDelayMs(claim.attemptCount)
        };
      } finally {
        clearTimeout(timer);
        if (stop) signal.removeEventListener("abort", stop);
      }
    }
    if (signal.aborted) return "STOPPED";
    if (
      outcome.state === "RETRY_WAIT" &&
      claim.attemptCount >= this.maximumAttempts
    )
      outcome = { state: "PERMANENT_FAILURE", code: "RETRY_EXHAUSTED" };
    return (await this.queue.finish(claim, outcome))
      ? outcome.state
      : "LEASE_LOST";
  }
}

export function pushOutcome(
  result: PushTransportResult,
  attempts: number,
  mode: "fake" | "apns" = "fake"
): PushDeliveryOutcome {
  if (
    result?.kind === "ACCEPTED" &&
    validProviderRequestId(result.providerRequestId)
  )
    return {
      state: "PROVIDER_ACCEPTED",
      providerRequestId: result.providerRequestId
    };
  if (
    result?.kind === "RETRY" &&
    (mode === "fake"
      ? ["HTTP_429", "HTTP_5XX", "FAKE_TRANSIENT"]
      : [
          "HTTP_429",
          "HTTP_5XX",
          "APNS_CONNECTION",
          "APNS_TOKEN_REFRESH",
          "APNS_CONFIG",
          "APNS_FORBIDDEN",
          "APNS_PAYLOAD_TOO_LARGE"
        ]
    ).includes(result.code) &&
    Number.isSafeInteger(result.retryAfterMs) &&
    result.retryAfterMs >= 0 &&
    result.retryAfterMs <= maximumPushRetryDelayMs
  ) {
    const code =
      mode === "apns"
        ? (result.code as ApnsFailureCode | "HTTP_429" | "HTTP_5XX")
        : result.code === "HTTP_429"
          ? "HTTP_429"
          : result.code === "HTTP_5XX"
            ? "HTTP_5XX"
            : "FAKE_TRANSIENT";
    return {
      state: "RETRY_WAIT",
      code,
      delayMs: Math.max(retryDelayMs(attempts), result.retryAfterMs)
    };
  }
  if (
    result?.kind === "PERMANENT" &&
    (mode === "fake"
      ? ["HTTP_410", "FAKE_PERMANENT"]
      : [
          "HTTP_410",
          "APNS_BAD_DEVICE_TOKEN",
          "APNS_TOKEN_NOT_FOR_TOPIC",
          "APNS_TARGET_STALE"
        ]
    ).includes(result.code)
  )
    return {
      state:
        result.code === "APNS_TARGET_STALE" ? "CANCELLED" : "PERMANENT_FAILURE",
      code:
        mode === "apns"
          ? (result.code as ApnsFailureCode | "HTTP_410")
          : result.code === "HTTP_410"
            ? "HTTP_410"
            : "FAKE_PERMANENT"
    };
  // Arbitrary provider text/status objects are never persisted or printed.
  return { state: "PERMANENT_FAILURE", code: "TRANSPORT_RESULT_INVALID" };
}
