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

## Secret Manager entries

- `call-now-database-url`
- `call-now-auth-token-pepper`
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
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `EMAIL_FROM`
- `DATABASE_URL_SECRET_VERSION`
- `AUTH_PEPPER_SECRET_VERSION`
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
