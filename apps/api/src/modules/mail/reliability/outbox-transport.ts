// PR03a has NO device registry, APNs client, SMTP, SSE or real delivery adapter.
// A future APNs adapter needs separate durable delivery rows/endpoint versions:
// docs/reliability-plan/later/apns-boundary.md. FAKE_COMPLETED is not acceptance.
export interface OutboxTransportInput {
  readonly outboxId: string;
  readonly eventKey: string;
  readonly teamId: string;
  readonly alertId: string;
  readonly recipientId: string;
  readonly attemptId: string;
}

export type OutboxTransportResult =
  | { readonly kind: "FAKE_COMPLETED" }
  | { readonly kind: "RETRY"; readonly code: "FAKE_TRANSIENT" }
  | { readonly kind: "PERMANENT"; readonly code: "FAKE_PERMANENT" };

export interface OutboxTransport {
  readonly mode: "fake";
  // eventKey is stable across attempts. Consumers MUST deduplicate with it.
  // AbortSignal is cooperative cancellation, not proof of external cancellation.
  send(
    input: OutboxTransportInput,
    signal: AbortSignal
  ): Promise<OutboxTransportResult>;
}

export class FakeTransport implements OutboxTransport {
  public readonly mode = "fake";
  public async send(
    _input: OutboxTransportInput,
    signal: AbortSignal
  ): Promise<OutboxTransportResult> {
    signal.throwIfAborted();
    return { kind: "FAKE_COMPLETED" };
  }
}
