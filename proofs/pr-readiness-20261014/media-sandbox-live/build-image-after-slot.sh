#!/bin/bash
set -euo pipefail
if [[ ${OC_MEDIA_SANDBOX_BUILD:-} != 1 ]]; then
 echo 'Preparation only: coordinator must explicitly release image-build slot before OC_MEDIA_SANDBOX_BUILD=1.' >&2
 exit 2
fi
cd /QA_ROOT/media-lane/repo
test "$(git rev-parse HEAD)" = b6e89d0ee6988565f74bc1b82778f8df65196f32
export OPENCLAW_SANDBOX_IMAGE=openclaw-sandbox:qa-170200-b6e89d0
export OPENCLAW_DOCKER_BUILD_RETRIES=0
export OPENCLAW_DOCKER_BUILD_TIMEOUT=600s
export OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT=1
./scripts/sandbox-setup.sh
docker image inspect --format '{{.Id}}' "$OPENCLAW_SANDBOX_IMAGE"
