# OAuth deploy wiring — implementation and manual configuration

## Scope / design decision

This is a **code-only** correction to `.github/workflows/deploy.yml`, based on
`ac79ea6500b90d9a7201d3499b95921ff59e0c2e` (main containing the console handoff).
The console-side registrations, Secret Manager versions and IAM described in
[the handoff](./staging-oauth-deploy-handoff.md) are user-provided facts; this task
does not access or modify those resources or GitHub Environment settings.

Use **explicit, full Secret Manager names in each GitHub Environment**, paired
with explicit numeric versions. Do not prepend a fixed `SECRET_NAME_PREFIX`:
the suffixes also differ (`database-url` vs `runtime-db-url`, `google-oauth`
vs `google-login`). A prefix alone would still select nonexistent resources.
Explicit names allow staging to use its existing resources and production to
retain the old names without renaming secrets or copying credential values.
There is no fallback to a production name or `latest` version.

Migration and API DB references are separately configurable. Set both explicitly;
do not silently give the API migration credentials. An environment intentionally
using one existing DB secret can select the same full name/version in both pairs.
This change does not alter SQL roles, service accounts, IAM or database contents.

Client IDs are **non-secret GitHub Environment variables**, as requested, even
though copies also exist in Secret Manager. The workflow does not read their
secret containers. Client secrets remain Cloud Run Secret Manager references;
they are not fetched into Actions variables or placed in `--set-env-vars`.

## Before / after for review

| Setting | Before | After |
| --- | --- | --- |
| Microsoft **login** client ID / redirect / tenant | Not passed | Dedicated `vars.MICROSOFT_LOGIN_OAUTH_*` values in `--set-env-vars` |
| Microsoft **login** client secret | Not passed | Dedicated name + version in `--set-secrets` |
| Google / Gmail / Microsoft **mail** secret, pepper, SMTP | Hardcoded `call-now-...` names | Environment-specific full names + existing version variable names |
| API database secret | Hardcoded shared DB name | `DATABASE_URL_SECRET_NAME` + `DATABASE_URL_SECRET_VERSION` |
| Migration database secret | Same hardcoded DB reference | Explicit `MIGRATION_DATABASE_URL_SECRET_NAME` + `MIGRATION_DATABASE_URL_SECRET_VERSION` |
| Metadata validation | None before cloud operations | Offline preflight before cloud authentication/build/deploy |

Preflight requires all nine name/version pairs below, both login client IDs,
exact HTTPS callback paths and a valid Microsoft login tenant. The documented
staging registration is single-tenant, so staging requires an explicit tenant
UUID; `common`/`organizations`/`consumers` are rejected there. Production also
accepts the aliases already supported by `env.ts`, when appropriate for its own
registration. No application parser or authentication behavior is changed.
Diagnostics name invalid fields only, never supplied values or JSON parse errors.

## Manual work: GitHub Environment variables (not set by this PR)

Configure repository Settings → Environments → **staging** or **production** →
Environment variables. Each environment is selected by the workflow input and
job `environment`. Do not put actual passwords/client secrets into these vars.
Values below are names/public IDs from the handoff, not secret payloads.

| Name variable | Version variable (positive integer, not `latest`) | staging name/value source |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL_SECRET_NAME` | `MIGRATION_DATABASE_URL_SECRET_VERSION` | Confirm existing **migration-role** DB secret name/version; not supplied by OAuth handoff |
| `DATABASE_URL_SECRET_NAME` | `DATABASE_URL_SECRET_VERSION` | `call-now-staging-runtime-db-url`; confirm active version |
| `AUTH_TOKEN_PEPPER_SECRET_NAME` | `AUTH_PEPPER_SECRET_VERSION` | Confirm existing staging auth-pepper secret name/version |
| `GOOGLE_OAUTH_CLIENT_SECRET_NAME` | `GOOGLE_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-google-login-client-secret`, version **1** per handoff |
| `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_NAME` | `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-microsoft-login-client-secret`, version **1** per handoff |
| `GMAIL_OAUTH_CLIENT_SECRET_NAME` | `GMAIL_OAUTH_CLIENT_SECRET_VERSION` | Confirm separate Gmail **monitoring** secret; do not use Google login secret |
| `MICROSOFT_OAUTH_CLIENT_SECRET_NAME` | `MICROSOFT_OAUTH_CLIENT_SECRET_VERSION` | Confirm separate Microsoft **mail monitoring** secret; do not use Microsoft login secret |
| `SMTP_USER_SECRET_NAME` | `SMTP_USER_SECRET_VERSION` | Confirm staging SMTP user secret name/version |
| `SMTP_PASSWORD_SECRET_NAME` | `SMTP_PASSWORD_SECRET_VERSION` | Confirm staging SMTP password secret name/version |

In production, select the existing full names explicitly, e.g.
`call-now-database-url`, `call-now-auth-token-pepper`,
`call-now-google-oauth-client-secret`, `call-now-gmail-oauth-client-secret`,
`call-now-microsoft-oauth-client-secret`, `call-now-smtp-user`,
`call-now-smtp-password`, and that environment's dedicated **login** secret.
These are examples of previous workflow names, **not confirmation that the
production resources exist**. No production variables or secrets were changed.

Public staging login variables:

| Variable | Required staging value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | `404996456750-ika6lnuhul1t53dhlgt5og26pq1ijj27.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/google/callback` |
| `MICROSOFT_LOGIN_OAUTH_CLIENT_ID` | `3f5a7e56-c7cb-46a0-9477-ca90b696d3d8` |
| `MICROSOFT_LOGIN_OAUTH_REDIRECT_URI` | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/microsoft/callback` |
| `MICROSOFT_LOGIN_OAUTH_TENANT` | `6af9d90a-8ed4-420b-ad82-a80296dee18d` (**not** `common`) |

