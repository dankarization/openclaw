# PR #162565 — current-main replay verification, 2026-10-14

Source: [d1cc22726002](https://github.com/dankarization/openclaw/commit/d1cc22726002daf2a4ebd816126a48db6c0f7542); full source tree `86f1fcfc824c3a1a7443771db87adc8c77252fa1`.
Pinned main: `04f2e80e9a172c4decdc4c2c37fb261c78ea53fa`. All six introduced file blobs were rechecked after execution against the published candidate; each matched. The production echo owner remains blob `1e55cc1ec49ca35a2063be470ba6b64b921c70e9`.

## Executed proof

The repository-native runner completed with exit 0 in 512.8 seconds:

```text
node scripts/test-projects.mts src/media-understanding/echo-transcript.test.ts src/media-understanding/echo-transcript.integration.test.ts extensions/telegram/src/bot-message-context.body.test.ts -- --maxWorkers=1
infra: 2 passed
media-understanding: 7 passed
extension-database-workers: 34 passed
total: 43 passed, 3 files/shards
```

The integration exercises real temporary SQLite and the maintained fake channel adapter. Concurrent/completed replay shares the durable claim; different messages/accounts/chats with identical transcript text remain independent. Unit coverage retains main's literal-dollar formatting case and the PR's identity/durability/metadata cases. Native Telegram context tests retain current-main preparation/admission behavior.

Six-file formatting and ordinary 258-rule Oxlint passed with zero warnings/errors (40.7 seconds). Canonical independent P0–P2 source review was scoped-clean, confidence 0.76; repository inspection tools were unavailable to that reviewer, so this is supplied-diff review, not live or runtime evidence. Full native-sparse review and execution source trees matched.

## Failed and unconfirmed work

The first focused invocation exited 2 before assertions because an operator-supplied TMPDIR did not exist, after 889.3 seconds of cold preparation. Only that directory was corrected; test bodies/assertions and native runner configuration were unchanged for the successful invocation.

Type-aware lint preparation exceeded 240 seconds; gate-planner dry-run exceeded 120 seconds. Neither is reported as passed. Hosted CI on this new head remains separately tracked in the PR.

## Still required

No actual Telegram same-source replay/restart observation is claimed. Fake-adapter proof does not replace it. Maintainer acceptance of required durable admission and the 24-hour/2,000-entry receipt bounds is separate. No new QA server or credentials were created. The serving stable 2026.10.2 Gateway and its native Codex dependency were not changed by this main-targeted branch repair.

See [the earlier stable 10.2 preservation proof](../replay-10.2/README.md) and the PR for previously accepted separate-process queue preservation.
