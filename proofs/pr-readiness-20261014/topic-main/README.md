# PR #166011 — current metadata-owner port, 2026-10-14

Published source: [71df13365048](https://github.com/dankarization/openclaw/commit/71df13365048a379c36ab1a5f2dee5bef99c8443); exact full tree `db992de73fcf97b4fe08c3f770d62263e5d7d981`.
Contributor parent: `9dc17035535d9256689425164f806e169f1e4621`; integrated pinned main: `04f2e80e9a172c4decdc4c2c37fb261c78ea53fa`. GitHub verified a common ancestry before fast-forward publication.

## Preserved behavior and ownership

Private Telegram topics reuse shared title projection. Existing manual GUI labels keep priority. Title-only service updates rename existing sessions without creating sessions or running the model. The old callback writer and separate rename loader/emitter are not restored.

The data path is PreparedSessionMetaPatch → pure metadata-projection → existing closed inbound-metadata writer → canonical committed-row publication. The notification test observes the already-persisted title from its listener and retains activity timestamps.

## Executed evidence

```text
node scripts/test-projects.mts extensions/telegram/src/bot-message-context.dm-session.test.ts extensions/telegram/src/topic-name-cache.test.ts src/auto-reply/reply/session.telegram-topic-title.test.ts src/config/sessions/session-accessor.topic-title.test.ts -- --maxWorkers=1
unit-fast: 1 passed
auto-reply: 2 passed
extension-database-workers: 13 passed
total: 16 passed, 4 files / 3 shards
exit: 0; wall: 447.0 seconds
```

Fourteen source blobs were rechecked after execution against the reviewed candidate. Full review and native-execution trees matched. Ordinary scoped Oxlint passed:14files,258rules,zero warnings/errors,26.6s. Formatting and whitespace checks passed.

Canonical independent P0–P2 review was scoped-clean,confidence0.72. Its bundle did not provide unchanged files, and that reviewer did not execute tests; native execution above is separate. No new dependency installation, external symlink/guard bypass, or changed native configuration/assertion was used.

## Still required

The native committed-row and ingress-context tests are not a connected Telegram→WebGUI observation of this exact port. Actual rename before/during/after a model turn, connected-list refresh without a further model request, and manual-label priority still need source-bound visuals/traces. Earlier user/Windows screenshots retain their older-build attribution.

Hosted CI is separately tracked on the new head. No production Gateway/configuration, bundled Codex, credentials, APK or QA server changed.
