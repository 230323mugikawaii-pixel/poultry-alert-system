import { createHash } from "node:crypto";

// No plaintext token, URL, credentials or message body crosses this boundary.
// APNs alone receives the version-bound ciphertext and a final eligibility recheck.
export interface PushTransportInput {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly alertId: string;
  readonly recipientId: string;
  readonly endpointKey: string;
  readonly endpointVersion: number;
  readonly attemptId: string;
  readonly encryptedToken?: string;
  readonly confirmCurrent?: () => Promise<boolean>;
}
export type PushTransportResult =
  | { readonly kind: "ACCEPTED"; readonly providerRequestId: string }
  | {
      readonly kind: "RETRY";
      readonly retryAfterMs: number;
      readonly code: string;
      readonly stop?: true;
    }
  | { readonly kind: "PERMANENT"; readonly code: string; readonly stop?: true };
export interface PushTransport {
  readonly mode: "fake" | "apns";
  send(
    input: PushTransportInput,
    signal: AbortSignal
  ): Promise<PushTransportResult>;
}

export function pushIdempotencyKey(
  outboxId: string,
  targetKey: string,
  targetVersion: number
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "push-v1",
        outboxId.toLowerCase(),
        targetKey.toLowerCase(),
        targetVersion
      ])
    )
    .digest("hex");
}

export class FakePushTransport implements PushTransport {
  public readonly mode = "fake";
  public async send(
    input: PushTransportInput,
    signal: AbortSignal
  ): Promise<PushTransportResult> {
    signal.throwIfAborted();
    // Deterministic synthetic receipt across restarts. No Apple request is made.
    // Real transport retries after crash MAY send twice: fencing is not external exactly-once.
    // Receiver/provider idempotency must be independently implemented/verified in 07c+.
    const bytes = createHash("sha256")
      .update(`fake-push-v1:${input.idempotencyKey}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return {
      kind: "ACCEPTED",
      providerRequestId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    };
  }
}
