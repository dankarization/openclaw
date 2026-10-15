# PR #164857 — rejected legacy import, restart retry, read-catalog publication

## Exact source
Public head: 019f6ada87425d5d35c456f40c424167f87185f1.
Validation source: 17551257ed532cc11b8ae64ed4a5713ee18b108c.
Clean APK build source: 27f8b99d44a85ffa483834fa382e21f88281b356.
Both native checkouts and the public head have full tree 088db658114734ecd036e7939a187140e2ab714e.
Installed APK SHA-256: 500360da44a0bb0ba9eda3c00fc3c5e4a1f7b34b271ae18ac57c6136d90b746e.
Native Gateway ran the append-admission production files tested at 01599e42206908b65d89b8f023b8511b258b2fb6; these Gateway files are unchanged in the current Android-only successor. No authorization result or group response was mocked.

## Actual flow and result
1. A fresh task-owned AVD reused the installed Android 35 image. The unchanged official stable 2026.10.3 APK (source 59cb44796b0f1f0daa0e37af8b1495abb45d9bc1) created QAFIXSEED and the separate empty local QAFIX_RETRY through its actual Threads row/group menus. Native SecurePrefs readback confirmed both. No local name or migration flag was seeded.
2. Installed the clean current APK with adb install -r, preserving that profile. Its native credential owner stored a genuine Gateway-issued operator.read grant. Actual app startup listed server groups/order, then sent exactly one groups.put with names=[QAFIX_RETRY], appendOnly=true. The native Gateway returned FORBIDDEN, missing operator.write.
3. Despite rejection, the actual sidebar displayed both remote empty QA_MAIN_KEEP and local QAFIX_RETRY. Native server catalog/order remained unchanged, including [category:QA_MAIN_KEEP, ungrouped]. After force-stop, native preferences retained [QAFIXSEED,QAFIX_RETRY], legacyConsumed=false, catalogMigrated=false.
4. Restored native operator.read/operator.write authorization on the same identity and restarted the same APK/profile. Exactly one import succeeded, appending QAFIX_RETRY without dropping any prior server folder or changing shared order. Native persisted names became empty; consumed/migrated became true.
5. Restarted again: actual UI/native listing retained the folder, **zero groups.put** occurred, and persisted completion flags stayed true.

## Causal before/after
The earlier unchanged APK 34ef789c... genuinely rejected its import but omitted remote empty QA_MAIN_KEEP from its sidebar. Its actual native UI excerpt is separately attributed to that earlier APK. Current APK fixes this omission while retaining pending legacy data; earlier successful retry was not evidence that this newly discovered presentation defect was absent.

## Evidence
- results.json: native catalogs, timestamps and preference readbacks.
- native-trace.json: actual Android requests/matched native responses; request IDs consistently aliased.
- actual-ui-excerpts.json: actual native nodes/bounds, original XML and private screenshot hashes. These are excerpts, not recreated screenshots. Footer endpoints/device rows omitted. No screen pixels altered.
- actual-ui-actions.json: completed action receipts with actual observed bounds/snapshot hashes.
- provenance.json: exact source/tree/APK/test attribution and original fixture hashes.
- Executed native credential, grant, UI, producer and qualifier sources included. Only endpoint/root literals redacted to placeholders; restore your QA values before replay. Tokens/private synthetic identity bytes are excluded.

## Fixture limitations and excluded preparation
Only owned QA infrastructure used; production Gateway/config/Codex/user profiles unchanged. Auth fixture invokes native DeviceIdentityStore/DeviceAuthStore/SecurePrefs only for endpoint/credential setup and state reads. No group-writing or migration-flag fixture API exists. Changed permission grants deliberately exercise real server admission, not a forged callback. No model call is involved.
Initial UI observations occasionally had no accessibility root during startup/navigation. Execution resumed at the first unperformed observation; later observations retry at most three times and never replay inputs. Completed action receipts establish actual order; incomplete preparation is excluded from passing cells.
Native Gateway uses a disclosed in-process startup harness with unchanged shipped auth, handlers, SQLite/catalog owners and WebSocket transport. Transparent relay records native traffic; its control reads require a connected operator. An initial disconnected control read failed and is excluded; prelaunch baseline comes from genuine native device-token catalog reads.

## Validation and external decisions
Current MainViewModelTest: **18 passed**, zero failures/errors; ktlint and clean APK assembly passed. Append-only admission follow-up passed **11 native sharing-group tests** on production Gateway files unchanged at this head.
Previous switch/fallback, paging, authority and upgrade proofs remain separately attributed. This artifact does not claim all-suite green CI or owner approval. Shared Gateway folder direction and final-revision security approval remain maintainer decisions.