Keep the other existing workflow vars (project/region/image repository, Workload
Identity, service account, SQL instance, PUBLIC_ORIGIN, Cookie, KMS, monitoring
OAuth and SMTP settings) aligned with the selected environment. The preflight
validates only this PR's metadata contract; it does **not** prove live resource
existence, active versions, IAM or that all deployment prerequisites are met.

## Important remaining checks before a separately approved deploy

1. This workflow still deploys `call-now-api` / `call-now-db-migrate`; the
   registered staging callback host is the existing **call-now-staging-api**.
   Reconcile the service/job target names before running it. Do not accidentally
   deploy a second service whose URL differs from the registered callback.
   Target-name changes are intentionally outside this secret/OAuth-wiring PR.
2. The current main does not include PR #43's native PKCE endpoints. This PR
   does not integrate #43, change `apps/ios/`, or wire `NATIVE_AUTH_MODE`.
   Select/integrate the reviewed staging application revision separately before
   claiming native login E2E readiness; this workflow still builds the selected
   Git ref, not a pre-existing staging image.
3. The existing workflow references Gmail/Microsoft **mail monitoring** and SMTP
   secrets as well as login. The handoff confirms only the four **login**
   containers; it does not establish that all other references are available.
   Verify required resources/settings instead of inventing names or reusing
   login credentials for mail monitoring. Their optional/staging-disabled
   deployment policy is not changed here.
4. The existing migration/API steps still use `GCP_RUNTIME_SERVICE_ACCOUNT`.
   Verify access to each selected DB secret and correct DB privileges. This PR
   does not change service accounts or grant new privileges.
5. Only after manual metadata setup and separate deployment approval: confirm
   revision health, providers AVAILABLE, exact callbacks, user consent, PKCE code
   exchange and native session. Console setup is **not** proof of OAuth E2E.

## Local checks and stop point

- `pnpm test:deploy-config`: renders all secret mappings for staging and
  production using synthetic metadata, verifies Microsoft login vs monitoring
  separation, preflight order, missing/invalid names and versions, callback and
  tenant validation, and safe CLI failure output. No gcloud or network calls.
- `apps/api/tests/env.test.ts`: complete single-tenant login tuple, missing
  fields, invalid tenants and HTTPS enforcement with synthetic secret values.
- `pnpm verify`: includes the new offline deployment regression suite.
- YAML syntax and `git diff --check`; `apps/ios/` diff must remain empty.

Local results (2026-09-27):

| Check | Measured result |
| --- | --- |
| `pnpm test:deploy-config` | **10 PASS** |
| `env.test.ts` | **17 PASS** (8 new cases; also included in API total below) |
| `pnpm verify` | **PASS**: deploy 10, frontend 128, API 293; format/lint/typecheck/build passed |
| PostgreSQL integration | **118 skipped / not run**, no DB connection or migration requested for this code-only task |
| YAML syntax / `git diff --check` | PASS |
| `apps/ios/` changes | None |
| Cloud deployment / real OAuth / GitHub Actions | **Not run** |

No Actions workflow is dispatched. The commit uses `[skip ci]` so creating the PR
also does not start the repository's push/pull_request CI. This does **not**
disable CI settings; CI is deliberately **unexecuted**, not reported as passed.
See [GitHub's skip-workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

**Stop after commit/push and PR creation. No deploy, database changes, cloud
configuration, GitHub Environment edits, iOS edits, real Push or main merge.**
