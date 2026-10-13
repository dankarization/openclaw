# PR166011: notification listener CI correction

Date: 2026-10-14. Public head: a8b899d9a0039249bc01e362684f6c51c3de40c9. Tree:b5db5fce544d8539b993c2cd2138aa8178c8c663. Parent:71df13365048a379c36ab1a5f2dee5bef99c8443.

## Observed failure and correction

Parent CI run38485062587/job115597433448 reported TS2345 in src/config/sessions/session-accessor.topic-title.test.ts: a callback accepting only {sessionKey?:string} cannot accept the existing row/all SessionRowNotification union.

The two-line test-only correction derives the callback contract from Parameters<typeof sessionChanges.subscribe>[0] and narrows with the existing sessionKey discriminant before reading it. Production source and assertions are unchanged. No casts, suppressions, new notification exports or validation bypasses.

## Executed checks, exact corrected tree

- Native node scripts/run-tsgo.mts -p test/tsconfig/tsconfig.core.test.agents-sessions.json: exit0,180.5 seconds.
- Native node scripts/test-projects.mts src/config/sessions/session-accessor.topic-title.test.ts -- --maxWorkers=1: exit0,1 passed,61.1 seconds. Existing physical complete dependencies; normal compile/containment guards enabled.
- oxfmt check: passed60ms. Ordinary oxlint:258rules,0warnings,0errors,1.3s. git diff --check:passed.
- Independent focused review: no supported findings; checked canonical notification owner and exact candidate tree. Reviewer did not execute tests; separate execution above.
- Full execution tree matched publication tree before and after checks. Borrowed replay worktree restored to its previously saved tree afterwards; topic source candidate retained.

## Scope

This supplies CI-red to corrected-native-green type evidence and the affected committed-row regression. Parent's sixteen native cases remain parent-attributed. New-head hosted CI is pending. It is not actual connected Telegram intake/title refresh proof, nor base-fail/head-pass evidence of the whole feature. No production restart, credentials, configuration, native Codex dependency or APK change.

[Parent feature proof](https://github.com/dankarization/openclaw/blob/718df075f265925d767bb30ddda5ec659197aa61/proofs/pr-readiness-20261014/topic-main/README.md)
