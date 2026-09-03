# Gmail push monitoring

Call Now monitors Gmail and Google Workspace through Gmail `users.watch`, an authenticated Google Cloud Pub/Sub push subscription, Gmail History API, and `users.messages.get`. Pub/Sub carries only the mailbox address and a history cursor; it does not carry message contents.

## Runtime flow

1. An eligible connection has `MailConnection.status = ACTIVE`, an active Google `MailAuthorization`, an active Team, and an active Subscription.
2. Watch reconciliation calls `users.watch` with the `INBOX` label and saves the watch expiration. The first watch response initializes `providerCursor`; renewals never overwrite an existing cursor.
3. Pub/Sub sends an authenticated push to `POST /api/v1/webhooks/mail/google/pubsub`.
4. The API verifies the Google-signed OIDC token, its issuer, exact audience, expiration, and the configured push service account.
5. The API validates the Pub/Sub envelope and decodes `emailAddress` and `historyId`.
6. Gmail History API is read from `providerCursor`, including every page. Duplicate message IDs are collapsed.
7. New INBOX messages are fetched as MIME, with attachments ignored and extracted text capped at 1 MiB. Subject and text/plain or visible text/html are compared with the connection's canonical `keywords` using the existing NFKC/case normalization.
8. A match is passed to the existing `AlertService` as a REAL Alert. The unique connection/message ID constraint prevents duplicate Alerts, while existing Alert fan-out creates recipients for the OWNER and active notification members.
9. The cursor advances only after the entire batch succeeds. Concurrent deliveries are serialized by a short database lease; external API calls do not hold a database transaction open.

Message subjects and bodies are transient. They are not saved to the database, AuditEvent, or logs.

## Required environment

Set real values only in the deployment secret manager or an ignored local `.env`; never commit them.

- `GMAIL_PUSH_MONITORING_ENABLED=true`
- `GMAIL_PUBSUB_TOPIC_NAME=projects/<project>/topics/<topic>`
- `GMAIL_PUBSUB_PUSH_AUDIENCE=https://<api-host>/api/v1/webhooks/mail/google/pubsub`
- `GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL=<push-service-account>@<project>.iam.gserviceaccount.com`
- `GMAIL_WATCH_RENEW_BEFORE_HOURS=48`
- `GMAIL_HISTORY_RECOVERY_LOOKBACK_HOURS=72`
- `GMAIL_PUBSUB_MAX_BODY_BYTES=262144`

The existing Gmail OAuth and mail-token encryption settings are also required. Staging and production fail closed when push monitoring is enabled with incomplete Pub/Sub settings. Gmail OAuth remains restricted to `gmail.readonly`; do not add modify, send, or full-mailbox scopes.

## Google Cloud preparation

These are deployment steps and are not performed by the repository or local tests.

1. Enable the Gmail API and Pub/Sub API in the intended Google Cloud project.
2. Create a Pub/Sub topic named by `GMAIL_PUBSUB_TOPIC_NAME`. Its project ID must exactly match the Google developer project that owns the Gmail OAuth client used for `users.watch`.
3. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic.
4. Create a dedicated user-managed service account in the subscription project for authenticated push delivery. The principal creating or changing the subscription needs permission to attach that account (`iam.serviceAccounts.actAs`).
5. Grant the Pub/Sub service agent `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` the Service Account Token Creator role on the dedicated push-auth service account so Pub/Sub can mint its OIDC token.
6. Create a wrapped push subscription targeting the public HTTPS webhook URL. Enable OIDC authentication with the dedicated service account and set the exact audience configured in `GMAIL_PUBSUB_PUSH_AUDIENCE`. Do not enable payload unwrapping because the endpoint validates the standard Pub/Sub envelope.
7. Restrict ingress and IAM for the deployed API according to the hosting platform. The endpoint itself still validates the Google OIDC token and service-account identity.
8. Run watch reconciliation after deployment and on a schedule. Gmail watches expire, so execute it at least daily; the default renewal window is 48 hours.

Localhost cannot receive real Pub/Sub push traffic directly. The repository does not expose an unauthenticated development webhook. Local verification uses unit tests, fake envelopes, and PostgreSQL integration tests.

## Operations

Run one reconciliation pass from a trusted worker or Cloud Run Job environment:

```sh
pnpm mail:gmail:renew-watches
```

The command prints counts only and never prints mailbox addresses, credentials, tokens, cursors, message content, or database URLs. A nonzero exit is returned when transient watch failures remain.

The API also performs a best-effort reconciliation on startup and every minute while enabled. The frequent check does not renew healthy watches: the database query selects only missing or near-expiry watches. Multiple instances are safe: watch renewal preserves existing cursors, and mailbox processing uses database leases plus Alert uniqueness.

## Failure handling

- `invalid_grant`, HTTP 401, and permission loss move the authorization and its connections to `REAUTH_REQUIRED`.
- HTTP 429, 5xx, and network timeouts use bounded retry with exponential backoff and jitter. An exhausted webhook attempt returns 503 so Pub/Sub can redeliver.
- An old History API cursor returning 404 triggers a bounded 72-hour recent-INBOX recovery (maximum 500 unique messages), including a five-minute overlap before the last successful sync and deduplicated by Gmail message ID. The cursor is changed only after recovery succeeds.
- Disconnect clears local cursor/watch state first. If no other connection uses the authorization, `users.stop` and token revocation are best-effort; their failure never re-enables local monitoring.

## Staging end-to-end check

After Google Cloud configuration and HTTPS deployment:

1. Connect a Gmail test mailbox and confirm the connection, Team, and Subscription are active.
2. Run watch reconciliation and confirm watch expiration is stored.
3. Send a new email from another account containing a configured keyword in its subject or body.
4. Confirm exactly one REAL Alert is created with the Gmail message ID as `sourceEventId`.
5. Confirm the OWNER and each active participant receive one AlertRecipient, while disabled/deleted participants and other Teams receive none.
6. Confirm the bell, badge, SSE/fallback polling, and device-local sound behavior work without using NotificationTest.
7. Redeliver the same Pub/Sub message and confirm no duplicate Alert or recipient is created.

Do not include real credentials, authorization codes, tokens, cookies, mailbox contents, or encryption keys in screenshots or incident reports.

## Official references

- [Configure push notifications in Gmail API](https://developers.google.com/workspace/gmail/api/guides/push)
- [Gmail users.watch reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
- [Authenticate Pub/Sub push subscriptions](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
