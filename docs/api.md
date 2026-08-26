# Call Now Phase 1 API

All endpoints return JSON except successful 204 responses. Errors use this envelope:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "User-facing Japanese message",
    "requestId": "request identifier"
  }
}
```

## System

- `GET /healthz`
- `GET /readyz`

## Authentication and sessions

- `POST /api/v1/auth/magic-links/request`
- `POST /api/v1/auth/magic-links/consume`
- `GET /api/v1/auth/me`
- `GET /api/v1/auth/sessions`
- `DELETE /api/v1/auth/sessions/:sessionId`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`

Requesting a magic link always returns the same accepted response for a syntactically
valid email. The raw token is delivered only through email.

## Team and subscription

- `POST /api/v1/teams/bootstrap`
- `POST /api/v1/teams`
- `GET /api/v1/teams/current`
- `GET /api/v1/teams/current/members` (OWNER only)
- `GET /api/v1/teams/current/subscription`
- `POST /api/v1/teams/current/subscription/seat-limit-changes` (OWNER only)

An increase returns `AWAITING_PAYMENT`; a trusted billing adapter applies it later.
A safe decrease returns `APPLIED`. An over-capacity decrease returns
`PENDING_CAPACITY` and suspends invitations.

`teams/bootstrap` is an authenticated, same-origin, idempotent initializer for a
first paid setup. It creates one zero-additional-seat Team only when the User has
never had a membership. Existing OWNER or MEMBER membership is returned unchanged;
inactive former memberships are not promoted to OWNER. Concurrent calls serialize
on the User row so reload, re-login, and OAuth callback cannot create duplicate
Teams.

## Gmail monitoring connection

- `GET /api/v1/teams/:teamId/gmail-connection` (OWNER only)
- `GET /api/v1/teams/:teamId/gmail-connection/provider-status` (OWNER only)
- `POST /api/v1/teams/:teamId/gmail-connection/oauth/start` (OWNER only)
- `POST /api/v1/teams/:teamId/gmail-connection/reauthorize` (OWNER only)
- `GET /api/v1/auth/gmail/callback`
- `DELETE /api/v1/teams/:teamId/gmail-connection` (OWNER only)

Gmail authorization is independent from the Google identity used to log in. It
requests offline `gmail.readonly` consent. Refresh tokens never enter JSON responses
or browser storage; they are encrypted before PostgreSQL persistence. Disconnect
disables the local credential transactionally before best-effort Google revocation.

## Invitations and membership

- `GET /api/v1/teams/current/invitations`
- `POST /api/v1/teams/current/invitations/reissue`
- `DELETE /api/v1/teams/current/invitations/:invitationId`
- `POST /api/v1/teams/current/invitations/:invitationId/links`
- `DELETE /api/v1/teams/current/invitation-links/:linkId`
- `POST /api/v1/join/password/verify`
- `POST /api/v1/join/link/verify`
- `POST /api/v1/join/complete`
- `DELETE /api/v1/teams/current/members/:membershipId`
- `POST /api/v1/teams/current/leave`
- `GET /api/v1/teams/current/audit-events`

Password or link verification creates a short-lived join grant. It does not consume
a seat. `join/complete`, after individual email login, creates the MEMBER and consumes
the invitation in one transaction. Expired invitations and links are persisted as
`EXPIRED` when observed. Serializable transaction conflicts are retried and return a
stable 409 response if contention remains.

## Important error codes

- `UNAUTHENTICATED`
- `OWNER_REQUIRED`
- `MAGIC_LINK_INVALID_OR_EXPIRED`
- `INVITATION_INVALID_OR_EXPIRED`
- `INVITATION_EXHAUSTED`
- `INVITATION_TEMPORARILY_LOCKED`
- `JOIN_TRANSACTION_CONFLICT`
- `INVITATIONS_SUSPENDED`
- `ALREADY_TEAM_MEMBER`
- `OWNER_TRANSFER_REQUIRED`
- `SEAT_LIMIT_UNCHANGED`
- `SEAT_INCREASE_NOT_PAYABLE`
- `IDEMPOTENCY_KEY_CONFLICT`
