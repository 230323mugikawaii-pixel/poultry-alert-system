# Native login identity linking — implementation checkpoint

Date: 2026-10-01 (JST)

## Scope and base

- Repository: `poultry-alert-system`.
- Requested branch: `docs/mail-oauth-staging-wiring-20260927`.
- Starting HEAD: `e3ca8c33a6c4490de62722758775adc40b36c78b`.
- Backend implementation commit: `4e47b7a` (`feat(auth): bind native identity linking to session and PKCE`). iOS and this checkpoint are committed separately on top.
- OWNER primary-login identities only: Google / Microsoft. This is **not** mail-monitoring OAuth.
- Existing LOGIN/session exchange, Web LINK, provider adapters, Team provisioning and identity ownership constraints remain in use.
- No schema/migration, dependency, environment, OAuth console, deployment workflow or Bundle ID changes.
- The pre-existing untracked `docs/ios/codex-prompt-account-linking.md` is not modified or committed.

## Why the originally proposed route-only change was insufficient

URLSession and ASWebAuthenticationSession do not share the app session or OAuth state cookies. Returning the provider URL from the app's POST leaves the browser without the state cookie and authenticated identity required by the existing callback. Tests that manually combine both cookie stores would hide this failure.

The owner approved a one-use browser handoff followed by authenticated app finalization with PKCE. We do not relax `requireSameOrigin`, browser state validation, provider/nonce validation or identity ownership checks.

## Implemented protocol

| Step | Contract | Security boundary |
| --- | --- | --- |
| App starts | `POST /api/v1/auth/identities/:provider/link/start?client=native`, body `codeChallenge` + `codeChallengeMethod=S256` | Existing app session and exact Origin; server captures user ID and initiating session ID |
| Browser handoff | Response `{ authorizationUrl }` points to the API's `.../link/browser?handoff=...`, **not directly to Google/Microsoft** | Random 256-bit one-use handoff, valid for 2 minutes; trusted API origin from configured login redirect URI |
| Browser opens | `GET .../link/browser` consumes handoff, creates native-only LINK OAuth challenge and redirects to provider | State/native marker cookies are set in the browser's own store; no app session is copied into it |
| Provider callback | Existing callback checks state cookie; native-only branch verifies provider authorization and stores verified profile | Does **not** create/link an identity or issue a login session; callback ticket expires with the OAuth challenge (existing provider TTL) |
| App returns | `com.callnow.app://auth-callback?result=link_pending&loginProvider=...&code=...` | Code is a 2-minute one-use link proof, not a session exchange code; UI must not yet report success |
| App finalizes | `POST .../link/finalize`, body `code` + `codeVerifier` | Exact Origin, active original user/session, provider and S256 binding all required; only then call existing `linkPrimaryIdentity` |
| UI refresh | `GET /api/v1/auth/identities` | No-store response; show success only after finalization; refetch list |

- Handoff, callback and finalization tickets use the existing `AuthChallenge` table, versioned payload and domain-separated HMAC hashes. They are not stored in a process-local map.
- SERIALIZABLE transactions plus conditional consume prevent concurrent ticket reuse. Invalid binding does not consume the rightful app's finalization ticket.
- Native OAuth challenges cannot be completed through the Web/LOGIN path if the browser marker is removed or changed; this prevents bypassing app finalization.
- PKCE verifier remains in iOS memory. No session token, provider authorization code, access token or refresh token is persisted in a native link ticket. Finalization stores only the verified identity fields needed by the existing repository.
- Expiry means the record cannot be used; it is not a new physical-deletion/retention worker. Existing AuthChallenge maintenance policy still applies.
- Errors retain machine codes, including `LOGIN_IDENTITY_ALREADY_IN_USE` and `LOGIN_PROVIDER_ALREADY_LINKED`, mapped through shared iOS messages. Raw server error bodies are not displayed.
- Ticket consumption and the subsequent identity-link transaction are separate and fail closed: failure after consumption requires restarting the flow. No successful link is claimed when finalization fails.

## iOS UI

- Add “ログイン方法を管理” sheet beside logout, linked identities list, Google/Microsoft add actions, progress and error messages.
- Separate `IdentityLinkSession` from `AuthSession`; existing login flow is unchanged except shared error-message access.
- Validate bootstrap origin/path and callback scheme/host/provider; reject duplicate callback query parameters.
- Prevent duplicate starts/finalizations and ignore late results after cancellation/dismissal.
- No unlink UI or Apple Sign-In additions. No provider token or verifier logging/persistence.
- Existing `com.callnow.app` callback scheme and project settings on this branch are preserved; this task does not integrate other iOS branches.

