# APNs boundary — design only, not enabled by the five-core rollout

APNs and native device registration are not presently implemented. Do not mark a
fake transport or an SSE hint as APNs acceptance. Core completion ends at a durable
notification intent. Add this delivery table only in the subsequent APNs integration
PR, after an authenticated device registry for both OWNER and NotificationMember exists.
The current Device model is User-only; do not treat a NotificationMember ID as a User ID.

```prisma
enum NotificationDeliveryState {
  PENDING
  IN_FLIGHT
  RETRY_WAIT
  WAITING_CONFIGURATION
  PROVIDER_ACCEPTED
  PERMANENT_FAILURE
  CANCELLED
}

model NotificationDelivery {
  id                 String                    @id @default(uuid()) @db.Uuid
  outboxId           String                    @db.Uuid
  // Opaque stable ID from the future authenticated endpoint registry.
  // Resolve/refcheck before processing; add its real FK once that registry is designed.
  targetKey          String                    @db.VarChar(191)
  targetVersion      Int
  state              NotificationDeliveryState @default(PENDING)
  attemptCount       Int                       @default(0)
  nextAttemptAt      DateTime                  @default(now()) @db.Timestamptz(3)
  leaseToken         String?                   @db.Uuid
  leaseGeneration    BigInt                    @default(0)
  leaseUntil         DateTime?                 @db.Timestamptz(3)
  apnsRequestId      String?                   @db.Uuid
  acceptedAt         DateTime?                 @db.Timestamptz(3)
  lastErrorCode      String?                   @db.VarChar(100)
  createdAt          DateTime                  @default(now()) @db.Timestamptz(3)
  outbox             ReliabilityOutbox        @relation(fields: [outboxId], references: [id], onDelete: Restrict)

  @@unique([outboxId, targetKey, targetVersion])
  @@index([state, nextAttemptAt])
  @@map("notification_deliveries")
}
// Add NotificationDelivery[] to ReliabilityOutbox in that later PR only.
```

```ts
interface PushTransport {
  send(input: {
    alertId: string;
    recipientId: string;
    endpointKey: string;
    endpointVersion: number;
    attemptId: string;
  }): Promise<
    | { kind: 'ACCEPTED'; providerRequestId: string }
    | { kind: 'RETRY'; retryAfterMs: number; code: string }
    | { kind: 'PERMANENT'; code: string }
  >;
}
```

Dispatcher transaction: recheck live recipient/Team and transport configuration,
resolve authorized endpoint IDs, insert delivery rows ON CONFLICT DO NOTHING, then
mark the parent outbox dispatched. Missing mobile configuration is blocked/waiting,
not accepted. A disabled mobile feature does not create mobile intents in the first place.

APNs worker: claim delivery -> resolve latest valid token version -> send outside DB
transaction -> fence result persistence. A 410 only disables that token version,
not a newer registration. 429/5xx/transient failures retry with provider-aware delay.
An acceptance followed by a worker crash can cause a repeated APNs request; database
uniqueness and collapse IDs reduce duplicate presentation, but do not guarantee
exactly-once OS presentation. Recipient read/ack states remain separate.
