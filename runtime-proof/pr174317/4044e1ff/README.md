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

Normal `pnpm build` on the exact published head passed in 7m 16.8s on Mac; generated build-info records `4044e1ff4caf1e54f49082f942294eac9d1b4971`. [Hosted CI](https://github.com/openclaw/openclaw/actions/runs/39843189938) is still pending at preparation of this packet; no hosted success is assumed. A non-checkout merge calculation against main `06eb109ab151a722db5f7643bd7ac25a3891d8ae` was clean; main was not merged for freshness.

## Real Telegram/model evidence and reuse boundary

[Immutable F35 runtime packet](https://github.com/dankarization/openclaw/blob/edb1ff7cdaa0e58b83bb0a07d93cce8cd82abf72/runtime-proof/pr174317/f35cd67/README.md) contains five real-Telegram/deterministic-provider scenarios plus a separate actual `gemma4:12b` run through the existing durable Ollama queue. The actual model gave four normal replies; count 1 survived a clean restart, the second follow-up changed `Alpine greenhouse advice` to `Alpine greenhouse design`, and a later turn did not rename it again. Offline state was count 2 / done true / renamed / no excerpts, integrity ok / zero foreign-key violations. Original QA configuration was restored exactly and our processes stopped.

Those are **F35 executions**, not new 4044 executions. This repair changes dashboard optional naming only. Telegram collector/owner, account fences, caches, persistence and migrations are unchanged. For ordinary Telegram naming, both old flags and new mode are absent: utility→primary attempts and deduplication remain the same. That source comparison supports reuse of the accepted runtime/upgrade evidence; the dashboard repair has its own actual-generator/SQLite regression above. No additional HP source or dependency environment is created and completed Telegram scenarios are not repeated for cosmetics.

[Machine-readable validation](validation.json) records exact SHAs, results, limitations and retained-log hashes. Maintainer naming-policy approval and acceptance remain separate; no labels are self-assigned.
