#!/bin/bash
set -euo pipefail
taskroot=/QA_ROOT
proofroot="$taskroot/media-lane/proof"
runroot="$proofroot/full-gateway"
nodebin="$taskroot/runtime/node-v24.21.0-linux-x64/bin/node"
if [[ ${OC_MEDIA_FULL_PROOF_LAUNCH:-} != 1 ]]; then
  echo 'Prepared only. Parent must release the heavy slot and reopen Bot API forward 18182 before OC_MEDIA_FULL_PROOF_LAUNCH=1.' >&2
  exit 2
fi
test -f "$runroot/config.private.json"
test ! -e "$runroot/launch-started"
touch "$runroot/launch-started"
chmod 600 "$runroot/launch-started"
providerpid=''
gatewaypid=''
stop_owned() {
  if [[ -n "$gatewaypid" ]]; then kill -TERM "$gatewaypid" 2>/dev/null || true; wait "$gatewaypid" 2>/dev/null || true; fi
  if [[ -n "$providerpid" ]]; then kill -TERM "$providerpid" 2>/dev/null || true; wait "$providerpid" 2>/dev/null || true; fi
}
trap stop_owned EXIT
trap 'exit 143' TERM INT
"$nodebin" "$proofroot/full-provider.mjs" "$runroot/workspace" "$runroot/provider-receipt.private.jsonl" >"$runroot/provider.private.log" 2>&1 &
providerpid=$!
printf '%s\n' "$providerpid" >"$runroot/provider.pid"
cd "$taskroot/media-lane/repo"
timeout --signal=TERM --kill-after=60s 12m "$nodebin" "$proofroot/full-gateway.mjs" >"$runroot/gateway.private.log" 2>&1 &
gatewaypid=$!
printf '%s\n' "$gatewaypid" >"$runroot/gateway-owner.pid"
wait "$gatewaypid"
