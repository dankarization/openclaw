# Utility fallback authority proof — openclaw#173906

Deterministic real-behavior evidence for the remaining ClawSweeper before-merge item:

> **Requester revocation between attempts** remains explicitly unrun: show rejection before
> subsequent provider I/O or CLI launch. (durable review, reviewed_at 2026-10-07T10:07:32Z)

Exact candidate HEAD: `6fa9f1cf0132f3f6d5a9a6778a651488a421ebfc`.

## What this drives

The **production utility owner** `runUtilityCompletion` -> `runWithModelFallback`
(`src/agents/utility-completion.ts`, `src/agents/model-fallback-runner.ts`) with a real
`AdmittedRunOperatorAuthority` built by the host-only `createAdmittedRunOperatorAuthority`
factory, and a recording HTTP endpoint that stands in for provider transport. Every dispatch is
recorded twice: at the owner boundary (`onAttempt`) and as a real network hit.

Run:

```bash
NO_PROXY=127.0.0.1,localhost \
PROOF_HEAD=6fa9f1cf0132f3f6d5a9a6778a651488a421ebfc \
node --import ./scripts/tsx.mjs proofs/utility-fallback-173906/authority-proof.mts
```

## Scenarios and result (8/8 pass)

| Scenario | Assertion                                                        | Result |
| -------- | ---------------------------------------------------------------- | ------ |
| S1       | Candidate denied by operator model policy is never dispatched    | PASS   |
| S1       | Denied candidate produces zero provider I/O (hits == dispatches) | PASS   |
| S1       | Allowed backup is dispatched                                     | PASS   |
| S1       | Owner `onAttempt` never observes the denied candidate            | PASS   |
| S2       | Primary dispatched exactly once                                  | PASS   |
| S2       | After requester revocation, backup is **not** dispatched         | PASS   |
| S2       | Exactly one provider hit total (no second I/O)                   | PASS   |
| S2       | Chain aborts with the revocation error                           | PASS   |

The abort is raised by `operatorAuthority.assertCurrent()` at the top of the next candidate
iteration — before `runFallbackAttempt` — so neither provider I/O nor CLI launch occurs for the
revoked requester.

Production log lines emitted by the runner during the run:

```
[model-fallback/decision] decision=candidate_failed requested=denied/primary candidate=allowed/backup reason=timeout next=none
[model-fallback/decision] decision=candidate_failed requested=denied/primary candidate=denied/primary reason=timeout next=allowed/backup
```

S2 ends with `Error: requester authority revoked` and no second `[model-fallback/decision]` line.

## v2026.10.4 upgrade data-compat

Addresses the second remaining before-merge item: _"Add data-model compatibility proof — existing
stored data may not work after upgrade."_

`openclaw@2026.10.4` (commit `383c124`) was installed in isolation and used to author a profile
config with the **string** `utilityModel` form at both default and per-agent scope, plus its normal
state database. The candidate config owner then loaded that profile:

| Check                                               | Result                                    |
| --------------------------------------------------- | ----------------------------------------- |
| `openclaw@2026.10.4` validates the authored config  | valid                                     |
| Candidate `readConfigFileSnapshot` on the same file | `exists=true`, `valid=true`               |
| Config file sha256 before == after                  | unchanged (`440771ce…95b1`)               |
| `meta.migrations.utilityModelSeparation`            | absent (no forced migration)              |
| default-scope `utilityModel`                        | `explicit openai/gpt-5.4-mini`            |
| per-agent `utilityModel`                            | `explicit openai/gpt-5.4-mini`            |
| 10.4 state DB opened under candidate runtime        | `PRAGMA integrity_check = ok`, 101 tables |

Run:

```bash
OPENCLAW_STATE_DIR=/home/dankar/.openclaw-upgrade-proof-104 \
PROOF_HEAD=6fa9f1cf0132f3f6d5a9a6778a651488a421ebfc \
node --import ./scripts/tsx.mjs proofs/utility-fallback-173906/upgrade-proof.mts
```

Scope note: this proves the 10.4-authored config and state load unchanged under the candidate
config/state owners; it is not a packaged install-swap upgrade.

## Privacy

The recording endpoint is a loopback mock; no real provider, key, IP, phone number, or non-public
endpoint is contacted or published.
