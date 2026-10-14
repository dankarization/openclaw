# Native updater terminal SQLite contention proof

Scope: source behavior of `completeUpdateCommandRun`, not a published-driver installation, sealed-grant transfer, or service-readiness proof. No production state or service was used.

| Source | Tree | Actual lock | Native terminal call | Durable native readout |
| --- | --- | --- | --- | --- |
| main `c05c277d04326b53858f85e2ea83c16b4756e83b` | `bdea78650b3dc0031d0043716191f0c82521ef00` | 8009.065 ms | throws SQLite busy after 5096.193 ms, before unlock | requested / running, no finishedAtMs |
| PR #166044 `148f0679daa2fcd23b632968e531a86e3bfbd0cc` | `4c27aff8bb3c13c8eb2162a3d7106fc1f5b8c4d0` | 8009.293 ms | returns ok after 8159.398 ms, after unlock | finished / succeeded, finishedAtMs set |

Both use a 71000 ms admitted ledger allowance and independent synthetic profiles. The consumer warms native imports, seeds and reads its ledger, then signals ready. Only after a separate process confirms a real `BEGIN IMMEDIATE` transaction does the runner release the native terminal call. Raw SQLite is used only by that lock-holder; setup, terminal mutation, and readout use native owners. No fake clocks, writer replacements, modified authority checks, package build, or new service. The existing managed process owner enforces bounded execution and joins every consumer, blocker, and native reader. See each `cleanup.json`.

The exact executed `fixture.mjs` SHA-256 is `06a560cf0592833a956123740e453c4a6add85c106b13075eb4e857bb42a1263`. `comparison.json` contains head/tree identities, real timestamps, native readouts, child exits, and the asserted red/green comparison. Synthetic databases are intentionally excluded from this artifact.

Reproduction from either checkout (Node 24.21.0, pinned dependencies already installed):

```sh
node --max-old-space-size=768 --import ./scripts/tsx.mjs /absolute/path/fixture.mjs runner /absolute/path/source /absolute/path/new-profile /absolute/path/new-artifacts
```

The old-main control fails despite the same allowance input, showing that the green candidate is not merely a noncontended happy path. It does not establish any unrelated update or service lifecycle claim.
