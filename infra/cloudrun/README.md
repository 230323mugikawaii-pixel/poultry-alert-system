# Call Now Phase 1 deployment

Phase 1 API is deployed as a Cloud Run service. PostgreSQL is provided by Cloud SQL,
and sensitive values are read from Secret Manager. Staging and production must use
different Google Cloud projects, databases, OAuth settings, service accounts, and
secrets.

## Required Google Cloud resources

- Artifact Registry Docker repository
- Cloud Run service `call-now-api`
- Cloud Run job `call-now-db-migrate`
- Cloud SQL for PostgreSQL instance and database
- Secret Manager secrets listed below
- A runtime service account with Cloud SQL Client and Secret Manager Secret Accessor
- A deployment service account trusted by GitHub Workload Identity Federation

Production Cloud SQL must enable automated backups and point-in-time recovery.
High availability should be enabled before accepting production contracts.

The Dockerfile has separate `runtime` and `migration` targets. The runtime target
runs as the unprivileged `node` user with production dependencies only. The migration
target contains Prisma CLI and is deployed only to the Cloud Run migration job.

## Secret Manager entries

- `call-now-database-url`
- `call-now-auth-token-pepper`
- `call-now-google-oauth-client-secret`
- `call-now-gmail-oauth-client-secret`
- `call-now-smtp-user`
- `call-now-smtp-password`

The database URL for a Cloud SQL Unix socket has this shape:

```text
postgresql://USER:PASSWORD@localhost/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE
```

Secret versions are pinned through GitHub environment variables. Do not use a
floating `latest` version in production deployment configuration.

## GitHub environments

Create `staging` and `production` environments. Production should require manual
approval. Configure these environment variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_RUNTIME_SERVICE_ACCOUNT`
- `ARTIFACT_REPOSITORY`
- `CLOUD_SQL_CONNECTION_NAME`
- `PUBLIC_ORIGIN`
- `COOKIE_NAME`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_REDIRECT_URI`
- `MICROSOFT_OAUTH_CLIENT_ID`
- `MICROSOFT_OAUTH_REDIRECT_URI`
- `MICROSOFT_OAUTH_TENANT` (`common` for the public service)
- `MAIL_TOKEN_ENCRYPTION_KEY_VERSION`
- `MAIL_KMS_KEY_NAME`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `EMAIL_FROM`
- `DATABASE_URL_SECRET_VERSION`
- `AUTH_PEPPER_SECRET_VERSION`
- `GOOGLE_OAUTH_CLIENT_SECRET_VERSION`
- `GMAIL_OAUTH_CLIENT_SECRET_VERSION`
- `MICROSOFT_OAUTH_CLIENT_SECRET_VERSION`
- `SMTP_USER_SECRET_VERSION`
- `SMTP_PASSWORD_SECRET_VERSION`

The deployment workflow is manual. It verifies the code, applies migrations through
a Cloud Run job, and only then deploys the API service. No deployment is triggered by
creating or pushing a development branch.

The direct Cloud Run deployment uses one trusted proxy hop. `TRUST_PROXY_HOPS=1`
means Fastify trusts only the nearest Google frontend rather than every value in an
incoming `X-Forwarded-For` chain. If an external Application Load Balancer is added,
validate the observed hop chain before changing this value; never use an unconditional
`trustProxy: true` setting.

The Google OAuth client must be a Web application client. Register the exact
`GOOGLE_OAUTH_REDIRECT_URI` for each environment. Login requests use only
`openid`, `email`, and `profile`. Use a separate Web application OAuth client for
Gmail monitoring and register the exact `GMAIL_OAUTH_REDIRECT_URI`. Enable the Gmail
API and request only `openid`, `email`, and `gmail.readonly`; offline consent is
required so the monitoring job can refresh access without a browser.

Register a separate Microsoft Entra Web application for mail monitoring, support both
organizational and personal Microsoft accounts, and register the exact
`MICROSOFT_OAUTH_REDIRECT_URI`. Request delegated `openid`, `profile`, `email`,
`offline_access`, and `Mail.Read`; do not grant `Mail.ReadWrite` or application mail
permissions. Store its client secret only in Secret Manager.

The runtime service account also needs Cloud KMS encrypt/decrypt permission on the
specific key named by `MAIL_KMS_KEY_NAME`. Do not grant project-wide key access when
a key-level binding is sufficient.
