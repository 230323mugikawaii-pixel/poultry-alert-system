# OAuth deploy wiring — implementation and manual configuration

## Scope / design decision

This is a **code-only** correction to `.github/workflows/deploy.yml`. The secret
wiring was introduced by PR #46. The resource-name follow-up is based on
`b12ec8e55000cfc54a5dec2608775c4f9abb15bf` (main with #46 merged).
The SMTP-only follow-up is based on
`99f3f952ca95c787c961b83a4021cdd01acf26fd`; fetching and inspecting
`git log origin/main` confirmed both #46 and #47 are merged.
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

Cloud Run resource targets follow the same explicit-input policy:
`API_SERVICE_NAME` and `MIGRATION_JOB_NAME` are required in each environment.
No prefix, environment-derived name, or default is substituted. Job deploy and
execute use the same `MIGRATION_JOB_NAME`. The Artifact Registry image names
`call-now-api:${{ github.sha }}` / `call-now-db-migrate:${{ github.sha }}` are
unchanged; image repository names do not determine deployed resource names.

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
| Cloud Run API service | Hardcoded `call-now-api` | Required `vars.API_SERVICE_NAME` |
| Cloud Run migration job (deploy and execute) | Hardcoded `call-now-db-migrate` | Required `vars.MIGRATION_JOB_NAME` in both calls |
| Metadata validation | None before cloud operations | Offline preflight before cloud authentication/build/deploy |
| SMTP settings (this follow-up) | Unconditional secret references and plain env entries | Optional in staging; required in production. Unset staging entries are omitted, never sent as empty strings |

Preflight requires both resource names, all seven non-SMTP secret name/version
pairs below (all nine in production),
both login client IDs, exact HTTPS callback paths and a valid Microsoft login tenant. The documented
staging registration is single-tenant, so staging requires an explicit tenant
UUID; `common`/`organizations`/`consumers` are rejected there. Production also
accepts the aliases already supported by `env.ts`, when appropriate for its own
registration. No application parser or authentication behavior is changed.
Diagnostics name invalid fields only, never supplied values or JSON parse errors.
Resource names must match the lowercase RFC-1035 label pattern
`^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$` (1–63 characters). This is syntax validation
only, not a lookup or confirmation of a real Cloud Run service/job.

## Manual work: GitHub Environment variables (not set by this PR)

Configure repository Settings → Environments → **staging** or **production** →
Environment variables. Each environment is selected by the workflow input and
job `environment`. Do not put actual passwords/client secrets into these vars.
Values below are names/public IDs from the handoff, not secret payloads.

| Name variable | Version variable (positive integer, not `latest`) | staging name/value source |
| --- | --- | --- |
| `API_SERVICE_NAME` | — (resource target, not a secret) | **`call-now-staging-api`**, confirmed by the registered redirect-URI host `call-now-staging-api-404996456750.asia-northeast1.run.app` in [the handoff](./staging-oauth-deploy-handoff.md) |
| `MIGRATION_JOB_NAME` | — (resource target, not a secret) | **NOT CONFIRMED. The user must look up the actual existing staging job name before this workflow is usable. No name is assumed or suggested.** |
| `MIGRATION_DATABASE_URL_SECRET_NAME` | `MIGRATION_DATABASE_URL_SECRET_VERSION` | Confirm existing **migration-role** DB secret name/version; not supplied by OAuth handoff |
| `DATABASE_URL_SECRET_NAME` | `DATABASE_URL_SECRET_VERSION` | `call-now-staging-runtime-db-url`; confirm active version |
| `AUTH_TOKEN_PEPPER_SECRET_NAME` | `AUTH_PEPPER_SECRET_VERSION` | Confirm existing staging auth-pepper secret name/version |
| `GOOGLE_OAUTH_CLIENT_SECRET_NAME` | `GOOGLE_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-google-login-client-secret`, version **1** per handoff |
| `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_NAME` | `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-microsoft-login-client-secret`, version **1** per handoff |
| `GMAIL_OAUTH_CLIENT_SECRET_NAME` | `GMAIL_OAUTH_CLIENT_SECRET_VERSION` | Confirm separate Gmail **monitoring** secret; do not use Google login secret |
| `MICROSOFT_OAUTH_CLIENT_SECRET_NAME` | `MICROSOFT_OAUTH_CLIENT_SECRET_VERSION` | Confirm separate Microsoft **mail monitoring** secret; do not use Microsoft login secret |
| `SMTP_USER_SECRET_NAME` | `SMTP_USER_SECRET_VERSION` | Optional in staging; if used, confirm the existing name and pinned version. Required in production |
| `SMTP_PASSWORD_SECRET_NAME` | `SMTP_PASSWORD_SECRET_VERSION` | Optional in staging; if used, confirm the existing name and pinned version. Required in production |

### SMTP-only staging omission contract

The following plain GitHub Environment variables are also optional in staging
and required in production:

| Variable | Validation when supplied | Omitted staging behavior in the existing API |
| --- | --- | --- |
| `SMTP_HOST` | Nonempty host without whitespace, comma or NUL | Defaults to `127.0.0.1` |
| `SMTP_PORT` | Decimal integer, 1–65535 | Defaults to `1025` |
| `SMTP_SECURE` | Literal `true` or `false` | Defaults to `false` |
| `EMAIL_FROM` | At least 3 characters, not whitespace-only; no comma, CR, LF or NUL | Defaults to `Call Now <no-reply@call-now.local>` |

For staging, missing variables and empty strings (GitHub's unset-variable
representation) are treated as absent. An SMTP secret's **name and version must
both be absent or both valid**; supplying just one fails preflight. Configured
secret names retain the existing ID validation and versions must be positive
integers, never `latest`. Whitespace-only/malformed values are not omission.
Plain variables can be omitted independently; any supplied value is validated.
The preflight now explicitly checks the four plain SMTP variables; previously
they were emitted unconditionally without format checks. Diagnostics still
contain only field names, not values.

The workflow builds the existing API environment/secret lists, then appends
only nonempty SMTP settings. SMTP metadata passes via the step's shell
environment rather than being interpolated into executable shell code. Quoted
sender display names are preserved; commas are rejected because the existing
Cloud Run list format uses commas as separators. It does not create defaults,
fetch secret payloads or infer secret names. With complete production metadata,
the resulting mappings and deployment options are unchanged.

Source-of-truth recheck on the base commit: `apps/api/src/config/env.ts` already
supplies these defaults and allows empty `SMTP_USER`/`SMTP_PASSWORD`.
`SmtpMagicLinkEmailSender` constructs a transport at startup but calls
`sendMail()` only for an actual magic-link email request. Readiness checks the DB,
not SMTP. Omitting SMTP is therefore safe for startup/login OAuth **assuming all
other required application configuration and DB access are valid**. It is not an
SMTP-disable flag and does not make outbound mail operational: magic-link mail
would still attempt the configured/default SMTP server and can fail. Do not use
outbound email tests until SMTP is configured. No application code is changed.

**`GMAIL_OAUTH_*` and `MICROSOFT_OAUTH_*` (mail-monitoring OAuth) are unaffected
and remain required in staging and production.** Their secret name/version
pairs remain mandatory; application boot validation and the unconditional
workflow mappings are unchanged. `GMAIL_PUSH_MONITORING_ENABLED=false` does not
remove these requirements. KMS requirements also remain unchanged; the shared
encryption provider is used by mail and device registration. Google/Microsoft
**login** OAuth settings are untouched. This SMTP-only change does not resolve
staging's missing mail-monitoring credentials or establish native-login E2E
readiness.

Manual work (not performed here): leave the two SMTP name/version pairs and
plain SMTP variables unset in staging while outbound mail is deferred; populate
valid values when SMTP testing is approved. Production must explicitly supply
all eight fields. Do not remove or repurpose mail-monitoring/login secret refs.

For production, also set `API_SERVICE_NAME` and `MIGRATION_JOB_NAME` explicitly.
`call-now-api` / `call-now-db-migrate` are reasonable candidate values based on
the previous hardcoded commands, **not confirmed production resource names**.
Verify them before setting the variables. There is no implicit default in either
environment. A syntactically valid but wrong resource name is not detected by
the offline validator; resource existence and callback-host alignment remain
operator checks before deployment.

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

1. Resource-name **wiring is fixed**, but manual setup is still required:
   set staging `API_SERVICE_NAME=call-now-staging-api` to match the registered
   callback host. **Staging `MIGRATION_JOB_NAME` is NOT CONFIRMED** and must be
   looked up by the user before running the workflow. No cloud lookup was
   performed by this change. Explicitly configure and verify production's
   resource names too; syntax validation alone does not confirm existence.
2. The current main does not include PR #43's native PKCE endpoints. This PR
   does not integrate #43, change `apps/ios/`, or wire `NATIVE_AUTH_MODE`.
   Select/integrate the reviewed staging application revision separately before
   claiming native login E2E readiness; this workflow still builds the selected
   Git ref, not a pre-existing staging image.
3. Gmail/Microsoft **mail monitoring** credentials remain required in both
   environments, regardless of whether push monitoring is enabled. Verify those
   resources/settings instead of inventing names or reusing login credentials.
   Only SMTP references/settings may now be omitted in staging; production
   requires them. Missing mail-monitoring credentials still block deployment/
   application startup. This is not a general staging-disabled mail policy.
4. The existing migration/API steps still use `GCP_RUNTIME_SERVICE_ACCOUNT`.
   Verify access to each selected DB secret and correct DB privileges. This PR
   does not change service accounts or grant new privileges.
5. Only after manual metadata setup and separate deployment approval: confirm
   revision health, providers AVAILABLE, exact callbacks, user consent, PKCE code
   exchange and native session. Console setup is **not** proof of OAuth E2E.

## Local checks and stop point

- `pnpm test:deploy-config`: renders all resource targets and secret mappings for
  staging and production using synthetic metadata (not guessed real job names),
  verifies shared job deploy/execute target and unchanged image names, resource
  validation at 1/63/64-character boundaries, missing/invalid values, field-only
  diagnostics, Microsoft login vs monitoring
  separation, preflight order, missing/invalid names and versions, callback and
  tenant validation, and safe CLI failure output. SMTP cases cover missing/empty
  staging values, partial secret pairs, invalid supplied values, required
  production settings, preserved `false`, and quoted sender names. The actual
  API shell block runs against a builtin argument recorder with no SDK on PATH;
  this verifies omission and unchanged production mappings without gcloud or
  network calls.
- `apps/api/tests/env.test.ts`: complete single-tenant login tuple, missing
  fields, invalid tenants and HTTPS enforcement with synthetic secret values.
- `pnpm verify`: includes the new offline deployment regression suite.
- YAML syntax and `git diff --check`; `apps/ios/` diff must remain empty.

Local results (2026-09-27, SMTP-only follow-up):

| Check | Measured result |
| --- | --- |
| `pnpm test:deploy-config` | **31 PASS** (11 added SMTP cases; prior 20 resource/secret/OAuth cases retained) |
| `env.test.ts` | **17 PASS** (unchanged in this follow-up; also included in API total below) |
| `pnpm verify` | **PASS**: deploy 31, frontend 128, API 293; format/lint/typecheck/build passed |
| PostgreSQL integration | **118 skipped / not run**, no DB connection or migration requested for this code-only task |
| YAML syntax / `git diff --check` | PASS |
| `apps/api/`, `apps/ios/`, CI workflow changes | None |
| Cloud deployment / real OAuth / GitHub Actions | **Not run** |

No Actions workflow is dispatched. The commit uses `[skip ci]` so creating the PR
also does not start the repository's push/pull_request CI. This does **not**
disable CI settings; CI is deliberately **unexecuted**, not reported as passed.
See [GitHub's skip-workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

**Stop after commit/push and PR creation. No deploy, database changes, cloud
configuration, GitHub Environment edits, iOS edits, real Push or main merge.**
