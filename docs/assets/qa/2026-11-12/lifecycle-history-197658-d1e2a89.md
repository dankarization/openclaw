# Lifecycle history fix: operator verification, November 12

Upstream fix: https://github.com/openclaw/openclaw/pull/197658
Merged upstream commit: `4d9f7821a48cf5ecd37d2ff6095a053bd67dbe04`.

Installed operator revision: `d1e2a89e4f37617f04c237a47f98b256e9ed5f9e`, OpenClaw 2026.11.3, Node 24.22.1.

## What was checked

The accepted fix moves lifecycle-owned `chat.history`, `chat.abort`, and `sessions.delete` dispatch outside the finished caller's plugin invocation scope. It retains the existing lifecycle/current-owner checks.

In an isolated checkout of our previously installed base `b2b6eb7adf73863f4b5254aada91e0cda8793dc4`, I applied only upstream's test change first:

```text
hosted-lifecycle-dispatch.test.ts
Before production fix: 2 failed, 8 passed
Both failures: promise rejected "Error: Plugin invocation scope is closed"
Affected cases: transferred cleanup/history reads, owner current=true and false

After accepted production fix: 10 passed
```

Command:

```sh
node scripts/test-projects.mts src/gateway/hosted-lifecycle-dispatch.test.ts --maxWorkers=1
```

The port is commit `f67db29fa5ec6a353eff4d4e2d723da0b9236752`. Five adjacent lifecycle/cancellation/subagent completion files then passed all 42 tests. Those lifecycle files are unchanged in the final operator revision.

The same final build also includes the Telegram atomic label-ownership repair published in #197334 as `b9463701958fce236fbca68fce860ff09a1b3ad8`. Its 27 naming, label-ownership and recovery tests passed in the combined checkout.

## Final build checks

- Core, extension and extension-test types passed.
- Targeted core and Telegram typed lint passed.
- Formatting, test-line accounting and line-cap checks passed.
- The canonical `pnpm build` passed.
- The final accounting-only commit reduced the operator allocation to its measured 331-line growth. It changed no tests or production code; unchanged-code static checks were retained from the preceding revision.

These are local integration results, not hosted CI for either public PR head.

## Installed Gateway

On November 12 at 15:38 UTC+4 the new process reported `ready=true`, `coreReady=true`, and no failing components. Its executable and source revision matched the qualified build.

A separate synthetic session then completed a real request through the running Gateway and its configured primary model. The expected marker was verified in assistant history, and only that test session was deleted. The saved configuration was unchanged, including `codexDynamicToolsLoading="searchable"`. This update required no data migration.

## Limits

The red/green check above is an automated regression test. Our live inference check is not a Telegram UI test or a local reproduction of the failing-child cron case. The maintainer's built-Gateway proof for that product flow is here:
https://github.com/openclaw/openclaw/pull/197658#issuecomment-6819439183

Earlier actual Telegram screenshots cover ordinary managed/native delegation and the first-message/reset naming workflow on the preceding integrated builds:
https://github.com/dankarization/openclaw/blob/aa2359af28ba66edb1e454053464215f3fa5e40d/docs/assets/qa/2026-11-12/telegram-delegation-e9ed479.md
https://github.com/dankarization/openclaw/blob/0f27d894bfa282460f9d5bdb1fbe7d4cdde95a59/docs/assets/qa/2026-11-12/telegram-naming-b2b6eb7.md

I am not claiming that this history-read fix resolves every rejected child tool, missing successful-child wake, or the separately observed cron timeout.
