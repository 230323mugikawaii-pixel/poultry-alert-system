# Phase 1 backend foundation

## Scope

Phase 1 adds the server-side foundation without connecting or changing the existing
Call Now screens. `index.html`, `css/style.css`, and `js/app.js` remain the current
`ac0cea2` implementation.

Implemented areas:

- HTTPS JSON API suitable for Cloud Run
- PostgreSQL schema and tracked migrations
- Required email address and one-time magic-link login
- Individual, revocable, device-associated sessions
- Future Passkey credential and challenge storage
- No Call Now password credential type, hash storage, or password login route
- Team, OWNER/MEMBER membership, subscription, and additional-member seat limits
- Hashed capacity invitations and one-use LINE invitation links
- Transactional join and member-removal operations
- Server-side OWNER authorization and audit events
- Local, CI, staging, and production configuration boundaries
- Secret Manager and Workload Identity Federation deployment path

Deferred until later phases:

- Changes to the existing browser screens
- Production payment provider and billing webhook
- Gmail refresh-token migration and continuous monitoring
- Notification delivery transport
- Passkey registration and authentication ceremonies
- OWNER transfer completion, which also requires the new OWNER Gmail connection
- Existing localStorage user migration and production cutover

## Local development

1. Copy `.env.example` to an ignored `.env` file and replace local values as needed.
2. Start PostgreSQL and Mailpit with `docker compose up -d`.
3. Install dependencies with `pnpm install`.
4. Generate the client with `pnpm --filter @call-now/api db:generate`.
5. Apply migrations with `pnpm --filter @call-now/api db:migrate:deploy`.
6. Start the API with `pnpm dev:api`.

Run `pnpm test:postgres` only against a dedicated database whose name contains
`test` or `acceptance`. This suite truncates data in that database and verifies
real PostgreSQL transaction behavior, including concurrent redemption of the last
available seats.

Mailpit is available on port 8025. Magic-link values are delivered to Mailpit rather
than printed to logs.

## Security boundaries

- Six-digit team IDs are public locators, not authenticators.
- Magic links, sessions, LINE links, and join grants use high-entropy random tokens.
- Only token hashes are stored in PostgreSQL.
- Invitation passwords use Argon2id.
- Mutation endpoints require the configured same Origin.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in staging/production.
- Sensitive request fields and authentication headers are redacted from logs.
- Five failed invitation-password attempts lock the team/source pair for 15 minutes.
- Team capacity is checked again inside a serializable transaction.
- MEMBER removal revokes sessions and disables notification targets immediately.

## Migration rules

Production uses `prisma migrate deploy`; it never uses `migrate dev`. A migration job
must finish successfully before a new API revision is deployed. Production backups
and point-in-time recovery must be enabled and a restore test completed before user
migration begins.
