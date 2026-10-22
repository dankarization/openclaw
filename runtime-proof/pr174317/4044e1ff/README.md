# Dashboard refinement repair — 4044e1ff

Published head: `4044e1ff4caf1e54f49082f942294eac9d1b4971`.
Native validated commit: `ff44e03c9cfaf4ce13dcf233a79c2e01f4f9f284`.
Exact shared tree: `f8153bfe8fe16317645e880e6cfb4a57176c7837`; seven changed blobs verified, ordinary atomic publication preserving F35 as parent, no force push.

## Defect and repair

The [reviewed P2](https://github.com/openclaw/openclaw/pull/174317#issuecomment-6218304774) consumed a dashboard refinement attempt without calling inference when utility resolved to primary. The actual generator and SQLite regression reproduced the intended failure: expected one completion call, observed zero. Its no-utility control passed.

Two coupled flags are replaced by one internal `speculative` / `refinement` mode. Speculation still excludes primary. Refinement uses the configured utility chain (including an explicitly selected primary), or primary when no utility exists; it does not append primary recovery after a failed utility chain. Both optional modes preserve the old title instead of inventing a random slug on failure. Ordinary initial naming remains unchanged.

## Current-head validation

All 76 affected tests passed: 40 dashboard-title, 14 refinement and 22 generator tests. The former flag-echo check is replaced by one three-case table observing actual routing/generation and real SQLite persistence: shared utility/primary success, no utility success, and distinct utility failure. It reloads the persisted name and done state, then asserts no second inference. Only external completion output is stubbed. Production shrinks by 22 net lines; tests/classification grow by 49. No new test framework or production test seam is added.

```sh
OPENCLAW_VITEST_RUNTIME=node pnpm test \
  src/auto-reply/reply/conversation-label-generator.test.ts \
  src/gateway/dashboard-session-title.test.ts \
  src/gateway/dashboard-session-title-refinement.test.ts --maxWorkers=1
pnpm tsgo:core
pnpm tsgo:core:test --ci-graphs-json '["core-test-gateway-root","core-test-messaging"]'
```

Node 24.22.1 and pnpm 12.15.0 were used. Core types, both owning test-type graphs (180.0s / 99.2s), normal scoped core lint, formatting and commit hooks pass. Automatic type-graph selection separately failed its root-budget guard (727/735 roots versus 720) and then selected unrelated graphs; that log is retained and is not called a pass. The two owning canonical graphs were checked independently without changing any guard. A sandbox-only SQLite lease-visibility failure was resolved by running the exact test command with normal host process visibility; no product assertion was weakened.

An independent bounded read-only review found no confirmed findings. This was narrative subagent assessment, not helper-isolated machine certification.

Normal `pnpm build` on the exact published head passed in 7m 16.8s on Mac; generated build-info records `4044e1ff4caf1e54f49082f942294eac9d1b4971`. [Hosted CI](https://github.com/openclaw/openclaw/actions/runs/39843189938) completed successfully. Full pagination returned 186 CheckRuns: 132 success, 53 skipped, 1 neutral, zero failure/cancellation/pending. All 26 workflows were terminal (20 success, 6 skipped). All three separate commit statuses, including `openclaw/ci-gate`, were success. These results belong to the published 4044 head; they are not F35 statuses. A non-checkout merge calculation against main `06eb109ab151a722db5f7643bd7ac25a3891d8ae` was clean; main was not merged for freshness.

## Real current-head dashboard Gateway proof

The exact published 4044 artifact was applied **in place** to the existing stopped Linux QA checkout. Full verification covered 58,610 source files and 40,673 runtime files across 26 roots, including modes, membership and deletions: zero mismatches. The 33,893,520-byte delivery archive was verified and subsequently removed; its Mac original and the verified 33,894,650-byte affected-files rollback backup are retained. No full checkout, dependency installation or new environment was created.

The test ran the shipped `dist/index.js` Gateway and the shipped CLI's `gateway call` route, not an imported naming function. The existing real `local/gemma4:12b` was both the selected primary and utility model, served through the authorized durable Ollama queue. There was **no completion stub**, new credential, model download or direct backend request. Telegram was disabled only in this temporary QA configuration; no Telegram scenario was repeated.

| Gateway snapshot UTC | Ordinary task | Client-visible displayName | Result |
| --- | --- | --- | --- |
| 20:26:47.987 | Opening: plan a team meeting | Planning a team meeting | Real model reply; generated initial title. |
| 20:27:40.719 | First follow-up: PostgreSQL backup and point-in-time restore rehearsal | Planning a team meeting | Real model reply; no early rename. |
| 20:28:20.714 | Second follow-up: WAL replay and timed PostgreSQL restore | PostgreSQL disaster recovery rehearsal planning | Real model reply; threshold 2 refined the title. |
| 20:29:06.707 | Later turn: confirm the backup/WAL validation plan | PostgreSQL disaster recovery rehearsal planning | Real model reply; no repeat; no active run remained. |

The Gateway was stopped normally at 20:29:49 UTC (exit 0). Disposable offline SQLite backups passed integrity and foreign-key checks. The actual persisted session had count **2**, `refinementDone=true`, the refined `displayName`/generated name, and no retained recent messages. This observes the spent state after the extra turn; no title was injected or patched manually. The original QA configuration was restored exactly, model catalogs restored, normal registry refresh exited 0, and our listeners were released. Shared services were unchanged.

[Redacted captured Gateway output and offline receipt](dashboard-gateway.json) include all four actual replies, model/provider identity, title snapshots, state checks, cleanup and private-log hashes. Raw identities, paths and endpoints are excluded.

Reproduction uses an isolated existing QA Gateway with its authorized real model configured as both primary and utility and `session.autoTitle: {refine:true, refineAfterMessages:2}`. Through the normal `sessions.patch` model setting, select `local/gemma4:12b` for a synthetic dashboard key. Then use the shipped CLI:

```sh
export OPENCLAW_STATE_DIR="$QA_STATE_DIR"
export OPENCLAW_CONFIG_PATH="$QA_STATE_DIR/openclaw.json"
export OPENCLAW_SERVICE_REPAIR_POLICY=external
node "$CANDIDATE_ROOT/dist/index.js" gateway call chat.send \
  --params "$TASK_JSON_WITH_SESSION_KEY_MESSAGE_AND_UNIQUE_IDEMPOTENCY_KEY" \
  --json --expect-url "$QA_GATEWAY_WS"
node "$CANDIDATE_ROOT/dist/index.js" gateway call agent.wait \
  --params "$RETURNED_RUN_ID_AND_BOUNDED_WAIT_JSON" --json --expect-url "$QA_GATEWAY_WS"
node "$CANDIDATE_ROOT/dist/index.js" gateway call sessions.describe \
  --params "$SESSION_KEY_JSON" --json --expect-url "$QA_GATEWAY_WS"
```

Send the opening task, two increasingly specific PostgreSQL follow-ups and one later turn; observe the title after each completed run. Inspect a disposable SQLite copy after normal shutdown, then restore the QA configuration/catalogs.

Setup exclusions are explicit: an optional idempotent `sessions.create` request was rejected before creation because it lacked a principal/device identity and was not retried; ordinary `chat.send` created the synthetic session. An initial opening inherited the old implicit OpenAI default and failed authentication; it is excluded. Standard `sessions.patch` selected the already authorized local model before the four successful turns. No access or authentication policy was changed.

## Real Telegram/model evidence and reuse boundary

[Immutable F35 runtime packet](https://github.com/dankarization/openclaw/blob/edb1ff7cdaa0e58b83bb0a07d93cce8cd82abf72/runtime-proof/pr174317/f35cd67/README.md) contains five real-Telegram/deterministic-provider scenarios plus a separate actual `gemma4:12b` run through the existing durable Ollama queue. The actual model gave four normal replies; count 1 survived a clean restart, the second follow-up changed `Alpine greenhouse advice` to `Alpine greenhouse design`, and a later turn did not rename it again. Offline state was count 2 / done true / renamed / no excerpts, integrity ok / zero foreign-key violations. Original QA configuration was restored exactly and our processes stopped.

Those are **F35 executions**, not new 4044 executions. This repair changes dashboard optional naming only. Telegram collector/owner, account fences, caches, persistence and migrations are unchanged. For ordinary Telegram naming, both old flags and new mode are absent: utility→primary attempts and deduplication remain the same. That source comparison supports reuse of the accepted runtime/upgrade evidence; the dashboard repair has its own actual-generator/SQLite regression above. The same HP checkout is updated in place for the current-head dashboard proof above; no additional full source/dependency environment is created, and the accepted Telegram scenarios are not repeated.

[Machine-readable validation](validation.json) records exact SHAs, results, limitations and retained-log hashes. Maintainer naming-policy approval and acceptance remain separate; no labels are self-assigned.
