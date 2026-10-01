# Native identity linking — staging deployment checkpoint

Date: 2026-10-01 (JST). Owner explicitly approved staging deployment after the implementation checkpoint.

## Deployed artifact

| Item | Recorded value |
| --- | --- |
| Source branch | `docs/mail-oauth-staging-wiring-20260927` |
| Deployed source commit | `e139ceda23b0ea4c34e097ddcc7439bdf135240a` |
| Project / region | `call-now-staging-20260927` / `asia-northeast1` |
| Existing API service | `call-now-staging-api` |
| API / registered OAuth host | `https://call-now-staging-api-404996456750.asia-northeast1.run.app` |
| Previous revision | `call-now-staging-api-00008-vs5` |
| New ready revision | `call-now-staging-api-00009-zzn` |
| Traffic after deployment | 100% to the new revision |
| Image | `asia-northeast1-docker.pkg.dev/call-now-staging-20260927/call-now-staging/call-now-api:manual-1790853609` |
| Pushed image-index digest | `sha256:e65d6ce8331647d7d8358be7f6e224736dd1159ca0206921bc71fd68de2385c2` |
| Cloud Run resolved image digest | `sha256:f9b6f001e72703608e08fcdd6290b65829e620589e5b78673ce4cdcd565176eb` |

Executed the existing `scripts/deploy-manual-staging.sh` from a clean `git archive` of the exact commit above, not from the working directory. The owner's untracked prompt and local settings were excluded. The runtime image was built for `linux/amd64`, pushed to the existing Artifact Registry repository and deployed to the existing staging API. No migration image/job was built or executed.

Before/after comparison of the complete revision spec excluding the image, plus template annotations, produced the same SHA-256 fingerprint. Thus environment variables, Secret Manager references, service account, Cloud SQL attachment, scaling and other revision configuration were preserved. Secret values were neither printed nor retrieved through Secret Manager payload access. The CLI read the service configuration internally for comparison and printed only a safe projection/hash.

`GMAIL_PUSH_MONITORING_ENABLED=false`, `MOBILE_PUSH_DELIVERY_MODE=off` and maximum scale 1 remain unchanged. The existing process-local native LOGIN exchange limitation remains; this deployment does not claim to resolve it. Native LINK tickets use the existing database-backed challenge table.

## Actual post-deployment checks

| Check | Result |
| --- | --- |
| API runtime Docker build / registry push / Cloud Run deployment | PASS |
| Cloud Run Ready condition | `True` |
| `/readyz` | HTTP 200 before and after |
| `/api/v1/auth/providers` | HTTP 200; GOOGLE and MICROSOFT AVAILABLE, APPLE NOT_CONFIGURED |
| Native LINK start, unauthenticated, both providers | 2 PASS: HTTP 401 / UNAUTHENTICATED |
| Native LINK finalize, unauthenticated, both providers | 2 PASS: HTTP 401 / UNAUTHENTICATED |
| Native LINK finalize, invalid Origin, both providers | 2 PASS: HTTP 403 / ORIGIN_NOT_ALLOWED |
| Browser handoff, synthetic nonexistent ticket, both providers | 2 PASS: HTTP 302 to the app's error callback / PRIMARY_LOGIN_INVALID_OR_EXPIRED, no-store and no-referrer |
| Public `/healthz` | **HTTP 404 before and after**, HTML Google error page, on both Cloud Run hostname aliases before deployment; registered host rechecked after deployment |
| iOS staging-configured unsigned build | PASS; clean archived sources, iPhone 17e / iOS 27.0 |
| Built iOS API URL / PUBLIC_ORIGIN | Both equal the staging registered host above |
| Simulator install / launch | PASS; login screen with Google/Microsoft buttons verified by screenshot |

Eight negative/security probes passed. Requests did not use real sessions or provider credentials, follow redirects to Google/Microsoft, initiate an OAuth login, or create a linked identity. They are **not** evidence of successful real-provider E2E.

The public `/healthz` 404 predates this deployment and has not been fixed or attributed to a specific cause. `/readyz` and login-provider availability are healthy; do not report every health endpoint as passing. No unrelated routing change was made.

Implementation tests (309 API unit tests, 32 isolated PostgreSQL tests, 19 simulator tests and `pnpm verify`) were executed at the preceding implementation checkpoint; they were not rerun during this deployment. See [implementation results](native-identity-link-implementation-results.md). No GitHub Actions deploy workflow or CI run was dispatched in this step.

## Human verification pending

- The separate iPhone 17e simulator contains the new staging-configured build and is on the login screen. Previously open iPhone 18 Pro / Pro Max instances were not replaced or shut down.
- This installed Xcode exposes DeviceHub rather than a discoverable `Simulator.app`. DeviceHub was opened. Automated native-window inspection was unavailable; the iPhone 17e framebuffer screenshot confirms the app screen, not which DeviceHub window is foreground.
- Next action: select iPhone 17e in DeviceHub, press **Googleでログイン**, and sign in with the existing staging test account. Human credentials/consent are required; none were entered by the agent.
- Then verify “ログイン方法を管理” → “Microsoftを追加” → authenticated linking, and finally Microsoft login to the same user/Team. These are **not yet verified**.

## Rollback and stop position

The previous revision remains available. If rollback is approved/needed, route this staging service's traffic back to `call-now-staging-api-00008-vs5` with `gcloud run services update-traffic`, explicitly specifying the staging project and region. This command was **not executed**. No schema changes need reversing.

No production API/DB, OAuth console configuration, Secret Manager version, IAM policy, main merge, new cloud resource, real email, APNs/Push or monitoring change was performed. No database migration, reset or manual data update was executed. Stop at the human login/consent checkpoint.
