import type { OutboxQueue, OutboxOutcome } from "./prisma-outbox-queue.js";
import type { MobileDeliveryPlanner } from "../../device-push/mobile-delivery-planner.js";
import type {
  OutboxTransport,
  OutboxTransportResult
} from "./outbox-transport.js";

export function outboxDispatchMode(value: string | undefined): "off" | "fake" {
  if (value === undefined || value === "off") return "off";
  if (value === "fake") return "fake";
  throw new Error("OUTBOX_DISPATCH_MODE_INVALID");
}

export function retryDelayMs(attempts: number): number {
  return Math.min(
    1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 12),
    300_000
  );
}

export type DispatchStep =
  "OFF" | "IDLE" | "STOPPED" | "LEASE_LOST" | OutboxOutcome["status"];

export class OutboxDispatcher {
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  public constructor(
    private readonly queue: OutboxQueue,
    private readonly transport: OutboxTransport,
    private readonly options: {
      readonly mode?: "off" | "fake";
      readonly mobileDeliveryMode?: "off" | "shadow" | "apns";
      readonly mobilePlanner?: MobileDeliveryPlanner;
      readonly leaseMs?: number;
      readonly timeoutMs?: number;
      readonly maximumAttempts?: number;
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
      throw new Error("OUTBOX_WORKER_OPTIONS_INVALID");
  }

  public async runOnce(
    signal: AbortSignal = new AbortController().signal
  ): Promise<DispatchStep> {
    if ((this.options.mode ?? "off") === "off") return "OFF";
    if (signal.aborted) return "STOPPED";
    if (
      (this.options.mobileDeliveryMode === "shadow" ||
        this.options.mobileDeliveryMode === "apns") &&
      !this.options.mobilePlanner
    )
      throw new Error("MOBILE_PLANNER_REQUIRED");
    if (this.transport.mode !== "fake")
      throw new Error("OUTBOX_REAL_TRANSPORT_FORBIDDEN");
    const claim = await this.queue.claimOne(this.leaseMs);
    if (!claim) return "IDLE";
    if (signal.aborted) return "STOPPED"; // Leave recoverable lease, never fake success.
    if (
      this.options.mobileDeliveryMode === "shadow" ||
      this.options.mobileDeliveryMode === "apns"
    ) {
      if (claim.attempts > this.maximumAttempts)
        return (await this.queue.finish(claim, {
          status: "BLOCKED",
          code: "RETRY_EXHAUSTED"
        }))
          ? "BLOCKED"
          : "LEASE_LOST";
      // No FakeTransport/PushTransport call: record-only mobile planning is atomic in its own DB TX.
      return this.options.mobilePlanner!.plan(claim, signal);
    }
    const input = await this.queue.prepare(claim);
    let outcome: OutboxOutcome;
    if (!input) outcome = { status: "BLOCKED", code: "RECIPIENT_INELIGIBLE" };
    else if (claim.attempts > this.maximumAttempts)
      outcome = { status: "BLOCKED", code: "RETRY_EXHAUSTED" };
    else {
      const cancellation = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          stop = () => {
            cancellation.abort();
            reject(new Error("STOPPED"));
          };
          signal.addEventListener("abort", stop, { once: true });
          timer = setTimeout(() => {
            cancellation.abort();
            reject(new Error("TRANSPORT_TIMEOUT"));
          }, this.timeoutMs);
        });
        if (signal.aborted) stop?.();
        // Not inside a DB transaction/retry. Late resolution cannot finish an old claim.
        const result = await Promise.race([
          interrupted,
          signal.aborted
            ? Promise.reject(new Error("STOPPED"))
            : this.transport.send(input, cancellation.signal)
        ]);
        outcome = transportOutcome(result, claim.attempts);
      } catch (error) {
        if (signal.aborted) return "STOPPED";
        outcome = {
          status: "RETRY_WAIT",
          code:
            cancellation.signal.aborted &&
            error instanceof Error &&
            error.message === "TRANSPORT_TIMEOUT"
              ? "TRANSPORT_TIMEOUT"
              : "TRANSPORT_ERROR",
          delayMs: retryDelayMs(claim.attempts)
        };
      } finally {
        clearTimeout(timer);
        if (stop) signal.removeEventListener("abort", stop);
      }
    }
    if (signal.aborted) return "STOPPED";
    if (
      outcome.status === "RETRY_WAIT" &&
      claim.attempts >= this.maximumAttempts
    )
      outcome = { status: "BLOCKED", code: "RETRY_EXHAUSTED" };
    return (await this.queue.finish(claim, outcome))
      ? outcome.status
      : "LEASE_LOST";
  }
}

function transportOutcome(
  result: OutboxTransportResult,
  attempts: number
): OutboxOutcome {
  // Runtime allowlist: arbitrary provider errors/response text never reach the DB.
  if (result?.kind === "FAKE_COMPLETED") return { status: "DISPATCHED" };
  if (result?.kind === "RETRY" && result.code === "FAKE_TRANSIENT")
    return {
      status: "RETRY_WAIT",
      code: result.code,
      delayMs: retryDelayMs(attempts)
    };
  if (result?.kind === "PERMANENT" && result.code === "FAKE_PERMANENT")
    return { status: "BLOCKED", code: result.code };
  return { status: "BLOCKED", code: "TRANSPORT_RESULT_INVALID" };
}
