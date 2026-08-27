# Gmail monitoring connection

Call Now login and Gmail monitoring are deliberately separate. `ExternalIdentity`
proves who is using Call Now. `GmailAuthorization` stores one user's permission to
read one monitoring account, and a Team's `GmailConnection` points to that permission.
An OWNER can reuse their authorization for Teams they own; MEMBERs cannot read or
change the monitoring account.

## OAuth boundary

- Use a separate Google Web application OAuth client from Call Now login.
- Local callback: `http://127.0.0.1:8080/api/v1/auth/gmail/callback`.
- Staging and production callbacks must use HTTPS and exactly match Google Cloud.
- Enable the Gmail API and configure the consent screen/test users.
- Requested scopes are `openid`, `email`, and
  `https://www.googleapis.com/auth/gmail.readonly`.
- The provider-status endpoint reports only `AVAILABLE` or
  `NOT_CONFIGURED`; it never returns OAuth credentials or encryption keys.
  OAuth navigation returns to Call Now with a safe error result if setup is
  incomplete or the start operation fails.
- Authorization uses state, PKCE S256, OIDC nonce, `access_type=offline`, and an
  explicit consent prompt. The state challenge is short-lived and one-use.

## Token handling

The callback verifies the ID token and required scope, then encrypts the refresh
token before a database transaction stores it. The browser receives only connection
status and email; access tokens and refresh tokens are never returned or logged.

Local/test uses a 32-byte base64 AES-256-GCM key and a version label. Staging and
production require Google Cloud KMS. Keep OAuth secrets and local encryption keys in
ignored `.env` files for local work and in Secret Manager for deployed environments.
The runtime service account receives only encrypt/decrypt access to the configured
KMS key.

## Lifecycle

- Connect creates or updates the user's single authorization and Team connection.
- Reauthorization rotates the encrypted grant and clears prior error state.
- An `invalid_grant` or equivalent worker error marks the authorization and all
  dependent connections `REAUTH_REQUIRED`.
- Disconnect first marks the Team connection revoked in PostgreSQL. If no active
  Team still references the authorization, it clears the encrypted credential and
  then attempts Google revocation. Every change writes an `AuditEvent`.

Continuous Gmail polling, History API cursor processing, and notification delivery
remain separate follow-up work. Those jobs must decrypt only at point of use, keep
access tokens in memory, and call the reauthorization transition on credential
failure.
