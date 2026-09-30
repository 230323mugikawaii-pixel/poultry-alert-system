#!/bin/bash
# Manual staging deploy, bypassing GitHub Actions "Deploy API".
#
# Use this only when the CI workflow (.github/workflows/deploy.yml) can't be
# used because `pnpm verify` fails on pre-existing, unrelated test bugs in
# tests/deploy-workflow.test.mjs (SMTP validation + secret-version-resolution
# logic — see git history around 2026-09-28/29 for details).
#
# Safe by construction: `gcloud run deploy` is called with only --image set,
# so it preserves every existing env var, secret, and service-account setting
# on the revision instead of touching them.
set -euo pipefail

IMAGE="asia-northeast1-docker.pkg.dev/call-now-staging-20260927/call-now-staging/call-now-api:manual-$(date +%s)"

gcloud auth configure-docker "asia-northeast1-docker.pkg.dev" --quiet
docker build --platform linux/amd64 --file apps/api/Dockerfile --target runtime --tag "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy call-now-staging-api \
  --project call-now-staging-20260927 \
  --region asia-northeast1 \
  --image "$IMAGE" \
  --quiet

echo "DEPLOYED: $IMAGE"
