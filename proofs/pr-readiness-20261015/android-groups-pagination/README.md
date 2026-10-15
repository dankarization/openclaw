# Native Android loaded-page membership proof — 15 October 2026

Current PR #164857 head fd276434a19b2d59d6e86f07f50b79e0835f4de8. Native checkout 4f5782b9ff339053d2b94ee4ceb8364116a9b143 has the identical full tree 24f6ffd1a2ec676ac5f2eb2a35d583c60e36575e. Unchanged installed APK SHA-256 6261d369739833fbfdfa3c09192b3918bca96227aa0f3155fae80311ce1c0369. Same contributor QA environment and transparent transport from the earlier authority proof.

## Actual result

PASS: real UI Load more sessions issued native sessions.list offset200/limit200 and received five further rows after the initial200. Two were the earliest synthetic sessions; three were existing QA rows. The exact unmodified native Gateway handled every request.

PASS: after the actual UI renamed QA_PAGE_TAIL to QARENAMED, both original second-page rows remained. The refresh requested limit400 and returned all205 rows, including all202 synthetic sessions.

PASS: actual UI Move to group assigned QA_PAGE_002 to QAEMPTY. Its real sessions.patch and ensuing limit400 refresh retained all205 rows and the new category.

PASS: actual UI Delete group / Delete removed QARENAMED. Native group deletion retained QA_PAGE_001 with null category, retained QA_PAGE_002 in QAEMPTY, and ensuing limit400 refresh retained all205 rows. No session was deleted.

native-events.json contains paired actual request/result metadata and counts derived from the relay's original native response row vectors. Request UUIDs are omitted. pagination-*.json are text/bounds excerpts of actual native UI hierarchies; private endpoint footers are excluded. result.json records assertions checked before publication.

## Reproduction

Run the linked native-RPC preparation helper against the existing own QA Gateway: it creates202 shared, synthetic sessions through unchanged sessions.create, sequentially, with two older rows in QA_PAGE_TAIL and200 in QA_PAGE_FIRST. It never starts a model turn or writes SQLite directly. The three prior QA rows are retained.

In the unchanged APK open Threads, open Sidebar, scroll to QA_PAGE_FIRST and collapse it. Tap Load more sessions. Rename QA_PAGE_TAIL to QARENAMED, move QA_PAGE_002 to QAEMPTY through its menu, then delete QARENAMED using the confirmation that keeps threads. Compare real transport row vectors after each mutation.

## Scope and exclusions

This supplies the current-head loaded-page retention cell through rename, assignment, deletion and their ordinary native refreshes. It does not supply final socket-enqueue/worker-commit revocation, stale/same-endpoint replacement, released-Gateway fallback, concurrent reorder, rejected legacy-import retry, or maintainer security/product approval.

An early UI dump during emulator activity returned null root; that attempted capture is excluded. Navigation attempts before the drawer had settled did not count as proof. The successful UI operations and native results above are individually recorded. No production Gateway, configuration, source or sessions were changed.
