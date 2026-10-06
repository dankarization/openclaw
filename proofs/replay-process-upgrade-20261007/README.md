# PR #162565: separate-process SQLite upgrade diagnostic

## Scope and source authority

This is a storage/recovery diagnostic with the real SQLite queue and a fake outbound channel adapter. It is **not** a Telegram/Test Server test, a full Gateway upgrade, or proof of interrupted in-flight Telegram API sends.

- Producer: older patched 2026.9.8 integration `7287648fcbd6fac09ef033bad3a3e35f2b64ed89`.
- Consumer: exact PR #162565 source head `53bfd434bfe35bd7e00c240df9c01b77c505db49`.
- Release reference: v2026.9.8 `fc23bc864e4553c2d215e479eeec47b67a0bf943`.
- The producer's queue writer `src/infra/outbound/delivery-queue-storage.ts` is byte-identical to that release (SHA-256 `96877f04053bdc1381a51e01669031fc2fc66886fcdf107006ddb031c3a95f7a`).
- The producer is **not an unmodified release checkout**. In the bounded queue/outbound/state/message-runtime owner paths, its sole delta from that release is `src/state/openclaw-state-db-existing-write.ts`, an existing write-preflight performance change. The producer also contains the older transcript-echo patch.

Both phases execute the same included disposable diagnostic through the native Vitest runner and the existing infra SQLite fork inventory. No raw SQL fixture inserts, dependency version changes, product edits, or weakened assertions/timeouts were used. Each native invocation starts in a separate systemd scope with MemoryHigh=2G, MemoryMax=3G, MemorySwapMax=512M and maxWorkers=1. During cold consumer compilation, repeated own-scope high-threshold reclaim and exhausted own swap led to two runtime adjustments: soft threshold 2816M, then MemoryHigh=3840M / MemoryMax=4G. The finite hard cap and 512M swap limit remained; production resource policy was unchanged. The native package manager restored the consumer's isolated dependencies with the frozen lockfile and install scripts disabled, retaining its supply-chain policies.

## Scenario

1. The producer creates two retained completed receipts through real outbound owners: one transcript-echo key and one unrelated receipt namespace.
2. The release-equivalent queue writer creates two fresh pending rows: a keyed transcript echo and an older unkeyed echo shape.
3. The producer exits and its physical process is absent before launching the consumer. The consumer has a different PID and opens the same real SQLite state directory.
4. Assertions require exact decoded equality of all four existing entries before recovery; retained receipts remain completed and both pending rows remain pending.
5. Replaying the completed key must add no adapter send. Native recovery must send both pending rows once, fail none, and leave no pending row. Replaying the recovered key must add no further adapter send.

Only synthetic transcript strings and routing identities are included. No production audio, conversation, database, credential, or endpoint is used. The producer's completed transcript key depends on its prior installed echo patch; this does not claim stock 9.8 created such a key.

## Limits

- Genuine Telegram replay/restart behavior remains separate and unproved by this adapter.
- Existing maintainer decisions remain: required durable queue admission/no-send on durability failure and the 24-hour/2,000-receipt bound.
- Initial attempts timed out during fixture preparation (cold real-plugin discovery); another consumer attempt stopped before test execution on a missing `quickjs-wasi` dependency. They are not represented as successful runs. The final fixture uses the existing queue writer directly for pending-row preparation.
- Consumer checkout had a separate pre-existing dirty integration-test diagnostic; this invocation selects the included process diagnostic, and no tracked production source or dependency manifest was modified.

## Executed result

Both phases passed. Producer: 5,624 ms test / 47.545 s native command wall time. Consumer: 5,655 ms test / 1,269.441 s command wall time; cold runtime compilation accounted for 1,144.644 s. Native Vitest selected the infra configuration, used the fork-owned SQLite lane and reported 1/1 passing test in each phase.

- Producer PID: 180391; consumer PID: 230653. Physical producer exit was checked before reader launch; both test processes are now absent.
- All four entries decoded identically after opening the newer database owner.
- Both existing completed receipts stayed completed.
- Pending rows recovered: 2; failed: 0; fake-adapter sends: 2; remaining pending: 0.
- Replaying the already completed key added 0 sends; replaying the recovered key added 0 sends.

The verbose log reports `Stable delivery intent is already queued` for duplicate completed-key attempts. This is the expected nonfatal duplicate suppression path, not an unhandled test failure. The diagnostic does not interpret that log as a delivered Telegram receipt. A schema-migration integrity check ran before consumer readback; the original decoded row equality assertion passed.
