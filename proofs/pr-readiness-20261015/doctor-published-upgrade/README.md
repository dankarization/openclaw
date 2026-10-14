# #166000 — actual published-driver upgrade, omitted timeout

## Result

**PASS for the successful default-timeout compatibility cell.** The unmodified official npm **2026.10.3 / 59cb447** CLI installed the verified full candidate package, completed native Doctor and finalization, recorded a durable **finished / succeeded** update and restored its real systemd-managed Gateway. Both `healthz` and `readyz` returned **200**. The existing session ID, label, Medium setting and workspace file were retained. Every original configured value was retained.

This is one actual upgrade, not a mock service driver or a candidate script run in place of the published CLI. Production was not touched.

## Exact authority and package provenance

- Executed candidate: `e7ad0a972bbab870a047c00c4e9d1675cca5c8fe`, tree `af9dbbb7d52d13d281fcd65c60c14f345e7353d4`.
- Current PR head: `fe684426bd861c80bdce4d0c5df35a6f8de405ed`, tree `d9fd98b261be67388ee509e33d03ae57b551042f`.
- Complete tracked-tree comparison: exactly the deletion of `src/infra/update-doctor-deadline.test.ts`. All runtime, build and dependency bytes are identical. The package is attributed to its actual source, not relabelled to the test-only successor.
- [Canonical full build/package](https://github.com/dankarization/openclaw/actions/runs/38633526007): packageVerified=true, source clean, Node 24.21.0 / Linux x64. No skip-build/selective-plugin substitute.
- Candidate tarball SHA-256: `a6ceed5cb652ab8064a2c34ed91617a4e9e9cedab7d9bffa4a62343a8811deac`.
- Official baseline tarball SHA-256: `761685d010d96645d1deabe19299ecde263eac3f2489a17322f48c461a1130a5`.

## Reproduction

Use an independent normal global npm prefix and named profile; run npm's required native lifecycle scripts. Start its actual native managed service. Create an ordinary existing session with a label/Medium and a workspace marker before upgrading. Verify version, native sessions.list, configuration snapshot, service identity and readiness before the command.

```bash
# CLI is still the unchanged official 2026.10.3 executable here.
# CANDIDATE is the full verified local tarball from the build above.
"$CLI" --profile pr166000-proof update --tag "file:$CANDIDATE" --yes --json
# No --timeout, --no-restart, --admission installed or hidden finalize command.
"$CLI" --profile pr166000-proof --version
"$CLI" --profile pr166000-proof update status --json
"$CLI" --profile pr166000-proof gateway call sessions.list \
  --params '{"agentId":"main","label":"QA stock upgrade preservation","limit":5,"includeDerivedTitles":false,"includeLastMessage":false}' --json
```

The outer observer allowed 20 minutes plus joined cleanup. It did not time out or kill the command. The native result took 401092ms. No process remained in the original native command group after return; the new Gateway is an independently managed service.

## Evidence and native warnings

[Allowlisted machine-readable receipt](receipt.json) records source/package hashes, actual before/after native build IDs, phase durations and exit codes, native durable terminal result, service/readiness, preservation comparisons and raw private-evidence hashes.

Configuration was **not byte/semantically identical**: native Doctor added `wizard` bookkeeping and `agents.entries.main={}`. The exact pre-update backup matched the recorded original hash; a recursive comparison proved every existing configured value retained. The receipt preserves that distinction.

Do not read the successful update as “every inspection clean”:
- Post-activation Doctor inspections returned exit 1 and were recorded as a recoverable-maintenance advisory.
- Native warning-only checks reported the synthetic local auth token, intentionally disabled Codex plugin and deferred advisory inspections.
- A changing live source caused native automatic database rollback to be disabled, retaining recovery snapshots. No snapshot restore replaced later live data.
- Native runtime cleanup retained its directory because an unrelated pre-existing process had an unavailable cwd. That process was not modified.

An earlier observer preflight lacked the explicit global `--profile`, was rejected before any update child ran, and is excluded from this passing upgrade.

## Scope still outstanding

This evidence closes **successful stock-driver → candidate / omitted timeout / normal managed-service restoration and preservation** only. It does **not** prove deadline expiry, an admitted SQLite writer settling after cancellation, or an admitted native stop crossing a deadline. Those fault cells remain separate. The allowlisted export excludes raw config, credentials, private paths and session content; no UI screenshot is required for this CLI/systemd cell.
