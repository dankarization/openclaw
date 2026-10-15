# PR #164857 — current-main native owner replacement and release fallback

Executed 2026-10-15. These are new observations on the integrated current runtime, not renamed historical proof.

## Exact implementation and fixtures

- Published PR head: f6477fc1ffda8c737d476f9323bcbf866c93afe7.
- Native build/Gateway source: b9ae116f6d158d785e03afca19204295545a6e6c.
- Both source trees: f4f411ddbfe24617577e2688caba8a0cd79a205a. This merge includes actual upstream main cd3eb90f875295e90c6fb7e0c10fc72920b5235a and preserves both the PR method-catalog probe and upstream closeTalkSession.
- Actual unmodified product APK SHA-256: 34ef789c870006e2d8caf183d41ccfc0e4f0160b6a367b5ebbe394fd5abb98ab. Native assemblePlayDebug; subsequent clean-commit packaging; adb install-r Success without clearing data.
- Gateway A: the above current source, native startGatewayServer, independent fresh QA profile.
- Gateway B: official unmodified 2026.10.3, source59cb44796b0f1f0daa0e37af8b1495abb45d9bc1; official package SHA-256761685d010d96645d1deabe19299ecde263eac3f2489a17322f48c461a1130a5.
- Both are real separately authenticated native operator connections. These cells use admin-authorized QA credentials, not a new non-admin proof.
- The Android app and both Gateway profiles are task-created QA. Production is untouched.
- Relays forward native requests/results and can retain an original native response until release. They do not synthesize auth, capabilities, acceptance, refusal, or committed catalog results.
- Runtime tests: 148 native Android tests / zero failures, ktlintCheck and APK build passed. Independently owned frozen-lockfile installation (native pnpm12.10.1, Vitest5.0.3) passed39 backend/protocol tests across the three touched test files.

## Cell 1 — actual in-process Gateway switch while Create is pending

1. Actual Android UI on Gateway A entered QALIVESW and pressed Create.
2. A genuinely executed sessions.groups.list returned successfully. Its original response was held at the transparent relay, leaving the Android action pending.
3. The actual running app opened the real Gateways selector. The driver parsed the observed UI bounds and selected Gateway B. The next native UI dump confirmed B's footer and a closed selector.
4. The same Android PID remained alive throughout. No force-stop, relaunch, preference rewrite, or synthetic lease callback was used during this cell.
5. The native owner replacement retired A's original operator peer32 and node peer33 at09:05:21.009Z. That is about5.3 seconds after the held request, before the native15-second RPC deadline. A's background operator later reconnected as peer34; B authenticated its new operator peer5.
6. The old held response was released at09:05:25.481Z, about9.8 seconds after being held.
7. Neither Gateway received an Android sessions.groups.put or sessions.patch during the test window. Independent native before/after catalog reads were exactly equal on both servers.

**Result:** PASS for the requested real in-process owner replacement/no-effects cell. Actual Android process lifetime survived while its original physical request owner was retired.

**Precise transport scope:** the original peer32 was closed by the real app's owner replacement. Release therefore could not deliver through that old socket. The reconnected A peer34 in the status receipt is a different connection. This does not claim delivery of an old payload into a still-open retired callback. It exercises the natural native switch path recommended by the review; it does not force an otherwise unreachable packet delivery.

Evidence:
- [Native receipt, same PID, both catalogs, zero writes](./switch-receipt.json)
- [Correlated actual native request, held response, physical retirement, reconnect and release](./switch-native-trace.json)
- [Original UI node excerpts: entered value, actual selector, selected destination](./actual-ui-node-excerpts.json)
- [Executed driver with endpoint/root substitution only](./executed-switch-driver.sanitized.py)

The public driver requires QA_ROOT, QA_A_CONTROL, QA_B_CONTROL and QA_B_UI_LABEL. Those replace only the private fixture paths/addresses from the executed source. UI interaction, native hold/release, PID checks and catalog assertions are unchanged. The original private UI XML hashes are recorded with the excerpts.

## Cell 2 — current APK on the released Gateway

With B active in the same current APK, actual UI Create QACURLEG fetched the genuine legacy catalog. The released server did not advertise appendOnly. Exactly one Android put contained the fresh full names union, with no appendOnly property:

QA_RELEASED_KEEP, QAFALLBACK, QASWITCHPE, QACURLEG.

The native accepted result and independent later read retained all original groups and the new group. QASWITCHPE is an intentionally retained synthetic folder from an earlier excluded preparation attempt.

**Result:** PASS for current-APK release-compatible fallback. See [actual native receipt/trace](./released-fallback-current-apk.json).

## Cell 3 — nearest allowed create on current Gateway A

After selecting A normally, the same APK used actual UI Create QALIVEOK without changing owner while pending. Exactly one native put used names [QALIVEOK], appendOnly true. Native result and independent read retained QA_MAIN_KEEP and added QALIVEOK.

**Result:** PASS for the nearest allowed counterpart on the actual current Gateway. See [positive native receipt/trace](./current-gateway-positive-create.json). This distinguishes the zero-write switch outcome from a generally nonfunctional Create path.

## Setup exclusions and remaining work

- The first current-source attempt against the old QA agent profile properly refused schema26 and requested native Doctor. That attempt is excluded; the old profile was retained and the current-source functional cells use a separate fresh native profile. This is not an old-profile migration proof.
- An initial old QA credential was refused by the new profile. Actual Android Settings/Manual Gateway/Save & Connect established its own fresh native authentication. No credential value or setup capture is published.
- Two earlier preparation attempts never actually selected the other Gateway and created QASWITCHPE/QASWITCH2 normally. They are not passing switch evidence and are not included in this test's time window.
- Rejected legacy-import retry is still separate and not claimed.
- Product direction and exact-head security approval remain maintainer decisions. This bundle neither grants them nor self-assigns sufficient-proof status.

All published logs are scoped to group RPCs/transport ownership. Credentials, endpoint addresses, request UUIDs and unrelated sessions/conversations are omitted or consistently aliased. No generated image or fabricated native result is used.
