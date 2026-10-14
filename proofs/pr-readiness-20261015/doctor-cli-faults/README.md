# #166000 — actual CLI Doctor expiry, admitted native stop and restoration

## Exact implementation and environment

These cells ran the **installed canonical e7ad0a972bbab870a047c00c4e9d1675cca5c8fe** package after the [actual published-driver upgrade](../doctor-published-upgrade/README.md). Current PR fe684426bd861c80bdce4d0c5df35a6f8de405ed differs only by the requested helper-test deletion; all runtime/build/dependency bytes remain identical.

Native profile `pr166000-proof`, genuine per-user systemd-managed OpenClaw Gateway. No fake systemctl, service wrapper, clock, Doctor callback, source guard change or private command. Only the task-owned QA service received the declared temporary drop-ins below. They were removed in the observer's finally block; product code was unchanged.

## Results

| Cell | Actual observation | Classification |
|---|---|---|
| Separate native custody holder, 60s; real CLI repair timeout15s | Actual Doctor phase deferred because native file-lock admission timed out; original PID unchanged, no own-unit journal stop events, readiness200, holder and command joined | Native exclusion/refusal evidence. **Not** by itself the explicit deadline-check proof |
| Native CLI repair timeout10s, declared ExecStop20s | Native Doctor inspection reported deadline expired **before native stop**; original PID unchanged, readiness200, native ledger finished/skipped, no unjoined child | **PASS: actual CLI expiry rejects late stop admission** |
| Native CLI repair timeout45s, declared ExecStop60s | Native stop entered at 1792014805223; phase configured deadline 1792014828169; inactive observed 1792014865189; native restoration started new Gateway, readiness200, no unjoined child | **PASS: an already admitted native service effect settles after expiry and native owner restores Gateway** |

The 10s and 45s inputs are separate scenarios, both retained. The former rejected before stop after real service inspection consumed the budget; the latter deliberately supplied enough initial allowance to admit stop while its declared stop effect lasted beyond that allowance. No product deadline was enlarged or weakened.

## Reproduction

Use the verified installed candidate and the native profile/service from the linked successful upgrade. Before each cell retain native `sessions.list`, service identity/PID and readiness.

For the early case add **only to that own QA unit**:
```ini
[Service]
ExecStop=
ExecStop=/usr/bin/sleep 20
TimeoutStopSec=45
```

Reload the own user-manager definition, confirm actual ExecStop, and invoke the unchanged CLI:
```bash
"$CLI" --profile pr166000-proof update repair --yes --json --timeout 10
```

Remove exactly the owned drop-in and daemon-reload in finally. Capture native phase logs, real service state transitions, native update status and readiness. Do not manually start the Gateway to manufacture restoration.

For admitted-stop use the separate declared drop-in `sleep 60 / TimeoutStopSec=90` and the public CLI `--timeout 45`. The actual native service transitions and log phrases “Stopped the managed Gateway for Doctor repair”, “Restarted systemd service”, “Gateway restarted and verified after Doctor repair” attest the native restoration; the observer did not start it during this fault.

The custody-input cell used the unchanged `withGatewayServiceOperationLock` source owner in a separate bounded holder process, with the same canonical profile identity. It does not substitute the service/Doctor implementation or count as mutable-writer acceptance.

## Evidence and boundaries

[Allowlisted receipt](receipt.json) records actual native phase timestamps/outcomes, configured deadline, sampled service transitions, normal process settlement, source binding, original session ID/label/Medium preservation, native terminal ledger and private-log hashes. Service polling granularity is approximately0.5s; the late settlement exceeds the deadline by tens of seconds, not a marginal clock comparison.

All three actual fault commands returned **exit2 / warning / deferred Doctor**, with durable **finished/skipped**, not succeeded. That is the observed bounded fault outcome, separately from the normal successful-upgrade run. After each, healthz/readyz were200 and original session metadata remained. Outer safety bounds and forced kill did not trigger.

Native service policy refresh reported the group-writable QA definition directory and retained operator overrides. That warning is disclosed; no permission guard or ownership check was bypassed. The drop-ins and their SHA-256 are included in the receipt.

**Still not established here:** SQLite mutable-writer admission/cancellation. Service stop is a mutable native service effect, not a SQLite writer. No claim is made that source-unit writer tests alone fill this distinct live cell. No production state or credentials are included.
