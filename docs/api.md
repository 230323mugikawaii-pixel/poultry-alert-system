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

## Mail monitoring connection

- `GET /api/v1/teams/:teamId/mail-connections` (OWNER only)
- `GET /api/v1/teams/:teamId/mail-connection` (OWNER-only legacy single-result view)
- `GET /api/v1/teams/:teamId/mail-connection/providers` (OWNER only)
- `POST /api/v1/teams/:teamId/mail-connection/oauth/start?provider=GOOGLE|MICROSOFT` (OWNER only)
- `POST /api/v1/teams/:teamId/mail-connections/:connectionId/reauthorize?provider=GOOGLE|MICROSOFT` (OWNER only)
- `GET /api/v1/auth/gmail/callback`
- `GET /api/v1/auth/mail/microsoft/callback`
- `DELETE /api/v1/teams/:teamId/mail-connections/:connectionId` (OWNER only)

Mail authorization is independent from the Google identity used to log in. Google
requests offline `gmail.readonly`; Microsoft requests delegated offline `Mail.Read`.
Refresh tokens never enter JSON responses or browser storage and are encrypted before
PostgreSQL persistence. Disconnect disables the local credential transactionally
before provider-specific best-effort revocation. Gmail-only endpoint aliases remain
temporarily available for clients from the preceding foundation release.

## User notifications and feedback

- `GET /api/v1/notifications`
- `POST /api/v1/notifications/:notificationId/read`
- `POST /api/v1/feedback`

Notifications are private to the authenticated User and return an unread count with
at most the 50 newest items. A User cannot read or update another User's notification.
The read and feedback writes require the configured same origin. Feedback submission
is protected by the shared PostgreSQL throttle as well as the API request limiter.

The initial notification types are operator announcements, system notices, and
feedback replies. Feedback content is stored in `FeedbackSubmission`; it is not copied
to `AuditEvent.metadata`. There is intentionally no public operator-reply route in this
phase. Future authenticated operator tooling calls `recordOperatorReply`, which stores
the reply notification and feedback state atomically and idempotently. The browser
never creates a dummy reply.

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
# Primary login providers

- `GET /api/v1/auth/providers`
- `GET /api/v1/auth/:provider/start`
- `GET /api/v1/auth/google/callback`
- `GET /api/v1/auth/microsoft/callback`
- `POST /api/v1/auth/apple/callback`
- `GET /api/v1/auth/identities`
- `POST /api/v1/auth/identities/:provider/link/start`
- `DELETE /api/v1/auth/identities/:provider`

`:provider` は `google`、`microsoft`、`apple` のいずれかです。ログイン成功時は既存のHttpOnly Session Cookieを発行します。追加連携と解除は認証済みSessionおよび同一Originを必須とし、最後のログイン方法は解除できません。同じメールアドレスであることだけを根拠にUserを統合しません。
