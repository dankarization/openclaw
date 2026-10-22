# Gateway threshold/restart proof — 254aef0

Published head: `254aef058c40a0b97492e4d357bb8e9dc2e27aae`.
Native checked merge: `25977f791fb40899cf04aed444b40b8268767c6c`.
Both have tree `b5574da8989e9f5f5f08873778070740b2b1119c` and ordered parents `4044e1ff4caf1e54f49082f942294eac9d1b4971` and main `cf2558f5639e273dc4fe1f19e9c5f7715dc8d0de`. Ordinary atomic publication preserved both parents; no force push.

GitHub's reported conflict was real and confined to the generated config-baseline checksum. The normal generator and check resolved it. Main's other upstream changes are retained. Within files overlapping this feature, the only production-file delta from 4044 is an upstream import relocation in the new-session submission owner; no custom production logic was added for conflict resolution. An independent read-only integration review found no concrete lost repair or incompatibility.

## Actual shipped Gateway and model

This is a **new execution of published 254aef0**, using the shipped `dist/index.js` Gateway and shipped CLI `gateway call` entry point. The existing actual `local/gemma4:12b` was both primary and utility, through the authorized durable Ollama queue. No completion output was stubbed and no title was patched manually. Model selection used normal `sessions.patch` before the opening task; all four task turns succeeded, without an excluded authentication or session-creation attempt.

The same existing stopped QA checkout/profile was updated in place. Verification covered **58,621 source files and 40,760 runtime files across 26 roots**, including modes, membership and deletions: zero mismatches. No full checkout, dependency installation, model download or new environment was created. The affected-files backup was verified before replacing files; the prepared rollback was validated without applying it. The 136,198,567-byte delivery archive was removed after successful verification; its checked Mac original and the 135,376,473-byte rollback backup remain.

| Gateway snapshot UTC, 22 October 2026 | Ordinary turn | Returned displayName |
| --- | --- | --- |
| 21:25:09.027 | Opening meeting plan | Planning a team meeting |
| 21:25:14.060 | First PostgreSQL restore follow-up | Planning a team meeting |
| 21:28:10.903 | Second follow-up, threshold 2, after restart | PostgreSQL backup and recovery rehearsal |
| 21:28:16.106 | Additional backup/WAL validation turn | PostgreSQL backup and recovery rehearsal |

Each turn received a real model reply. All four replies exactly match the captured `chat.history`, which contains four user turns and four assistant replies.

After the first follow-up, normal Gateway shutdown at **21:26:35 UTC returned exit 0**. Disposable offline copies of the actual core/agent SQLite databases passed integrity and foreign-key checks. The naming record contained count **1**, done **false**, its original generated title and one bounded task excerpt.

After restart at **21:27:25 UTC**, normal `sessions.describe` confirmed the same session identity, model and title. The next follow-up refined at threshold 2; the later turn kept the refined title. Final normal shutdown at **21:28:47 UTC returned exit 0**. Reopened SQLite confirmed count **2**, done **true**, matching refined display/generated names, and **no retained excerpts**. Both databases again passed integrity and foreign-key checks. Temporary database copies were removed.

Original QA configuration/catalogs were restored; the configuration hash matched the original after both stops. Normal registry refresh returned 0. Our processes and listeners were absent, the shared queue was idle, and foreign services were unchanged. No new credential, security/network setting or paid route was used.

[Captured replies, snapshots, restart/state and cleanup receipt](dashboard-gateway.json) · [validation and original-log hashes](validation.json)

## Reproduce through the shipped entry point

Use an isolated existing QA profile and its authorized model route. Set primary and utility to the same actual model and `session.autoTitle: {refine:true, refineAfterMessages:2}`. Disable unrelated channel pollers. These commands use placeholders for private paths/endpoints and JSON containing the synthetic session key:

```sh
export OPENCLAW_STATE_DIR="$QA_STATE_DIR"
export OPENCLAW_CONFIG_PATH="$QA_STATE_DIR/openclaw.json"
export OPENCLAW_SERVICE_REPAIR_POLICY=external
"$NODE_BIN" "$CANDIDATE_ROOT/dist/index.js" gateway call sessions.patch \
  --params "$MODEL_SELECTION_JSON" --json --expect-url "$QA_GATEWAY_WS"
"$NODE_BIN" "$CANDIDATE_ROOT/dist/index.js" gateway call chat.send \
  --params "$TASK_JSON_WITH_UNIQUE_IDEMPOTENCY_KEY" --json --expect-url "$QA_GATEWAY_WS"
"$NODE_BIN" "$CANDIDATE_ROOT/dist/index.js" gateway call agent.wait \
  --params "$RETURNED_RUN_ID_AND_BOUNDED_WAIT_JSON" --json --expect-url "$QA_GATEWAY_WS"
"$NODE_BIN" "$CANDIDATE_ROOT/dist/index.js" gateway call sessions.describe \
  --params "$SESSION_KEY_JSON" --json --expect-url "$QA_GATEWAY_WS"
```

Model selection contains the key and `model:"local/gemma4:12b"`; it does not contain a title or generated-title provenance. Exact user messages and replies are in the receipt. Send the opening and first follow-up, stop normally, inspect the count in an offline copy, restart the same artifact/profile, then send the second follow-up and later turn. Inspect final `session_nodes.entry_json` through a disposable offline SQLite copy, never by modifying original state.

## Checks and evidence boundaries

All **76 existing naming tests and 46 existing new-session UI tests pass**, as do core/UI types, normal config-baseline generation/check, diff check and normal commit hooks. No test or optional consolidation was added for the merge. The naming regression uses actual routing and SQLite with stubbed external completion; the separate runtime above uses the actual model.

Normal `pnpm build` on the exact published SHA succeeded; build-info identifies 254aef0. [Hosted CI](https://github.com/openclaw/openclaw/actions/runs/39854253550) completed/success. At 21:30:59 UTC, full pagination verified **175 terminal CheckRuns: 129 success, 45 skipped, 1 neutral**, zero failure/cancellation/pending. All three separate statuses, including `openclaw/ci-gate`, were success. These are new-head results.

The [accepted 4044 proof](https://github.com/dankarization/openclaw/blob/407926a3a8d400bde2a18f86828096f7d97d7423/runtime-proof/pr174317/4044e1ff/README.md) and [F35 Telegram/upgrade packet](https://github.com/dankarization/openclaw/blob/edb1ff7cdaa0e58b83bb0a07d93cce8cd82abf72/runtime-proof/pr174317/f35cd67/README.md) retain their original SHA qualifications. The completed revision 7 [review](https://github.com/openclaw/openclaw/pull/174317#issuecomment-6218304774) accepted those packets. The merge preserves Telegram-specific collector/cache/account guards and ordinary mode-absent utility routing. This new dashboard restart run covers the updated shared session infrastructure; **no Telegram or stable-upgrade execution is relabelled as 254aef0**, and no Telegram matrix was repeated.

Maintainer approval of the opt-in naming policy/settings, creation-provenance RPC parameter and concurrency SDK export remains an external decision. This packet is technical evidence, not maintainer acceptance or a self-assigned label.
