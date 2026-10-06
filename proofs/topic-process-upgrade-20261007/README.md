# PR #166011: real SQLite process/source upgrade diagnostic

## Scope

This artifact proves retained session metadata, title projection and committed rename notification after a real process/source change. It does **not** prove Telegram transport intake, full Gateway restart/update orchestration, a connected client's list refresh, or private-topic cache isolation for identical coordinates across bot accounts. Those requirements remain separate.

Producer `7287648fcbd6fac09ef033bad3a3e35f2b64ed89` is an older patched 2026.9.8 integration. All `src/config/sessions` files are byte-identical to released v2026.9.8 `fc23bc864e4553c2d215e479eeec47b67a0bf943`; it is not a completely unmodified release checkout. In `src/state` its sole delta is the existing write-preflight performance patch (`openclaw-state-db-existing-write.ts`). Consumer is exact PR head `bdc8bf4d8e50d44df3e2fafd150235eabb955936`.

## Executed flow

The producer uses real `replaceSessionEntry` and the released `recordInboundSessionMeta` owner to write three synthetic sessions with canonical delivery into real SQLite. All have a cached `New Chat` displayName and a retained topic title; one also has an explicit manual GUI-label field. A third uses a different account and thread, proving retained account metadata only, not same-coordinate cache isolation.

The producer physically exits before a separate consumer process opens the same database. The consumer asserts exact equality of all three decoded retained entries. It uses the real Gateway display owner to read each title, then the real inbound session metadata owner to rename each topic and observes the native committed rename lifecycle event.

Assertions require:

- Existing `topicName` outranks stale cached `New Chat` where no manual label exists.
- Explicit manual label wins both before and after inbound topic rename.
- Each rename commits the new `topicName` and emits exactly one native rename event.
- Session ID, activity timestamp and cached displayName remain unchanged.

No HTTP/Telegram update, RPC/websocket/UI render, model reply or external service is mocked into this result; those flows are not exercised. No production state, credentials, conversations or endpoint is included. Synthetic fixture state is the input, not a copied operator database.

## Results

Both native infra/fork phases passed 1/1. Producer PID 255209 had exited before consumer PID 256480; both are absent after completion. Producer: 5,228 ms test / 78.086 s native command wall time. Consumer: 4,905 ms test / 50.881 s wall time. Existing compiler outputs were reused. Each own test scope: MemoryHigh=3840M, MemoryMax=4G, MemorySwapMax=512M; maxWorkers=1. No product, dependency, timeout/assertion or serving-build change was made.

The first diagnostic attempt supplied retired top-level `origin/lastChannel` fields instead of the canonical `delivery` shape already required by the released type. Its consumer correctly displayed `New Chat` without the canonical channel identity and failed. This was a fixture error, not a demonstrated PR defect. The final producer uses the released metadata owner to construct canonical delivery; original title/label/identity assertions and the 60-second test deadline were unchanged. The failed attempt is preserved privately and is not counted as a pass.

This is disposable operator proof, not a new CI test or regression-coverage addition. The diagnostic and temporary native inventory entry were removed after physical completion.
