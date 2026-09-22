# Existing-model integration notes — proposal, not an applied migration

Baseline inspected: `b5e85a1697c38e1133c7792d744467e5f83f444d`.
Do not replace any existing model. Append fields only in the relevant PR.

## Step 01 reciprocal fields

```prisma
// Team
mailLedgerMessages MailMessageLedger[]

// MailAuthorization
mailLedgerMessages MailMessageLedger[]

// MailConnection
mailLedgerMessages MailMessageLedger[]
mailEvaluations MailEvaluation[]

// Alert
mailLedgerMessage MailMessageLedger?
```

`MailAuthorization.id` is the initial stable mailbox ID. This is valid only if
reauthorization retains the same row identified by the verified provider subject.
Enforce that invariant in tests. Do not delete/recreate that row on disconnect.
Google/Microsoft credential migration or multiple IDs for one mailbox needs an
explicit alias migration; never automatically merge mailboxes by email address.
Shared/delegated Microsoft mailboxes are outside this proposal.

## Later reciprocal fields

```prisma
// MailConnection
monitoringState MonitoringState?
monitoringEpochs MonitoringEpoch[]
mailSyncStreams MailSyncStream[]
syntheticProbes SyntheticProbe[]

// MailAuthorization
providerRegistrations ProviderRegistration[]

// MailEvaluation
monitoringEpochId String? @db.Uuid
monitoringEpoch MonitoringEpoch? @relation(fields: [monitoringEpochId], references: [id], onDelete: Restrict)
batchItems MailSyncBatchItem[]

// Team
reliabilityOutbox ReliabilityOutbox[]

// Alert
reliabilityOutbox ReliabilityOutbox[]
syntheticRuns SyntheticRun[]
@@unique([id, teamId])

// AlertRecipient
reliabilityOutbox ReliabilityOutbox[]
@@unique([id, alertId])
```

## MailAuthorization — OAuth lock/cache PR only

```prisma
credentialVersion Int @default(0)
refreshLeaseToken String? @db.Uuid
refreshLeaseGeneration BigInt @default(0)
refreshLeaseUntil DateTime? @db.Timestamptz(3)
encryptedAccessToken String? @db.Text
accessTokenExpiresAt DateTime? @db.Timestamptz(3)
refreshRetryAt DateTime? @db.Timestamptz(3)
lastRefreshAt DateTime? @db.Timestamptz(3)
lastRefreshError String? @db.VarChar(100)
@@index([refreshRetryAt])
```

Reuse the existing encryptedRefreshToken/encryptionProvider/encryptionKeyVersion.
Use the existing encryption envelope implementation. Encrypt access tokens too.
A reauthorization, revocation, or credential replacement increments credentialVersion
and clears cached access credentials/leases so that late workers cannot overwrite it.
Never hold a DB transaction open across an OAuth HTTP call.

## Important invariants not expressible by foreign keys alone

- The ledger's Team, mailbox, and first connection must match the actual connection.
- Evaluations must belong to that message's Team and mailbox.
- LIVE/MATCHED must have a corresponding Alert in the same transaction; SHADOW/MATCHED
  must NOT create Alert/recipient/outbox records.
- Existing sourceMailConnectionId/sourceEventId uniqueness stays in place.
- Before enabling LIVE, link previously created Alerts to ledger messages without
  recreating recipients or Outbox events. Gmail legacy IDs remain raw sourceEventId.
- Microsoft IDs must not be truncated to fit Alert.sourceEventId (191 characters).
  For newly implemented Microsoft ingress use `m1:<messageKey>` as sourceEventId;
  keep the full provider ID in the ledger. Do not rename old Gmail event IDs.
- Keep strict least-privilege tenant checks for reads, writes and status APIs.

Validate the merged schema and generated migration against an isolated PostgreSQL
before enabling a feature flag. The supplied schemas have not been migrated into
the user's database. Do not use db push or migrate reset on an existing database.
