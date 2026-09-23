# PR01 implementation and verification — 2026-09-23

Scope: step-01 only. Base `b5e85a1697c38e1133c7792d744467e5f83f444d`,
design commit `66cb0fe04ec9fb62d1fd6676d5dc055716cbc28f`.
The design's old test results are **not** evidence for this implementation.

## Behavior and boundaries

- `MAIL_LEDGER_MODE=off` is the default. The server/CLI do not construct/inject
  the ledger observer, and the Gmail path does not access either ledger table.
- `legacy` adds observation to the existing Gmail message path, not another
  notification producer. No worker, Outbox, Microsoft ingress or LIVE path.
- Discover uses PostgreSQL `INSERT ... ON CONFLICT DO NOTHING` for both the
  unique `messageKey` and `(messageId, lane)`, followed by raw identity and
  Team/provider/authorization/connection checks. No SELECT-then-INSERT dedup.
- IDs/rule snapshot persist before message retrieval. Transient failures retain
  pending state and a constant safe error code, and propagate for existing retry.
- Message GET 404 records `UNDETERMINED / MESSAGE_GET_404`, no decision timestamp,
  and an unresolved timestamp. Automatic redelivery does not endlessly refetch.
  This is **not** a successful match/non-match. History-list 404 still uses the
  existing bounded recovery and monitoring-resume boundary.
- The existing Alert repository, unique `(sourceMailConnectionId, sourceEventId)`,
  transaction with recipients/audit, and post-commit SSE hint are unchanged.
- PR01 still has an Alert-commit/ledger-finalization window. Redelivery first
  looks for the existing Alert and links it, even if Gmail can no longer return
  the message. It does not recreate recipients, reset read/dismissed/resolved
  state or emit another created-Alert SSE hint. Polling remains the fallback.
- Ledger link and MATCHED evaluation are committed together, **separately from
  Alert creation**. Full Alert/ledger atomicity is deferred to PR02b.
- Updates never regress a final result to pending. A verified existing Alert
  takes precedence over a concurrent earlier non-match/404 observation; this
  repair can only promote the result to MATCHED, never undo it or change its link.
- No body, snippet, attachment, OAuth token, raw provider exception or connection
  URL is stored in the new tables or logged. Rules/keyword snapshots are stored.

## Differences from the proposal

1. Only the `LEGACY` enum value is introduced. SHADOW/LIVE remain future work.
2. The actual Gmail domain field is `authorizationId`; the DB column is
   `mailAuthorizationId`. Both refer to the existing `MailAuthorization.id`.
   Its single-column PK and `[id, provider]` UNIQUE are unchanged.
3. Existing-Alert lookup precedes body refetch/final-state short circuit, so a
   crash followed by provider deletion or label changes does not lose the link.
4. Conditional state updates and a row lock for finalization protect monotonic
   state/link updates. No external API I/O is inside these transactions.
5. The current connection must match the first connection. Existing
   `(teamId, mailAuthorizationId)` uniqueness and reauthorization/reconnect tests
   establish ID stability; an unexpected different connection is rejected.
6. UUID case is normalized, exact provider ID bytes are not. Control characters
   are rejected using character codes (same semantics as design regex; conforms
   to repository lint). Gmail source IDs stay raw. The Microsoft-only helper
   returns `m1:` plus 64 hex characters; no Microsoft worker is introduced.

## Migration and isolation

New append-only migration: `20260923000100_mail_message_ledger` (25th).
Generated with Prisma migrate diff against the real PostgreSQL baseline.
It only creates two enums, two tables, their indexes and foreign keys. Existing
tables/PKs/unique constraints/data are not altered. NOT NULL fields are only in
new empty tables; timestamps/revision/state/snapshot have appropriate defaults.

Local test server: dedicated PostgreSQL 17 Docker container
`call-now-ledger-pr01-pg17-20260923`, loopback port `25439`, tmpfs data directory,
database `callnow_ledger_test` (initial run), then a fresh `callnow_test` on this
same isolated container for final replay. No existing volume or running E2E DB was used.
Tests require `PR01_TEST_ISOLATION_ACK=disposable-postgres`, a local test database,
and PostgreSQL 17. Connection strings/credentials are deliberately omitted here.

Two distinct checks:

1. `prisma migrate deploy` creates the normal real history: **25/25 applied,
   pending 0**; `prisma migrate diff` reports **no difference**.
2. The round-trip test creates its own uniquely named database on that same
   disposable server, executes the 24 old SQL migrations, seeds synthetic
   User/Team/Subscription/authorization/connection/Alert/recipient/audit data,
   then executes **up → down → up**. It compares all pre-existing table rows,
   columns, constraints and indexes, before/after: **unchanged**. The down SQL
   drops only the two new tables and enums, without CASCADE.

The round-trip database deliberately has no `_prisma_migrations`: this proves
SQL reversibility, not a fictitious Prisma rollback. The normal deployment
database history is never edited. Prisma has no automatic down-migration here.
Do not execute this test down SQL on an application DB or delete an applied
history row to make deploy run again. Operational rollback is flag-off first;
schema removal, if ever needed, requires a separately reviewed forward migration
and a decision about retaining ledger evidence. No operational rollback was run.

Only the freshly created synthetic round-trip DB is removed by test cleanup.

## Tests executed against this implementation

Real PostgreSQL acceptance: **17/17 passed**, 4.15 seconds in the recorded run.
The PostgreSQL suite uses real persistence/AlertService/repositories and simulated
provider responses; it does not call Gmail/OAuth/SMTP. Parallel delivery bypasses
the normal connection lease in its test adapter to actually stress message-level
deduplication with 100 concurrent invocations of the real Gmail service.

