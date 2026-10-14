# PR #166044 — real published-driver upgrade with SQLite contention

Observed 2026-10-15 (Asia/Tbilisi). [Machine-readable receipt](receipt.json).

## Builds and provenance

- Unchanged official latest-stable driver: `2026.10.3`, build `2026.10.3-release-59cb44796b0f-2026-10-13T07-33-17.552Z`.
- Installed canonical candidate: commit `a43613ac57ccb42543a66db3515ca947e312e118`, tree `d831096203bb95a4cf7ba16825695def02e04fc2`.
- Current PR head `a29246c1e63568cef6fc065bf9af4f72fb192d29`, tree `70bafe8d6f87e2358e5de92da9c48bc617b1daa0`, deletes only two mock-call assertions from `src/cli/update-cli/update-command-run-progress.test-support.ts`. All production, build and dependency files are byte-identical to the installed package source. The artifact is **not relabeled as the newer head**.
- Full canonical hosted build [38634051723](https://github.com/dankarization/openclaw/actions/runs/38634051723), artifact `11931393997`; verified tgz SHA-256 `e18692dd420e5c8bb2cd75f9f997a65a5ad2f3e5c91d25ba39b6222a22fb9735`.

## Actual route

On the separate Linux QA machine, normal native commands created a fresh named stock profile, configured and validated it through `config patch --dry-run` / apply / validate, installed its real user service, and seeded a real session through Gateway RPC. The native session had a label and Medium thinking level; its configured workspace contained a known marker.

The unchanged official CLI then ran:

```sh
openclaw --profile QA_PROFILE update --tag file:VERIFIED_CANDIDATE.tgz --yes --json
```

No internal `--timeout` override, source launcher, substituted finalizer, fake readiness callback, private ledger hook, or synthetic update-result row was used. This was a real package installation, native driver transfer, candidate finalization, service restart and health verification.

Once the installed `build-info.json` identified the candidate, a separate unchanged `update status --json` reader observed the new admitted run in `verifying/running`. Only then a separate Python SQLite connection acquired `BEGIN IMMEDIATE` on **that profile's shared updater ledger** and held it for 45 seconds, making no payload writes. It rolled back and closed normally.

## Observations

All times below are relative to the test owner's start; they come from the native output and independent holder timestamps.

| Observation | Time/result |
|---|---:|
| Native published-driver handoff | 324,417–330,357 ms, completed |
| Native post-update verification | 332,346–363,993 ms, completed |
| Native verifying phase starts | 374,726 ms |
| Public status reader sees verifying/running | 379,797 ms |
| Real SQLite writer lock acquired | 379,842 ms |
| Real SQLite writer lock released | 424,845 ms; held **45,003 ms** |
| Native Gateway verification | completed at 453,754 ms |
| Native finished/succeeded | 463,971 ms |
| CLI naturally exits | 540,140 ms; exit **0** |
| Independent native status after exit | same run, **finished/succeeded** |
| Actual restarted service | active; PID changed; same owned unit; candidate prefix |
| HTTP healthz / readyz | **200 / 200** |
| Native readiness | version/build match; service running; readyz/channelsReady/settled true; no plugin errors |
| Existing session | same native session ID, label and Medium thinking level; post-upgrade sessions.list exits 0 |
| Existing workspace | marker SHA-256 unchanged |
| Existing configured values | preserved, excluding native `wizard`/`meta` bookkeeping |
| CLI children after settlement | none |
| Outer timeout / forced kill | neither |

This adds the requested shipped entry point / driver handoff / service / stored-data acceptance to the already accepted [causal native terminal-owner A/B](https://github.com/dankarization/openclaw/blob/d20450d79b11ba4dd2872be319094a3413d48b07/proof/166044-terminal-lock-20261014/comparison.json): main failed busy after approximately five seconds under an eight-second real writer, while production-identical candidate bytes durably completed.

## Boundaries and excluded attempts

- This full-route run establishes a real lock overlapping native finalization and successful durable completion. It does not intercept the native writer or claim that the whole 45 seconds was spent in one particular SQLite call. The separate linked native-owner A/B supplies the isolated causal comparison.
- Full config bytes differ because native updater bookkeeping changed; the proof claims preservation of the original user-configured values, **not byte-identical config**.
- Native Doctor's post-activation advisory had zero errors/warnings and one info finding. Native runtime cleanup retained an old runtime because an unrelated PID's working directory was unavailable. No unsafe cleanup was attempted.
- Native success was printed before the CLI's natural exit; the additional approximately 76 seconds is preserved in the receipt and no process was killed.
- A preceding successful full upgrade failed to trigger the fault because this driver does not forward the expected stderr progress events. That run is only a compatibility control. The public native status trigger above is the qualifying contention run.
- Reusing the already migrated first profile with stock schema-20 code correctly refused schema 22. No downgrade or validation bypass was performed; this qualifying run used a separately initialized native stock profile.
- Session, workspace, configuration and bot access are QA-owned. Production Gateway, credentials and real user conversations were not copied. Endpoints, user identifiers and raw private filesystem locations are omitted from public artifacts.
