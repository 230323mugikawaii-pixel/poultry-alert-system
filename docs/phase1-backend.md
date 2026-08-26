# Phase 1 backend foundation

## Scope

Phase 1 provides the server-side foundation. Google User/Session login and mail
monitoring authorization are separate OAuth boundaries.

Implemented areas:

- HTTPS JSON API suitable for Cloud Run
- PostgreSQL schema and tracked migrations
- Required email address and one-time magic-link login
- Server-side Google authorization-code login with state, PKCE, and verified ID
  tokens (`openid`, `email`, and `profile` only)
- Google external identities bound by the stable provider subject rather than by
  an untrusted browser email value
- OWNER-managed Gmail and Microsoft mail authorization with provider adapters,
  `gmail.readonly` or delegated `Mail.Read`, offline consent, encrypted refresh-token
  storage, reauthorization, provider switching, and revocation
- Individual, revocable, device-associated sessions
- Future Passkey credential and challenge storage
- No Call Now password credential type, hash storage, or password login route
- Team, OWNER/MEMBER membership, subscription, and additional-member seat limits
- Idempotent initial Team bootstrap after first paid setup; existing OWNER/MEMBER
  roles are preserved and concurrent initialization cannot create duplicate Teams
- Hashed capacity invitations and one-use LINE invitation links
- Transactional join and member-removal operations
- Server-side OWNER authorization and audit events
- Local, CI, staging, and production configuration boundaries
- Secret Manager and Workload Identity Federation deployment path
- Separate non-root runtime and migration container targets; the API runtime contains
  production dependencies only and does not include the Prisma CLI toolchain

Deferred until later phases:

- Production payment provider and billing webhook
- Continuous Gmail/Graph monitoring and notification delivery
- Notification delivery transport
- Passkey registration and authentication ceremonies
- OWNER transfer completion, which also requires the new OWNER mail connection
- Explicit linking for an existing magic-link User that has the same email as a
  newly authenticated Google identity
- Existing localStorage contract/team migration and production cutover

## Local development

1. Copy `.env.example` to an ignored `.env` file and replace local values as needed.
2. Start PostgreSQL and Mailpit with `docker compose up -d`.
3. Install dependencies with `pnpm install`.
4. Generate the client with `pnpm db:generate`.
5. Apply migrations with `pnpm db:migrate:deploy`.
6. Start the API with `pnpm dev:api`.
7. Serve the static frontend at `http://127.0.0.1:5500`.

For local frontend development, an empty `call-now-api-origin` meta value resolves
to port 8080 on `localhost` or `127.0.0.1`. Staging and production must set this to
the deployed API origin, or serve the API behind the same origin. The frontend and
API should use hosts under the same registrable domain so SameSite=Lax cookies work
without weakening the cookie policy.

Run `pnpm test:postgres` only against a dedicated database whose name contains
`test` or `acceptance`. This suite truncates data in that database and verifies
real PostgreSQL transaction behavior, including concurrent redemption of the last
available seats. It also covers mail credential encryption/revocation,
paid-increase idempotency, safe and pending
reductions, parent/link invalidation and expiration, member access revocation,
shared security throttles, and multi-team membership rules.

Mailpit is available on port 8025. Magic-link values are delivered to Mailpit rather
than printed to logs.

## Security boundaries

- Six-digit team IDs are public locators, not authenticators.
- Magic links, sessions, LINE links, and join grants use high-entropy random tokens.
- Only token hashes are stored in PostgreSQL.
- Invitation passwords use Argon2id.
- Mutation endpoints require the configured same Origin.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in staging/production.
- OAuth state is one-use, short-lived, HMACed in PostgreSQL, and paired with a
  host-only HttpOnly state cookie, PKCE verifier, and verified OIDC nonce.
- Google login tokens are not stored. Mail access tokens are not persisted; Google and
  Microsoft refresh tokens are encrypted server-side with AES-256-GCM for local/test and
  Google Cloud KMS for staging/production.
- Sensitive request fields and authentication headers are redacted from logs.
- Five failed invitation-password attempts lock the team/source pair for 15 minutes.
- Security-sensitive rate limits are stored in PostgreSQL and shared by all API
  instances. Keys are HMACs over source and action-specific subjects such as email,
  invitation, team, link token, or user ID; raw values are not stored in the throttle
  table.
- Team capacity is checked again inside a serializable transaction.
- MEMBER removal revokes sessions and disables notification targets immediately.

## Migration rules

Production uses `prisma migrate deploy`; it never uses `migrate dev`. A migration job
must finish successfully before a new API revision is deployed. Production backups
and point-in-time recovery must be enabled and a restore test completed before user
migration begins.

Legacy `localStorage.googleEmail` values are removed from active contract storage
and are never accepted as proof of identity. A Google login creates a new User only
when no matching provider subject and no existing User email exists. A same-email
existing User is rejected with `GOOGLE_ACCOUNT_LINK_REQUIRED` until an explicit,
authenticated account-linking flow is implemented; email equality alone must never
auto-link accounts.