| Test | Observed result |
|---|---|
| 100 sequential deliveries | 635 ms; ledger 1, LEGACY evaluation 1, Alert 1, recipients 2, creation audit 1 |
| 100 parallel deliveries | 756 ms; same counts; one created-Alert SSE hint |
| SIGKILL before body fetch | Parent verifies committed FETCH_PENDING; kills child; **new OS process** completes once |
| SIGKILL after Alert commit | Parent verifies Alert exists and ledger not linked; kills child; **new OS process** links existing Alert; no refetch/fan-out |
| Message GET 404 + 100 redeliveries | UNDETERMINED persists; fetch count 1; no Alert; no history recovery |
| History 404/resume boundary | Existing recovery invoked; paused-period message EXCLUDED; Alert count 0 |
| Existing resolved/read/dismissed Alert | Alert, recipients and audit byte-for-byte unchanged |
| Flag off | No ledger model access; legacy Alert created; also verified before ledger tables exist in round-trip DB |
| Transient provider failure | Pending safe code; retry succeeds; body/token markers absent |
| Conflict/scope guards | Injected key/raw-ID collision and Team/mailbox/provider mismatch rejected |
| Long Microsoft ID | Complete TEXT preserved; no Alert or Microsoft ingress |
| NOT_MATCHED | Durable; no repeat fetch or Alert |
| EXCLUDED | Durable; no repeat fetch or Alert |
| Concurrent 404 vs committed Alert | Existing Alert wins and links once; late 404 cannot undo MATCHED |
| Delayed writes/redelivery | Final state/link/rule snapshot not reset |
| Reauthorization/reconnect | Verified-subject authorization and connection IDs stable; identical email with different subjects not merged |
| Migration round trip | up/down/up success; synthetic baseline unchanged; managed DB 25/25, pending 0 |

Additional checks:

- `pnpm verify`: frontend tests, format, lint, typecheck, API tests and build pass.
  API suite: 250 passed; separately gated PostgreSQL tests are not counted as
  successes when skipped by this command.
- `pnpm test:postgres`: existing real-PostgreSQL integration **26/26 passed**.
- `pnpm db:validate`, `pnpm db:generate`, `pnpm db:check-drift`: pass.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities reported.
- `git diff --check`: pass.
- Changed-file secret-pattern scan: no new findings. Ten connection-string
  patterns were already present in baseline examples/test configuration; no
  values were emitted. This is a targeted pattern check, not a full gitleaks scan.
- New real PostgreSQL acceptance is an explicit CI step after migration deploy,
  drift check and existing PostgreSQL tests. Latest-commit CI evidence is linked
  from the PR; this document does not substitute for that run.

Reproduction (only with an isolated, disposable PostgreSQL 17 selected via the
environment, never an E2E/normal/production URL):

```sh
pnpm install --frozen-lockfile
pnpm db:validate
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:check-drift
pnpm test:postgres
PR01_TEST_ISOLATION_ACK=disposable-postgres pnpm test:postgres:ledger
pnpm verify
```

## Unexecuted / deliberately excluded

- No real Gmail mail/OAuth/watch, browser, cloud or production validation in this
  PR. Existing Gmail regression tests cover the unchanged path; no real email sent.
- No migration applied to running E2E/normal/production databases. Feature flag
  was not enabled in any existing runtime.
- No background recovery worker: process restart/redelivery is explicitly driven
  by the test. Pending work needs existing redelivery/retry, not a new scheduler.
- No Outbox or end-to-end exactly-once delivery claim. A post-commit SSE hint may
  be missed on crash; durable recipients and the existing polling fallback remain.
- `later/` untouched, Phase 2 not started, no main merge/deploy/cloud changes.

## Implementation file inventory (relative to design commit)

Schema/migration:

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260923000100_mail_message_ledger/migration.sql`

Runtime/configuration:

- `.env.example` (flag default only; no local `.env` changes)
- `apps/api/src/config/env.ts`
- `apps/api/src/server.ts`
- `apps/api/src/cli/gmail-renew-watches.ts`
- `apps/api/src/modules/mail/gmail/gmail-monitoring-service.ts`
- `apps/api/src/modules/mail/reliability/message-key.ts`
- `apps/api/src/modules/mail/reliability/prisma-mail-ledger.ts`

Acceptance tests and fixtures:

- `apps/api/tests/mail-message-key.test.ts`
- `apps/api/tests/mail-ledger.postgres.integration.test.ts`
- `apps/api/tests/mail-ledger-migration.postgres.integration.test.ts`
- `apps/api/tests/fixtures/mail-ledger-harness.ts`
- `apps/api/tests/fixtures/mail-ledger-crash-child.ts`
- `apps/api/tests/fixtures/mail-ledger-down.sql`

Existing typed environment fixtures (add `MAIL_LEDGER_MODE: "off"` only):

- `apps/api/tests/alert-routes.test.ts`
- `apps/api/tests/app.test.ts`
- `apps/api/tests/auth-routes.test.ts`
- `apps/api/tests/google-auth-routes.test.ts`
- `apps/api/tests/mail-connection.test.ts`
- `apps/api/tests/team-routes.test.ts`
- `apps/api/tests/user-communication-routes.test.ts`

Test wiring/evidence:

- `.github/workflows/ci.yml`
- `package.json`
- `apps/api/package.json`
- `docs/reliability-plan/step-01-implementation-results.md` (this document)
