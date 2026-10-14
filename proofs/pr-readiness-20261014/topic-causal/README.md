# PR166011: executed baseline failure and corrected-head success

Date:2026-10-14. Published head:a8b899d9a0039249bc01e362684f6c51c3de40c9, tree:b5db5fce544d8539b993c2cd2138aa8178c8c663.
Pinned unmodified production baseline:04f2e80e9a172c4decdc4c2c37fb261c78ea53fa.

## Method

Used the same complete dependency-ready source checkout, native repository test-projects runner, isolated synthetic SQLite state and exactly the same four test-file contents in both phases. No assertions, deadlines, mock results, dependency contracts or runtime guards were changed between phases. Baseline carries the candidate tests and its extension-database inventory registration; all nine introduced production files were restored to pinned main. Baseline tree:c7681e55a1eb17584757b2958cce2a1b3852ce00. Corrected execution tree equals published head tree.

Command in both phases:

```
node scripts/test-projects.mts extensions/telegram/src/bot-message-context.dm-session.test.ts extensions/telegram/src/topic-name-cache.test.ts src/auto-reply/reply/session.telegram-topic-title.test.ts src/config/sessions/session-accessor.topic-title.test.ts -- --maxWorkers=1
```

## Observed result

- Baseline exit1,292.3s wall including240.4s cold compiler preparation. The first native runtime-config regression executes the real recordInboundSessionMeta and reads persisted state. It fails: expected topicName Test4, received undefined. Native log: 'expected undefined to be Test 4'. The runner stops after the first failing shard: this proves one relevant baseline failure, not that all four files individually fail.
- Corrected head exit0,507.5s wall. All16cases pass across four files/three native shards: one committed-row/accessor case, two first-reply cases, thirteen Telegram context/topic-cache cases. The committed callback reads an already-persisted heading; updatedAt remains123. Other cases include existing title-only rename without model turn, no creation from title-only event, persisted reopen, account isolation and stale NewChat cache.
- Test-file SHA256 was checked identical before each phase. Exact corrected whole tree verified before execution. Borrowed source checkout restored to prior owned replay candidate after both phases.
- Current exact-head hosted [CI38487030416](https://github.com/openclaw/openclaw/actions/runs/38487030416) completed success.

Test hashes:

```
c2bb13d79eea34cf0ada71ca6b4f6290309aa1feb8511ba851aa9495a6a72d2d extensions/telegram/src/bot-message-context.dm-session.test.ts
15670dc847aa4cce18babbb8fb56e59bd91c177268369d90774fdb01558546ee extensions/telegram/src/topic-name-cache.test.ts
5d0a5804093fdf20989fde315cf296ece82a89edadac0a5adfb4b433a2437098 src/auto-reply/reply/session.telegram-topic-title.test.ts
78a0bd0b4fe2a846586fefbf6fa3cf47f9abc497cf99722f1632bbf628ec4caa src/config/sessions/session-accessor.topic-title.test.ts
```

## Remaining scope

This closes the specifically missing executed base-fail/head-pass regression comparison at the real committed-state boundary. It does not establish every added test fails without the patch, nor actual Telegram intake plus connected GUI refresh on this current-main source. Production package/configuration/Codex and existing sessions were not mutated for this check. Current authenticated browser acceptance is separate and incomplete.
