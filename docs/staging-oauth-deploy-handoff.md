# Staging OAuth login: deploy wiring handoff (2026-09-27)

Context: this session (Claude, via browser automation) finished the *console-side* setup for
native login on the staging GCP project (`call-now-staging-20260927`). What's left is
*application/deploy* wiring — implementation work, not console clicking — being handed off to
a Claude Code / Codex session working in this repo.

## What's already done (console side, verified)

- Google OAuth client `callnow-ios-staging` (Web application) exists in
  `call-now-staging-20260927`; old leaked secret (`****TkOA`) disabled + deleted, only the
  current secret (`****CKWH`) remains active.
- Google OAuth consent screen: publish status is **Testing** (external user type); added
  `230323mugikawaii@gmail.com` as the sole test user (0 → 1); added the three scopes
  `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid` (previously 0 scopes
  configured).
- New Microsoft Entra App registration `call-now-staging` created in the tenant
  `230323Mugikawaiigmail.onmicrosoft.com` (the personal/default directory), **single-tenant**
  (`AzureADMyOrg` / 所属する組織のみ). Default `Microsoft Graph User.Read` delegated permission
  only (no admin consent required — sufficient for login).
  - Application (client) ID: `3f5a7e56-c7cb-46a0-9477-ca90b696d3d8`
  - Directory (tenant) ID: `6af9d90a-8ed4-420b-ad82-a80296dee18d`
  - Redirect URI (Web platform): `https://call-now-staging-api-404996456750.asia-northeast1.run.app/api/v1/auth/microsoft/callback`
  - A client secret was generated and stored (see Secret Manager below); it is **not**
    reproduced here since Entra only shows it once and it's already saved.
- Google Cloud Secret Manager (`call-now-staging-20260927`), all 4 secrets below now hold an
  active version 1, and `call-now-api@call-now-staging-20260927.iam.gserviceaccount.com`
  already has `roles/secretmanager.secretAccessor` bound directly on each (verified, not
  inherited):
  - `call-now-staging-google-login-client-id`
  - `call-now-staging-google-login-client-secret`
  - `call-now-staging-microsoft-login-client-id`
  - `call-now-staging-microsoft-login-client-secret`

## What's still missing (this is the actual implementation gap)

`apps/api/src/config/env.ts` already implements Microsoft login config parsing/validation
(`MICROSOFT_LOGIN_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI/TENANT/STATE_TTL_MINUTES`, validated by
`isAllowedMicrosoftTenant`), and `apps/api/src/modules/auth/primary-auth-routes.ts` already
has the route logic. The gap is entirely in **how staging's Cloud Run deploy gets these values
into the container**:

1. **`.github/workflows/deploy.yml` never sets any `MICROSOFT_LOGIN_OAUTH_*` var at all** in
   the `gcloud run deploy call-now-api` step — neither in `--set-env-vars` nor
   `--set-secrets`. Microsoft login is simply not wired into deploy yet, for any environment.
2. **Secret name mismatch between deploy.yml and the actual staging Secret Manager naming.**
   `deploy.yml` hardcodes secret names with no environment prefix, e.g.
   `--set-secrets "...,GOOGLE_OAUTH_CLIENT_SECRET=call-now-google-oauth-client-secret:...`
   and `DATABASE_URL=call-now-database-url:...`. But the actual secrets that exist in the
   `call-now-staging-20260927` project all use a `call-now-staging-` prefix (confirmed via
   console: `call-now-staging-runtime-db-url`, `call-now-staging-google-login-client-id`,
   etc.) — there is no secret literally named `call-now-database-url` or
   `call-now-google-oauth-client-secret` in this project. Whatever mechanism previously
   deployed the working staging services (DB, APNs worker per the 2026-09-27 reliability
   notes) did not go through this literal `--set-secrets` line as currently written, or the
   `staging` GitHub Environment's `vars.*_SECRET_VERSION` were never actually exercised
   end-to-end against this project. Either way, login won't deploy correctly to staging until
   this is reconciled — needs a decision (see below) plus a fix, not just a value change.
3. **Tenant value must not be `common`.** `.env.example` defaults
   `MICROSOFT_LOGIN_OAUTH_TENANT=common`, and `isAllowedMicrosoftTenant()` accepts
   `common`/`organizations`/`consumers` or a GUID. Since the new `call-now-staging` app
   registration is **single-tenant** (`AzureADMyOrg`), the `common` multi-tenant endpoint will
   be rejected by Microsoft at the authorize step. For staging this must be the tenant GUID:
   `6af9d90a-8ed4-420b-ad82-a80296dee18d`.
4. Google login's redirect URI is already correct in Google Cloud
   (`.../api/v1/auth/google/callback`) and matches the `GOOGLE_OAUTH_REDIRECT_URI` pattern in
   `.env.example` — just confirm the `staging` GitHub Environment's `vars.GOOGLE_OAUTH_*` /
   `vars.GOOGLE_OAUTH_CLIENT_SECRET_VERSION` actually point at this project's secrets once (2)
   above is resolved.

## Suggested next steps for implementation

- Decide how deploy.yml should resolve secret names per environment (e.g. a
  `vars.SECRET_NAME_PREFIX` used to build `${prefix}google-login-client-secret` etc., or
  separate per-environment hardcoded blocks) — this affects every secret in the line, not just
  the login ones, so worth fixing once rather than patching around it.
- Add `MICROSOFT_LOGIN_OAUTH_CLIENT_ID`, `MICROSOFT_LOGIN_OAUTH_REDIRECT_URI`,
  `MICROSOFT_LOGIN_OAUTH_TENANT` to `--set-env-vars`, and
  `MICROSOFT_LOGIN_OAUTH_CLIENT_SECRET=<staging secret name>:<version>` to `--set-secrets`.
  `GOOGLE_OAUTH_CLIENT_ID` similarly needs the client ID value
  (`404996456750-ika6lnuhul1t53dhlgt5og26pq1ijj27.apps.googleusercontent.com`) available to
  the `staging` GitHub Environment as a var (or read from Secret Manager at deploy time —
  match whatever pattern is chosen for the other IDs).
- Set the `staging` GitHub Environment's variables/secret-version refs to point at the actual
  `call-now-staging-20260927` secrets once the naming approach is settled.
- After deploy, exercise the real OAuth E2E (`/api/v1/auth/google` and
  `/api/v1/auth/microsoft`) against staging using the test user
  (`230323mugikawaii@gmail.com` for Google; any account in the
  `230323Mugikawaiigmail.onmicrosoft.com` tenant for Microsoft) to close out the two
  `docs/primary-login.md` release blockers this unblocks.
