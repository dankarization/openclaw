# PR #162565 — test provenance follow-up, 2026-10-14

Source: [45bcbf83237d](https://github.com/dankarization/openclaw/commit/45bcbf83237d358441fe700a02daed239015b641); full tree `3dae2559923d401b444e7b6c9b9bf250a0318ab6`; parent `d1cc22726002daf2a4ebd816126a48db6c0f7542`.

ClawSweeper identified that merged commit8155863d deliberately removed the redundant metadata-forwarding mock. This revision removes that restored case and the duplicate mock hash-identity assertions. The existing real SQLite boundary now starts with a group-prefixed destination, then processes ordinary-topic, topicless and direct-topic aliases; independent messages/accounts/chats with identical text remain covered there. Distinct required-durability and nonfatal-failure checks remain.

Only two test files changed. Production, storage, delivery policy and dependencies are unchanged from the parent.

The unchanged native runner passed **7/7 affected cases**:2real-SQLite/fake-adapter and5unit cases, exit0,113.9seconds. Formatting, ordinary258-rule scoped lint and whitespace checks passed. Canonical independent P0–P2 review was scoped-clean (confidence0.78). Full sparse review and execution trees matched.

The [43-case/green-CI main repair](../replay-main/README.md) belongs to parentd1cc22726002, including34unchanged Telegram-context cases and the two subsequently removed mocked cases. It is not relabeled as a new-head43-case run. New-head hosted CI is separately tracked in the PR.

Real Telegram replay/restart, independent identical-message output and the maintainer durability/retention decision remain pending. No production Gateway or runtime configuration changed.
