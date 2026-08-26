# Mail monitoring connection

Call Now login and mail monitoring are separate security boundaries. `ExternalIdentity`
proves who is signed in to Call Now. `MailAuthorization` stores one User's delegated
permission for exactly one monitoring account, and each owned Team's `MailConnection`
references that authorization. A User can select Google or Microsoft, but cannot keep
both providers active at once. MEMBERs cannot read or change monitoring account data.

## Provider adapters

`MailProviderAdapter` contains provider-specific authorization URL creation, code
exchange, access-token refresh, revocation behavior, and error classification.
`GoogleMailProvider` and `MicrosoftMailProvider` implement that boundary. API routes,
database transactions, encrypted credential storage, OWNER authorization, and UI
status handling remain provider-neutral.

### Google / Gmail

- Use a separate Google Web application OAuth client from Call Now login.
- Local callback: `http://127.0.0.1:8080/api/v1/auth/gmail/callback`.
- Requested scopes are `openid`, `email`, and
  `https://www.googleapis.com/auth/gmail.readonly`.
- Authorization uses state, PKCE S256, OIDC nonce, `access_type=offline`, and an
  explicit consent prompt. The signed ID token and verified email claim are checked.

### Microsoft 365 / Outlook

- Register a Microsoft Entra Web application supporting organizational accounts and
  personal Microsoft accounts.
- Use the `common` authority unless deployment policy intentionally limits account
  types to `organizations`, `consumers`, or one tenant ID.
- Local callback:
  `http://127.0.0.1:8080/api/v1/auth/mail/microsoft/callback`.
- Requested delegated scopes are `openid`, `profile`, `email`, `offline_access`, and
  `https://graph.microsoft.com/Mail.Read`. `Mail.ReadWrite` and application permissions
  are not requested.
- Authorization uses code flow, state, PKCE S256, and nonce. The v2 ID token signature,
  audience, dynamic tenant issuer, expiry, nonce, tenant, subject, and display email
  are checked before persistence. A stable monitoring subject combines tenant ID and
  the provider subject.

Both state challenges are short-lived, HMACed in PostgreSQL, bound to the signed-in
User and Team, and consumable only once. Callback responses contain no provider token.

## Token handling

The callback verifies identity and required scopes, then encrypts the refresh token
before a serializable transaction stores it. The browser receives only provider,
connection state, and email. Access tokens and refresh tokens are never returned or
logged.

Local/test uses a 32-byte base64 AES-256-GCM key and a version label. The Gmail-era
authenticated-data label is intentionally retained so existing encrypted credentials
remain readable during table generalization. Staging and production require Google
Cloud KMS. OAuth client secrets and local encryption keys belong only in ignored
`.env` files locally and Secret Manager when deployed. The runtime service account
gets encrypt/decrypt access only to the configured key.

## Lifecycle and switching

- Connect creates or updates the User's single authorization and Team connection.
- Reauthorization rotates the encrypted grant and clears prior error state.
- Provider/account switching keeps the old local grant active until the new callback
  succeeds. The transaction then replaces the authorization, resets every dependent
  provider cursor, and records audit events. Old provider revocation is best effort.
- `invalid_grant`, consent, authorization, throttling, and transient provider errors
  map to common classifications. Credential failures can move the authorization and
  all dependent connections to `REAUTH_REQUIRED` or `ERROR`.
- Disconnect first disables the Team connection. When no active Team references the
  authorization, the transaction clears the encrypted credential and records
  `MAIL_AUTHORIZATION_REVOKED`; provider revocation follows afterward. Microsoft has
  no narrowly scoped refresh-token revocation endpoint for this delegated web grant,
  so local deletion is authoritative and the user may also remove consent in their
  Microsoft account or organization.

Audit metadata may include provider, reason code, and scope count. It must never
include an OAuth code, state, access token, refresh token, Session token, Cookie, or
client secret.

## Continuous monitoring design (not yet active)

The current implementation establishes secure authorization and connection state. It
does not yet start continuous mailbox monitoring or send Call Now notifications.

Google production monitoring will use Gmail `watch`, Google Cloud Pub/Sub, and
`history.list`; `providerCursor` stores the Gmail history ID. Microsoft production
monitoring will use Microsoft Graph change-notification subscriptions, a public HTTPS
webhook, scheduled renewal, lifecycle notifications (`reauthorizationRequired`,
`subscriptionRemoved`, and missed notifications), and delta reconciliation;
`providerCursor` stores the provider delta cursor. Public webhook E2E remains
unverified until a staging HTTPS endpoint exists—no local tunnel or weakened callback
policy is introduced here.

Provider events will be normalized before keyword matching:

```text
NormalizedMailEvent
  provider
  accountId
  providerMessageId
  receivedAt
  subject
  sender
  minimalSnippetOrBody
  providerCursor
```

Gmail and Microsoft must share the existing keyword policy and notification pipeline.
Mailbox bodies must not be persisted unless later implementation proves a minimum,
time-bounded need; tokens are decrypted only at point of use and access tokens remain
in memory.

## Deployment settings

Google Cloud requires the Gmail API, an exact HTTPS callback, consent-screen scopes,
and test users or approved publication. Microsoft Entra requires an App registration,
supported account type including organizational and personal accounts, an exact HTTPS
Web redirect URI, delegated `Mail.Read`, `offline_access`, OpenID permissions, client
secret storage in Secret Manager, and consent according to tenant policy. Real secrets
must never be committed.
