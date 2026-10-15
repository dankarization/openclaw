# Native worker final-effect, physical replacement and concurrent-order evidence

## Exact source

PR #164857 head ac26e6b72335512c1301b5d274cd49a789b13494, tree0cfff552fa672e0c90c7d24d9ada257bf945bba0, equals native checkout d352c779c4ea415c903aebf0cd441bb5d5bd7672. The sole delta from installed APK source4f5782b9ff339053d2b94ee4ceb8364116a9b143 is the requested test cleanup. All production/build/dependency inputs are identical. APK SHA256 6261d369739833fbfdfa3c09192b3918bca96227aa0f3155fae80311ce1c0369. Product source, admission and receipts were not substituted.

## Real worker stopped before commit: observed contract, not fabricated rejection

Loopback Node inspector attached via NodeWorker to the running native SQLite worker and set a conditional executable-location breakpoint in the already-loaded sqlite-writer-admission-client.ts: request.stage=commit with session-group-catalog in the native stack. Gateway main thread was never paused. native-worker-pauses.json records actual kernel/transaction stacks; full helper sources are included.

1. Actual Android Create QACOMMIT reached real sessions.groups.put and paused at native commit admission. Own QA APK was force-stopped. Relay observed physical upstream-close before resume. The already-admitted catalog write committed anyway. This initially failed the experiment's anticipated refusal assertion and is explicitly NOT passing revoke-refusal proof.
2. Separate actual Create QAREVOKE paused at that same native boundary. Already-connected native administrator invoked actual device.token.revoke for the Android device. Revoke did not settle while catalog worker held its transaction. After resume, catalog committed, then native revoke completed and removed the operator connection. This establishes serialized order; it does NOT claim authority was revoked before catalog commit. The worker Debugger.resumed event is authoritative, rather than the later HTTP-control completion timestamp.

Existing source matches these observations: authenticated-request-dispatch.ts retains an accepted client invocation after transport closure; client-registry.ts includes retained requests in authorityClients. device-pairing-tokens.ts/device-pairing-worker.ts route real revoke through the same state SQLite writer; device-pairing-publication.ts explicitly keeps rows authoritative until COMMIT. devices.ts fences/disconnects clients after native revoke returns.

**Owner/reviewer question:** Is pre-commit refusal intended to change the existing accepted-request / serialized-revoke contract? Otherwise, please identify the reachable native authority event that can revoke this admitted catalog operation during its transaction. A synthetic assertCurrent failure would not prove it. No broad lifecycle redesign or classification of socket closure as token revocation is proposed here.

## Actual process retirement, same configured endpoint

PASS for scoped physical replacement: real UI Create QASTALE awaited its one original groups.list response held at the transparent relay. Actual APK was force-stopped/relaunched without changing endpoint or credentials. Another physical peer authenticated read/write. Releasing the obsolete response did not forward it to its already-closed downstream. Neither peer sent groups.put/sessions.patch, independent catalog before/after was identical, QASTALE absent.

This proves real lifecycle/transport retirement. It does not claim injected stale callback after a live in-process Gateway switch or final Android transport-mutex pause.

## Actual concurrent append/reorder and Android Move up

PASS after actual mutation settled: while Android's original groups.list response was held, a second already-connected native client appended QA_CONCURRENT_ORDER and reordered. Release let real Android Move up submit names:[], appendOnly:true and its order. Final native mutation response plus independent native read retain all original groups, concurrent new group and its section token. Requested Android pair moves to submitted order. Overlapping positions follow last submitted order, not arbitrary merge of incompatible intents.

Helper's initial500ms read preceded actual Android put completion and failed its order assertion. The operation was not replayed: final native response and later independent read establish settled outcome. concurrent-order.json preserves early observation and final result.

## Limits and preparation failures

First inspector attempt could not dynamically import from Runtime.evaluate; changed to the already-loaded script location. Restarted only the helper after identifying its relative process argv; the occupied-control-port attempt never replaced the Gateway. No failed preparation is counted as product proof.

Own QA device token was restored after revoke using existing native credential owners. Only own QA state/processes were used; production unchanged. Remaining: released-Gateway fallback, rejected legacy-import retry, exact in-process/final-enqueue qualification if still required, product/security decisions. No self-assigned sufficient-proof or bypass verdict.
