# PR #164857 — Android findings repair, 2026-10-14

Published source: [ef8510cc63014](https://github.com/dankarization/openclaw/commit/ef8510cc6301442999ff2c99528f1280fa4aaced); full tree `9d7b5a6f104e52e1284560d4cf83bcfce6ebfbe8`, independently reread from GitHub after publication.

Three discrete findings were repaired: negotiate append support on the originating physical Gateway connection; preserve the supported replace contract on released Gateways; append after surviving persisted positions; and submit only intended additions so old names are not recreated by unrelated reorder/create operations.

PlayDebug Kotlin compilation and **65 focused unit tests passed** (6 SessionGroups, 41 ChatControllerCommandControls, 18 MainViewModel), with zero failures, errors or skips in 8m36s. This includes the old/new RPC-contract regression. These results precede a formatter-only layout cleanup in two test blocks; assertions were unchanged. Final app ktlint passed in 1m01s; TypeScript formatting and diff check passed.

Canonical independent P0–P2 review found no actionable finding on the pre-format tree `357120ceea08cc972a0d02bd3a4e8a27df5b4c78` (confidence 0.72). Full sparse-review and execution candidate trees were verified identical. This is scoped source review, not final-head connected acceptance.

The focused Gateway tests were stopped during cold worker compilation after approximately 17 minutes without reaching assertions. No passing Gateway result is claimed. Current-head CI, main conflicts, connected authority/concurrency/pagination/migration scenarios and maintainer product/security decisions remain outstanding. Earlier connected screenshots belong to their stated older heads.

No APK was installed, no production Gateway changed, and no QA server created. See the PR body for historical proof and exact remaining scenarios.
