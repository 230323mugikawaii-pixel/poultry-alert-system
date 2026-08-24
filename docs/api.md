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

- `POST /api/v1/teams`
- `GET /api/v1/teams/current`
- `GET /api/v1/teams/current/members`
- `GET /api/v1/teams/current/subscription`
- `POST /api/v1/teams/current/subscription/seat-limit-changes`

An increase returns `AWAITING_PAYMENT`; a trusted billing adapter applies it later.
A safe decrease returns `APPLIED`. An over-capacity decrease returns
`PENDING_CAPACITY` and suspends invitations.

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
the invitation in one transaction.

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