## Executed checks

| Check | Actual result |
| --- | --- |
| New native-link route/service tests | 16 PASS: separate cookie stores, both providers, one-use/replay/concurrency, state, downgrade prevention, PKCE, original-session/user binding, revocation, Origin, provider mismatch, three-stage expiry, ownership conflicts, Web LINK and native LOGIN compatibility |
| Existing primary auth service/routes | 9 PASS |
| API full test suite | 309 PASS; 120 PostgreSQL-gated tests skipped in this unit invocation |
| `pnpm --filter @call-now/api typecheck` | PASS |
| API lint / formatting | PASS |
| `pnpm verify` | PASS, including deploy-config 31, frontend 128, API 309, format/lint/typecheck/build |
| Disposable PostgreSQL 17: `pnpm test:postgres` | 32 PASS, including 2 new native-link persistence/atomic-consumption tests |
| PostgreSQL cross-instance test | Handoff on one service, callback on another, 2 concurrent finalizations: exactly 1 succeeds; second-provider login resolves to same user; no additional session issued by linking |
| PostgreSQL setup | All existing 28 migrations applied to a newly created tmpfs container; Prisma validate and schema drift check PASS (no difference) |
| XcodeGen / unsigned simulator build | PASS; iPhone 17e, iOS 27.0, separate DerivedData |
| Simulator unit tests | 19 PASS / 0 FAIL / 0 skipped (9 existing + 10 new); no real OAuth/Apple call |
| `git diff --check` | PASS |

The first PostgreSQL cross-instance test exposed that the existing test provider kept its nonce in an individual mock object. The fixture was corrected to model one external identity provider shared by two independent Call Now service instances. No production validation was weakened; the rerun passed all 32 tests. Initial formatting/lint and optional request-body compatibility failures were also corrected before the successful runs above.

The other 88 PostgreSQL-gated tests were not separately rerun in this task. The existing CI `test:postgres` command includes the two new tests. GitHub CI is not claimed successful: this branch's push alone is outside CI's branch filter, and no workflow dispatch is performed.

The disposable test database/container is removed after verification; only synthetic test data is discarded. Existing databases/containers and the user's previously open simulators are not modified. The separate simulator test result bundle remains under `/tmp/callnow-native-link-derived-20261001/Logs/Test/`.

## Changed files

Backend:

- `apps/api/src/app.ts` — additional redaction paths.
- `apps/api/src/modules/auth/auth-repository.ts` — native ticket contracts / native-only challenge marker.
- `apps/api/src/modules/auth/native-link-ticket.ts` — persisted payload/binding validation.
- `apps/api/src/modules/auth/prisma-auth-repository.ts` — durable one-use ticket storage.
- `apps/api/src/modules/auth/primary-auth-service.ts` — handoff, verification and authenticated finalization.
- `apps/api/src/modules/auth/primary-auth-routes.ts` — routes, browser cookie creation, cache protection.
- `apps/api/tests/helpers/memory-auth.ts` — matching fake ticket repository.
- `apps/api/tests/native-identity-link.test.ts` — separate-cookie-store and security tests.
- `apps/api/tests/postgres-concurrency.integration.test.ts` — real DB persistence/consume tests.

iOS:

- `Sources/Auth/IdentityLinkSession.swift` and `Sources/Auth/NativeLinkProof.swift`.
- `Sources/Auth/AuthSession.swift` — share existing error mapping.
- `Sources/Models/LinkedIdentity.swift`.
- `Sources/Networking/APIClient.swift` and `APIError.swift` — safe machine-code handling; correct stale cookie-sharing comment.
- `Sources/Views/LinkedAccountsView.swift` and `NotificationStatusView.swift`.
- `Tests/CallNowTests/NativeIdentityLinkTests.swift`.

All iOS paths above are under `apps/ios/CallNow/`. This report is the only new documentation file.

## Not yet verified / stop point

- At this implementation checkpoint, staging was not deployed; owner approval was required before executing `scripts/deploy-manual-staging.sh`. The subsequent approved deployment is recorded in [the staging checkpoint](native-identity-link-staging-results.md).
- Real Google login → Microsoft linking → logout → Microsoft login to the same user/Team remains unverified. Simulator tests use fakes; they are not provider E2E evidence.
- Human Google/Microsoft authentication/consent will be needed after an approved staging deployment and staging-configured app build.
- Existing LOGIN's process-local `native/exchange` storage remains unchanged and retains its prior multi-instance/restart limitation. The new LINK tickets do not share that limitation.
- No production/cloud/OAuth configuration changes, existing DB application, real mail/Push, main merge, or unrelated PR integration.
