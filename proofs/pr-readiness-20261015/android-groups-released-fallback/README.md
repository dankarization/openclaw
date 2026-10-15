# PR #164857 — actual Android fallback on released Gateway 2026.10.3

Executed 2026-10-15. This qualifies the older-server capability fallback, not the live in-process owner-switch or rejected-import retry cells.

## Exact inputs

- Upstream PR head: ac26e6b72335512c1301b5d274cd49a789b13494.
- Actual APK source: 4f5782b9ff339053d2b94ee4ceb8364116a9b143; APK SHA-256: 6261d369739833fbfdfa3c09192b3918bca96227aa0f3155fae80311ce1c0369.
- The current head changes only a test relative to the previously published equivalent runtime tree. No new APK build is claimed.
- Official, unmodified Gateway 2026.10.3 source: 59cb44796b0f1f0daa0e37af8b1495abb45d9bc1, using the previously installed official package, SHA-256 761685d010d96645d1deabe19299ecde263eac3f2489a17322f48c461a1130a5.
- Independent disposable QA profile. Production was untouched. Native config validation succeeded before launch.
- Actual Android app connected using Settings / Manual Gateway / Save & Connect. Its real operator connection had admin/read/write scopes. This is not a non-admin qualification.
- The relay forwards genuine request/result frames; it neither manufactures capabilities nor substitutes handler outcomes. Logs below retain only group RPCs, omitting credentials, connection identifiers, endpoint addresses and unrelated sessions.

## Executed behavior

1. Native administration created QA_RELEASED_KEEP on the released Gateway.
2. Actual Android sidebar displayed QA_RELEASED_KEEP.
3. Native sessions.groups.list returned the legacy response shape with no appendOnly capability.
4. Actual Android UI Create group entered QAFALLBACK.
5. The app fetched the native catalog and emitted exactly one sessions.groups.put with names [QA_RELEASED_KEEP, QAFALLBACK], with no appendOnly property.
6. The unchanged released Gateway accepted the request and returned both groups.
7. Actual Android sidebar displayed both groups. A later independent native RPC also returned both groups.

The fresh legacy union preserved the original server folder while adding the intended folder. No new protocol property was sent to a server that did not advertise it.

## Evidence

- [Correlated actual request/result trace](./native-group-trace.json)
- [Independent settled native read](./settled-catalog.json)

These files are extracted from actual transparent relay events and the independent native RPC receipt, not generated responses. Native assertions verified one put, exact legacy payload, omitted capability in every recorded list result, and both final groups.

## Scope and exclusions

This is one sequential create on the real released server. It does not claim concurrent legacy replacement safety beyond the existing fallback contract, native in-process Gateway-switch rejection, rejected legacy-import retry, product-owner approval, or security approval.

Two attempts to preinstall credentials using a test-only app_process helper aborted before setup; they are excluded. The successful connection used the actual Android UI and native authentication. An earlier admin helper incorrectly pointed its client state at the released server database and was properly refused by the native schema guard; client state was separated before the independent RPC above. No downgrade, lease bypass, schema rewrite, or production change occurred.
