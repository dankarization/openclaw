# #166000: real native service-adapter process proof

## Result and source identity

All native02 cells passed, with actual wall time, child processes, the native operation-lock, native systemd discovery/runtime readers, and native stop/start command execution.

- Published candidate: **`6bb9c0749da3f2232f72da7837f314ef2d35bf70`**, complete tree **`9e47e8c86e5b86acc02787fd3a3f485bc1ea411a`**.
- Executed native commit: `6d41c150c2e6d1ebac13b9ec776f5b8a06b6d977`, the **identical complete tree**. The native commit and Git Data published commit have distinct commit metadata; neither is silently relabelled.
- Clean-main control: `c05c277d04326b53858f85e2ea83c16b4756e83b`, tree `bdea78650b3dc0031d0043716191f0c82521ef00`.
- Main execution: 2026-10-14T17:44:54.997Z → 2026-10-14T17:45:15.052Z.
- Candidate execution: 2026-10-14T18:12:42.502Z → 2026-10-14T18:13:08.037Z.
- Both proof processes exited 0. Their own service processes and unit files were removed. No production service, configuration, source, credential, or other unit changed.
- Node 24.21.0; candidate reused frozen dependencies only after byte-for-byte package.json and pnpm-lock.yaml comparison with the existing matching QA checkout. No package or product change was made.

## Observations

| Cell | Real setup | Actual result |
| --- | --- | --- |
| Baseline expiry control | A real child retains native operation-lock custody for 1,500 ms; admitted absolute allowance is 500 ms | Main never invokes the supplied pre-effect guard and actually stops the own QA service after expiry; native mutation notification and real SIGTERM observed |
| Candidate expiry | Same real custody and 500 ms allowance | Native final pre-effect guard runs after expiry and throws the native Doctor deadline error; **0 mutations**, original service PID remains, fixture HTTP 200 |
| Candidate admitted settlement | Native guard admits stop within a 3,000 ms allowance; actual systemd ExecStop child sleeps 6 s | Native stop settles after **6,030 ms**, reports one mutation, and native restoration under retained operation custody starts a new service PID; fixture HTTP 200 |
| Candidate omitted deadline | The same native deadline resolver receives undefined | Native stop settles after **6,029 ms**, one mutation, native restoration/new PID/fixture HTTP 200 |

Receipts: [main](native02-main/receipt.sanitized.json), [candidate](native02-candidate/receipt.sanitized.json). They include absolute wall-clock timestamps, actual child ready/SIGTERM events, custody-holder PID, mutation counts, source trees and cleanup outcomes. A baseline pass means the expected old incorrect dispatch was observed.

## What actually executes

The [QA harness](native-doctor-adapter.mjs) creates a uniquely named, task-owned user-systemd unit running a small real HTTP child. The unit's real `ExecStop=/usr/bin/sleep 6` makes native command settlement outlive the admitted deadline. It is explicitly **not an OpenClaw Gateway**.

Native owners are loaded directly from the selected source with its TypeScript aliases:

- `readSystemdServiceExecStart` and `readSystemdServiceRuntime` inspect the real own unit.
- A separate real Node process obtains `withGatewayServiceOperationLock`; the caller genuinely waits for the same native lock to be released.
- `stopSystemdService` / `startSystemdService` perform real systemctl calls; no fake systemctl, transport, discovery, clock or command owner is installed.
- The supplied `beforeEffect` callback calls the candidate's real `resolveRemainingDoctorServiceInspectionTimeoutMs`. The same callback contract is supplied to both adapter revisions; baseline ignores it. This is an adapter comparison, **not an execution of baseline Doctor CLI**.
- After an admitted stop, restoration retains current operation custody but intentionally receives no expired work-deadline guard. The native stop's mutation callback is observed; this is **not a durable updater-ledger receipt**.

Fixture setup creates the own unit only with exclusive file creation, refuses port conflicts, and verifies the exact unit-file bytes before mutations. Cleanup verifies the actual FragmentPath, stops only the own named unit, unlinks only its matching file, and reloads the user manager. Units are not enabled at boot. The main control uses its own separate unit and port.

The public harness replaces only the private absolute QA task-root literal with an explicit placeholder. The executed original remains in the private QA workspace. No credential is present in either version.

## Reproduce in an authorized isolated user-systemd environment

```sh
node native-doctor-adapter.mjs --repo MAIN_CHECKOUT \
  --head c05c277d04326b53858f85e2ea83c16b4756e83b --kind main --run native02
node native-doctor-adapter.mjs --repo TREE_IDENTICAL_CANDIDATE_CHECKOUT \
  --head 6d41c150c2e6d1ebac13b9ec776f5b8a06b6d977 --kind candidate --run native02
```

Set the public root placeholder to your own task root; keep the candidate source at `doctor-process-proof/repo` because both controls deliberately use the same real deadline-resolver callback. Each run requires a fresh name and refuses profile reuse/reset. Native systemd must be functional; no alternate service manager is fabricated.

The earlier native01 control reproduced the expected adapter behavior but failed cleanup because an unnecessary `reset-failed` targeted a service already unloaded after stop. That attempt is excluded. Its verified inactive own file was removed; native02 removes the unnecessary reset and completes all cleanup.

## Scope: partial native proof, not published-driver acceptance

This proves the introduced native-adapter pre-effect admission boundary, actual post-effect service-command settlement, custody-retained native restoration, and an omitted-deadline adapter call.

It does **not** execute Doctor CLI, `UpdateFinalizationLifecycle`, automatic deadline cancellation, a mutable database writer, a managed Gateway, Gateway `/readyz`, candidate package adoption or an unmodified published update driver. The fixture's HTTP 200 is its own readiness only; **no Gateway readiness is claimed**. It does not establish full installed-settings/data upgrade compatibility.

The review's exact-head canonical-package / published-driver expiry, writer-settlement, restoration/readiness and omitted-deadline acceptance remains open. No proof-sufficient or merge-ready status is self-assigned.
