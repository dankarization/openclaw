# PR #164857 — closed schema and append reorder follow-up, 2026-10-14

Published source: [5c470bab52f3](https://github.com/dankarization/openclaw/commit/5c470bab52f3ec5f9cfb9cf9c260227e76989864); full tree `bbf628378d96eaf51fc4c035be4a398a78226afb`, verified independently against GitHub after publication. Fast-forward parent: `ef8510cc6301442999ff2c99528f1280fa4aaced`.

The new review's two P2 findings are repaired: sidebar order normalization uses the complete live catalog inside the transaction, and append capability is an optional Boolean in the closed list-result schema. Kotlin/Swift protocol outputs were regenerated. The reorder regression submits empty additions; the obsolete collapsed-sidebar test was removed.

## Executed evidence

- Schema causal negative control: **1 failed / 1 passed**.
- Corrected schema: **2 passed**.
- Maintained protocol check: **passed**.
- PlayDebug Kotlin recompilation, **25 SidebarShellLogic tests** (zero failures/errors/skips) and ktlint: **passed**,130.04s.
- Oxfmt and whitespace checks: passed.
- Canonical independent P0–P2 review: scoped-clean,confidence0.82; public source tree matches the native candidate.

The worker-backed catalog test was stopped during cold compilation after181.67s, before assertions. Its ordering regression is not reported as executed or base-failing. Hosted CI remains separately tracked on this head; current main conflicts and connected authority/concurrency/pagination/migration acceptance remain. Maintainer product/security decisions are still needed.

The [earlier65-case report](../android-groups/README.md) belongs to the parent generation and retains its formatting/source attribution. No APK, production change, dependency installation or QA server was added.
