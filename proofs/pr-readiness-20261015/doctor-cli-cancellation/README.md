# #166000 — packaged CLI finalization cancellation and native recovery

## Result and exact authority

**PASS for actual CLI/Doctor cancellation and managed-Gateway recovery. Mutable-writer cancellation remains INCONCLUSIVE.**

Executed installed canonical package `e7ad0a972bbab870a047c00c4e9d1675cca5c8fe`, after the [official stock-driver upgrade](../doctor-published-upgrade/README.md). Current fe684 differs only by deletion of the requested helper-only test; all runtime/build/dependency bytes are identical. No source, deadline guard, fake timer, command owner or service adapter was substituted.

## Actual observations

| Declared public CLI budget / OS input | Actual native outcome | Scope |
|---|---|---|
| `update repair --yes --json --timeout 45`; real separate agent DB BEGIN IMMEDIATE held60s | Actual managed Gateway stop, fresh pre-plugin Doctor, native “finalization timed out in doctor after45000ms / Cancellation settled before recovery”, native restoration and verification; exit1; durable finished/failed reason finalization-timeout; readiness200; no surviving command-group process | Actual CLI finalization cancellation/restoration. **Not** attributed to an admitted agent writer |
| `--timeout 90`; declared agent DB contention120s | Native Doctor and repair completed; exit0; durable finished/succeeded; restored/readiness200; original session ID/label/Medium retained; no surviving command-group process | Successful longer-budget repair control. **Not** writer cancellation |

An independent outer300s safety owner never timed out or forced a kill. Normal phase cancellation and native restoration were allowed to settle. The longer control followed a measured trace in which the45s run had not reached a visible agent write; it is retained as a separate result, with its actual outcome.

## Reproduction boundary

The commands were the unchanged installed executable with explicit global `--profile pr166000-proof`, not a candidate source helper in place of the CLI.

A separate bounded Python SQLite connection held `BEGIN IMMEDIATE` on **only** the QA agent database and later rolled back without payload writes. It did not lock the shared updater ledger. Ordinary historical cache inputs were created via the native normal agent DB lease/scoped transaction while the own Gateway was inactive. Startup and input preparation are distinct from the native restoration being tested.

The real CLI ran under:
```bash
strace -f -ttt -yy -s64 \
  -e trace=execve,clone,clone3,fcntl,pwrite64,fdatasync,fsync,kill,wait4 \
  -o PRIVATE_TRACE \
  "$CLI" --profile pr166000-proof update repair --yes --json --timeout 45
```

Read native `update status --json`, bounded original `sessions.list`, genuine service state/readiness, and join the command and lock holder before classifying the result. The90s control used its own declared120s holder. No working Gateway or production configuration was involved.

## What is not proved

The [allowlisted receipt](receipt.json) reports **zero attributable agent DB write-lock attempts / payload writes** in both traces. Read locks and agent-path lines were observed. A held SQLite lock, dispatched worker or later disappearance of retired rows does not prove acceptance/cancellation of that same mutable writer.

Two synthetic retired rows and one unrelated control were initially inserted. The native normal reader after the45s run observed only the unrelated control. There is no reliable causal attribution of that transition to cancellation of an admitted writer; the90s control is explicitly **not** presented as retaining the original two rows. Initial source-helper profile/loader/lease-choice refusals occurred before fixture payload insertion and are excluded from acceptance.

The native accepted-request custody flag is SharedArrayBuffer state, and no stable public admission barrier was used. These observations therefore close actual Doctor CLI cancellation, joined cleanup, durable terminal failure and native restoration/readiness; they do not manufacture the remaining writer proof.

## Acceptance question for maintainers

The production patch carries an existing Doctor service-inspection deadline and preserves the existing writer/settlement owners. The immutable evidence now contains successful official-driver upgrade, actual CLI expiry before stop, admitted native stop crossing expiry, actual fresh Doctor cancellation and native restoration, plus the existing source-bound writer-owner regressions.

Is that composition sufficient for this service-deadline patch? If an additional **same admitted SQLite writer cancelled by this public CLI** run is mandatory, which supported repair input and existing diagnostic/admission barrier should be used to identify that writer without adding private hooks, weakening ownership guards or replacing the native owner?

Raw traces/configs and credential/private endpoint material remain private; exports include their hashes and only allowlisted observations. Native advisories retained by the original update are disclosed in the linked upgrade report.
