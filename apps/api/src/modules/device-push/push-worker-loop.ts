import { setTimeout as delay } from "node:timers/promises";
import type { PushDeliveryWorker } from "./push-delivery-worker.js";

// Shared by the independent CLI and local-only tests; no transport/env construction here.
export async function runPushWorkerLoop(
  worker: PushDeliveryWorker,
  options: {
    signal: AbortSignal;
    once: boolean;
    step: (value: string) => void;
    error: (code: string) => void;
  }
): Promise<0 | 1> {
  do {
    let failed = false;
    try {
      options.step(await worker.runOnce(options.signal));
    } catch {
      failed = true;
      options.error("PUSH_WORKER_DATABASE_ERROR");
    }
    if (worker.haltReason) {
      options.error(worker.haltReason);
      return 1;
    }
    if (options.once) return failed ? 1 : 0;
    if (options.signal.aborted) return 0;
    try {
      await delay(1000, undefined, { signal: options.signal });
    } catch {
      return 0;
    }
  } while (!options.signal.aborted);
  return 0;
}
