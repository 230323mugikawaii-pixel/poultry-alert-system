// Isolated CLI-loop test. No database, key, token, network, or environment credentials.
import { PushDeliveryWorker } from "../../src/modules/device-push/push-delivery-worker.js";
import { runPushWorkerLoop } from "../../src/modules/device-push/push-worker-loop.js";

let claims = 0;
const states: string[] = [];
const worker = new PushDeliveryWorker(
  {
    claimOne: async () => {
      claims++;
      return {
        id: "synthetic",
        leaseToken: "synthetic",
        leaseGeneration: 1n,
        attemptCount: 1
      };
    },
    prepare: async () => ({
      deliveryId: "synthetic",
      alertId: "synthetic",
      recipientId: "synthetic",
      endpointKey: "synthetic",
      endpointVersion: 1,
      attemptId: "synthetic",
      idempotencyKey: "synthetic"
    }),
    finish: async (_claim, outcome) => {
      states.push(outcome.state);
      return true;
    }
  },
  {
    mode: "apns",
    send: async () => ({
      kind: "RETRY",
      code: "APNS_CONFIG",
      retryAfterMs: 300000,
      stop: true
    })
  },
  { mode: "apns" }
);
process.exitCode = await runPushWorkerLoop(worker, {
  signal: new AbortController().signal,
  once: false,
  step: () => {},
  error: () => {}
});
process.stdout.write(JSON.stringify({ claims, states }));
