# Current Android groups: executed partial UI/native proof

For upstream [#164857](https://github.com/openclaw/openclaw/pull/164857), executed15October2026 Asia/Tbilisi /14October21:20–21:23UTC.

## Exact source and installed APK

- Published head `fd276434a19b2d59d6e86f07f50b79e0835f4de8`; equivalent normal local merge `4f5782b9ff339053d2b94ee4ceb8364116a9b143`; exact full tree `24f6ffd1a2ec676ac5f2eb2a35d583c60e36575e`.
- APK SHA-256 `6261d369739833fbfdfa3c09192b3918bca96227aa0f3155fae80311ce1c0369`,139303863bytes. Native`:app:assemblePlayDebug` succeeded4m10s (65tasks:45executed,20up-to-date), no source changes. A prepared wrapper expected an obsolete output filename and exited1 after native success; the actual APK was located and verified without rebuilding.
- `ai.openclaw.app.debug`, version2026.8.2-debug/code2026080201. Native debug certificate SHA-256 `dc53b2e95a01aa5a91911e2fc0a16340d7117b5b773ebc364dada2c8827f94e5`; not an official/store signing identity.
- Native Gateway imported the same current PR checkout/tree, not the earlier #163516 backend. Its task configuration explicitly disabled unrelated plugins, passed the native validator and started the normal Gateway server/handlers. Missing package-local third-party links were restored only to existing exact-pinned dependency installations; no shared install, dependency source, lockfile or product source was changed.
- The existing disposable QA APK had another signature. Native install-r correctly refused; the task-only app was then uninstalled and freshly installed. **This is fresh-install proof, not stable-upgrade proof.**

## Actual observed flow

1. Separate native admin RPC seeded only `QA_REMOTE_EXISTING`. Actual current Android sidebar displayed that real Gateway group: [before](before.png), [native hierarchy](before.xml).
2. Actual Android New group dialog created `QA_UI_GROUP_A`. Actual Android emitted `sessions.groups.put {names:["QA_UI_GROUP_A"],appendOnly:true}` at21:21:01.450UTC; unchanged native response at21:21:01.473 accepted both existing and new group: [created UI](created.png), [hierarchy](created.xml).
3. Actual group menu → Rename group renamed it to **`QA_UI_RENAMEDA`**. This includes a harmless actual UI input typo, retained exactly in captures/traces. Actual request21:22:20.547 and native accepted result21:22:21.447; no member sessions were claimed: [renamed UI](renamed.png), [hierarchy](renamed.xml).
4. Actual group menu → Move up emitted native append-capable `sessions.groups.put` with empty additions and complete `sectionOrder`. Native accepted result21:22:49.784 retained both group records and ordered the renamed group before `QA_REMOTE_EXISTING`.
5. The task app was force-stopped and relaunched normally. Actual sidebar displayed the same two names and changed order; a fresh native admin `sessions.groups.list` read confirmed order and native`appendOnly:true`: [after reorder and relaunch](after-reorder-relaunch.png), [hierarchy](after-reorder-relaunch.xml).

[Actual correlated Android request/native response trace](wire.sanitized.json) and [authoritative native readbacks](native-readbacks.sanitized.json) are supplied. This is actual UI input and native Gateway RPC, not calls into mocked group handlers. Native operator authentication held **operator.admin/read/write** plus other normally issued administrator scopes; this run proves neither read-only denial nor write-without-admin admission. The transport relay forwards actual group requests/results unchanged and does not inject these group mutations. The separate native admin seed/readbacks are labelled separately.

## Scope and remaining proof

**Observed:** server-owned empty catalog display; actual UI group creation; actual UI rename; actual UI Move up/section-order persistence; preservation of a preexisting server group; app force-stop/relaunch display/native state.

**Not executed here:** session assignment/deletion, readonly/pending-revocation, stale-origin/physical replacement/final enqueue authority, worker commit denial, true concurrent append/stale reorder, loaded-roster pagination, forget/auth-reset catalog retirement, rejected-migration retry, exact latest-stable source-built upgrade and durable draft/outbox/attachment preservation. Source regressions and historical older-APK evidence remain separately scoped. Maintainer authorization/product decisions remain open. No proof-sufficient or merge-ready status is self-assigned.

## Capture/source contract

Four PNGs are **disclosed vertical crops** of actual1080×2400 emulator screenshots to1080×2080, removing only the bottom endpoint/status footer. Retained pixels are unchanged; original-image hashes, exact crop rectangles and zero retained-pixel differences are in [result](result.sanitized.json). Full hierarchy structure is retained; task endpoint values are replaced with`[QA_HOST]`, opaque wire correlation IDs consistently hashed, local root paths replaced with`/QA_ROOT`. Setup/token screens are private and excluded. No behavior labels/menu/group state was fabricated or retouched.

Executed QA fixture sources: [native Gateway launcher](gateway.mjs), [transparent relay](relay.mjs), [native admin RPC](rpc.mjs), [native grant owner](grant.mjs), [actual UI capture](ui.py), [native identity/auth-store helper](OpenClawNativeCredentialFixture.java). They are not product source changes or a credentialed turnkey deployment. Only task-owned synthetic state/credentials were used.

The task's native Gateway, relay, AVD and broker were stopped after capture; their state is retained for later bounded acceptance. No production Gateway/configuration/user device was changed. This is a coherent partial result, not completion of the full PR acceptance matrix.
