# PR #162565 — executed causal replay regression, 14 October 2026

## Source authority

Candidate head: `45bcbf83237d358441fe700a02daed239015b641`, complete candidate tree `3dae2559923d401b444e7b6c9b9bf250a0318ab6`.
Baseline production: pinned main `04f2e80e9a172c4decdc4c2c37fb261c78ea53fa`.
The same candidate integration test and test-routing inventory ran against both. Only the two introduced production files were replaced with their pinned-main contents for baseline; every other source/test/config file remained identical.

Test SHA256: `71d5e3dbe10bd9fd3dbfc1e3f9183fd78f30bd0b7b78888e69ce7d94b05ec2ee`.

Command:
```sh
node scripts/test-projects.mts src/media-understanding/echo-transcript.integration.test.ts -- --maxWorkers=1
```

## Observed result

| Phase | Result | Relevant observation | Wall time |
|---|---|---|---|
| Baseline | exit1; 1 failed,1 passed | “sends once for concurrent processing and a replay after completion” fails: expected one adapter call, received **2** | 161.1s |
| Candidate | exit0; 2 passed | Same concurrent/completed-replay case passes; separate messages/accounts/chats with identical transcript case passes |155.7s |

The baseline failure is an actual behavioral assertion, not missing imports, fixture setup, changed expectations or an observation timeout. The separate-identity positive control passes even on baseline. Candidate files and staging were restored afterward and the full candidate tree reverified.

## Evidence

- [Receipt](replay-causal-20261014-result.json)
- [Baseline native log](replay-causal-base-20261014.log)
- [Candidate native log](replay-causal-head-20261014.log)

## Scope

Both executions use real temporary SQLite and a **fake Telegram delivery adapter**. This closes the missing base-failing regression evidence. It does **not** prove real Telegram transport, same-source replay across an actual Gateway restart, or maintainer acceptance of required durable admission /24h/2000-receipt retention. No production Gateway, configuration, database or Codex change. No new server or dependency installation.
