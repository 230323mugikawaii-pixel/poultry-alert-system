# OAuth deploy wiring — implementation and manual configuration

## Scope / design decision

This document records **code-only** corrections to `.github/workflows/deploy.yml`. The secret
wiring was introduced by PR #46. The resource-name follow-up is based on
`b12ec8e55000cfc54a5dec2608775c4f9abb15bf` (main with #46 merged).
The SMTP-only follow-up is based on
`99f3f952ca95c787c961b83a4021cdd01acf26fd`; fetching and inspecting
`git log origin/main` confirmed both #46 and #47 are merged.
The mail-monitoring OAuth metadata update is **documentation only**, based on
`50fb107c025ccdffea65a0c2d94698188e3aefd8` (main with #46, #47 and #48 merged).
Its console setup and Secret Manager contents are owner-reported; the offline
review below does not read secret payloads or GitHub Environment settings.
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
| `GMAIL_OAUTH_CLIENT_SECRET_NAME` | `GMAIL_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-gmail-client-secret`, version **1**, owner-confirmed for Gmail **monitoring**; not the Google login secret |
| `MICROSOFT_OAUTH_CLIENT_SECRET_NAME` | `MICROSOFT_OAUTH_CLIENT_SECRET_VERSION` | `call-now-staging-microsoft-mail-client-secret`, version **1**, owner-confirmed for Microsoft **mail monitoring**; not the Microsoft login secret |
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
**login** OAuth settings are untouched. The SMTP-only change did not configure
mail-monitoring credentials. The subsequently supplied metadata is documented
below; neither change establishes native-login E2E readiness.

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

### Staging mail-monitoring OAuth — pending GitHub Environment configuration

On 2026-09-27 the owner confirmed creation of dedicated Gmail and Microsoft
Graph mail-monitoring OAuth clients, Gmail API enablement, and addition of
`gmail.readonly` to the Google consent configuration. Client secrets are already
stored in Secret Manager according to the owner. The following are **public
client IDs, callback URIs, and secret-reference metadata only**, not secret
payloads. Set these in the **staging** GitHub Environment; this documentation
update does not set them or independently inspect the consoles/Secret Manager.

| Variable | Required staging value |
| --- | --- |
| `GMAIL_OAUTH_CLIENT_ID` | `404996456750-6jtp2vbcirnigei60unktq5lnr0bkoop.apps.googleusercontent.com` |
| `GMAIL_OAUTH_REDIRECT_URI` | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/gmail/callback` |
| `GMAIL_OAUTH_CLIENT_SECRET_NAME` | `call-now-staging-gmail-client-secret` |
| `GMAIL_OAUTH_CLIENT_SECRET_VERSION` | `1` |
| `MICROSOFT_OAUTH_CLIENT_ID` | `d76ee340-d846-4dcc-86d1-dc227ecd8376` |
| `MICROSOFT_OAUTH_REDIRECT_URI` | `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/mail/microsoft/callback` |
| `MICROSOFT_OAUTH_TENANT` | `6af9d90a-8ed4-420b-ad82-a80296dee18d` |
| `MICROSOFT_OAUTH_CLIENT_SECRET_NAME` | `call-now-staging-microsoft-mail-client-secret` |
| `MICROSOFT_OAUTH_CLIENT_SECRET_VERSION` | `1` |

The Microsoft tenant is the same directory as the login registration, but the
mail **client ID and secret are distinct**. The parenthetical tenant explanation
in the handoff is not part of the UUID value. Do not change or reuse
`GOOGLE_OAUTH_*` / `MICROSOFT_LOGIN_OAUTH_*` login settings.

The existing workflow supplies the client IDs/callbacks/mail tenant through
`--set-env-vars`; it maps each secret name/version to the runtime variable
`GMAIL_OAUTH_CLIENT_SECRET` or `MICROSOFT_OAUTH_CLIENT_SECRET` through
`--set-secrets`. The `_NAME`/`_VERSION` variables are not substitutes for runtime
secret payloads and must not contain those payloads.

Read-only code cross-check:

- `google-mail-provider.ts` requests `openid`, `email`, and
  `https://www.googleapis.com/auth/gmail.readonly`, with offline access.
- `microsoft-mail-provider.ts` requests `openid`, `profile`, `email`,
  `offline_access`, and `https://graph.microsoft.com/Mail.Read`.
- Both supplied HTTPS callbacks have the existing `mail-connection-routes.ts`
  paths and the registered staging API host. Console-side scope/URI alignment
  is owner-confirmed, not a newly executed OAuth consent flow.

For this deployment, leave `GMAIL_PUSH_MONITORING_ENABLED` and Pub/Sub settings
unset; the application defaults monitoring to **false**, and jobs/ledger to
**off**. Leave SMTP metadata/settings unset as permitted by #48. This does not
remove mail OAuth or KMS boot requirements. In staging with monitoring OFF,
`getMailProviderAvailability(..., "GOOGLE")` intentionally returns
`NOT_CONFIGURED`: startup/login readiness does not imply Gmail monitoring is
AVAILABLE, and Gmail monitoring connection UI may remain disabled. Microsoft
mail configuration availability is separate from proof of real Graph delivery.

### Offline pre-deploy read-through — scope and remaining prerequisites

No application or workflow change is needed for the **supplied nine metadata
values**. The following distinguishes syntax/required-field checks from live
operational verification:

| Check | Result / condition |
| --- | --- |
| Mail OAuth required fields | Both ID/secret/redirect triples and the Microsoft tenant are accounted for; secret payloads must be injected from the two references above. State TTL values default to 10 minutes (allowed 5–30), so no extra TTL input is missing |
| Microsoft mail tenant | The supplied UUID matches `isAllowedMicrosoftTenant()`; the same directory value also meets the existing staging login tenant rule |
| Callback URI and client ID format | Both callbacks use HTTPS and the exact existing route paths/host. IDs are nonempty and do not use development placeholders |
| Secret metadata | Both supplied names meet the existing Secret Manager ID pattern; version `1` is a valid positive, pinned version. Secret content, ENABLED state and IAM access are not checked here |
| Deploy preflight coverage | Validates secret references, resource names and login metadata; it does **not** validate mail client IDs/callbacks/tenant or all infrastructure values. The separate `loadEnvironment` check is required; preflight success alone is not startup proof |
| Other secret references | The DB, migration-role DB, auth-pepper and login secret references in the existing table remain required. No names/versions are guessed or changed by this update; actual GitHub Environment values are not read |
| Plain startup settings | `PUBLIC_ORIGIN` must be a valid origin without a path; `COOKIE_NAME` and `MAIL_TOKEN_ENCRYPTION_KEY_VERSION` must be nonempty; `MAIL_KMS_KEY_NAME` must be a valid `projects/.../locations/.../keyRings/.../cryptoKeys/...` resource. The workflow explicitly supplies these, so empty GitHub variables override application defaults and can fail startup. `MAIL_TOKEN_ENCRYPTION_PROVIDER=gcp-kms` is already wired |
| Infrastructure / secrets | Existing project, region, Artifact Registry, service/job names, Workload Identity, runtime/deploy service accounts and Cloud SQL settings still need correct Environment values. Runtime `DATABASE_URL` must work and `AUTH_TOKEN_PEPPER` must meet its 32-character minimum. These cannot be verified from secret names alone; no payload or live DB is accessed |
| Health and OAuth execution | `/readyz` depends on DB connectivity. Real startup, IAM, OAuth token exchange/consent, health endpoints and native PKCE are **not executed** in this documentation-only task |

The repository's older table still marks some infrastructure metadata as needing
operator confirmation. Do not infer concrete Environment values from examples
or from offline fixtures. This review confirms compatibility of the supplied
mail OAuth metadata, **not an unconditional go-ahead to deploy**.

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
   environments, regardless of whether push monitoring is enabled. The owner
   has now supplied the dedicated clients and secret references above; the
   remaining action is to populate the staging Environment and confirm runtime
   access to the new secret versions. No settings are written by this PR.
   Only SMTP may be omitted in staging; production requires it. Mail credentials
   are not replaced by login credentials or made optional.
4. The existing migration/API steps still use `GCP_RUNTIME_SERVICE_ACCOUNT`.
   Verify access to each selected DB secret and correct DB privileges. This PR
   does not change service accounts or grant new privileges.
5. Only after manual metadata setup and separate deployment approval: confirm
   revision health, **login** providers AVAILABLE, exact callbacks and user
   consent; native PKCE exchange/session additionally needs the application
   revision noted in item 2. Gmail mail-provider `NOT_CONFIGURED` with push OFF
   is expected. Console setup is **not** proof of OAuth E2E.
6. **Future Gmail Push enablement, out of scope:** `GMAIL_PUSH_MONITORING_ENABLED=true`
   additionally requires `GMAIL_PUBSUB_TOPIC_NAME` (`projects/.../topics/...`),
   `GMAIL_PUBSUB_PUSH_AUDIENCE` (HTTPS webhook URL), and
   `GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` (service-account email).
   Confirm OIDC audience/endpoint, Pub/Sub push and publisher/authentication IAM
   before starting any watch. The current `deploy.yml` does **not** forward
   these four variables: adding GitHub variables alone will not enable push;
   a separately scoped workflow change/review is required. If durable intake is
   later selected, `GMAIL_PUSH_JOB_MODE=durable` additionally requires monitoring
   ON and `MAIL_LEDGER_MODE=legacy-outbox`; both default off. Nothing in this PR
   starts a watch, worker, real mail operation or Pub/Sub request.

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

Local results re-run on 2026-09-27 for the documentation-only mail OAuth update:

| Check | Measured result |
| --- | --- |
| Document metadata transcription | **9/9 exact matches** against the owner's supplied public values |
| One-off offline configuration assertions | **13 PASS**: documented metadata + synthetic secret payloads/remaining infrastructure; both validators pass, required/invalid cases still fail, monitoring stays off, SMTP omission works. Executed in memory without changing test files, starting the API, or contacting external services |
| `pnpm test:deploy-config` | **31 PASS** (existing suite re-run; test code unchanged) |
| `env.test.ts` | **17 PASS** (separate targeted run; also included in API total below) |
| `pnpm verify` | **PASS**: deploy 31, frontend 128, API 293; format/lint/typecheck/build passed |
| PostgreSQL integration | **118 skipped / not run**, no DB connection or migration requested for this code-only task |
| `git diff --check` / docs-only diff | PASS; only this Markdown file changed |
| Application / workflow / validator / test / iOS changes | None |
| Cloud deployment / real OAuth / GitHub Actions | **Not run** |

No Actions workflow is dispatched. The commit uses `[skip ci]` so creating the PR
also does not start the repository's push/pull_request CI. This does **not**
disable CI settings; CI is deliberately **unexecuted**, not reported as passed.
See [GitHub's skip-workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

**Stop after commit/push and PR creation. No deploy, database changes, cloud
configuration, GitHub Environment edits, iOS edits, real Push or main merge.**
