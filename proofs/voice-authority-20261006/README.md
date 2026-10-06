# Selected-agent audio authority proof for PR #163557

Executed 2026-10-06 against source head `911e0f238e86451c0d2d24b9efe2b391398305e1` in an isolated checkout. No production Gateway, user configuration, user audio, or real credentials were changed.

## Observed effects

| Route | Admission during preparation | HTTP uploads | Selected-agent key on wire | ffmpeg processes | local CLI processes |
|---|---|---:|---|---:|---:|
| Provider | retained | 1 (32,319 multipart bytes) | yes; default-agent key absent | 0 | 0 |
| Provider | revoked after initial admission | 0 | no request | 0 | 0 |
| Local CLI | retained | 0 | not applicable | 1 | 1 |
| Local CLI | revoked after initial admission | 0 | not applicable | 0 | 0 |

The real Gateway `prepareChatSendUserTurn` owner invoked native audio preflight, selected-agent auth resolution, the bundled OpenAI audio adapter, native guarded HTTP transport, and native ffmpeg/CLI execution. The loopback server observed the actual multipart request and compared its Authorization header against two distinct **synthetic non-secret markers** in temporary main/support agent profiles. Fetch and HTTP transport were not mocked. The process observer delegates every execution to the original native `runExec`; the allowed case started system ffmpeg and a real temporary Node CLI executable.

The endpoint returns fixed synthetic STT text, and the generated recording is one second of silence. This is transport/auth/admission evidence, not speech recognition accuracy or a request to an external provider. The temporary provider configuration explicitly permits its local endpoint through the existing `models.providers.openai.request.allowPrivateNetwork` setting. No production network policy was weakened.

For both revoked cases, admission initially succeeds. A queued microtask revokes the existing admission predicate during asynchronous preflight preparation. The native prepared input rejects with the revocation error, and the final HTTP/process observers remain at zero. This covers preparation-time revocation before new effects; it does not simulate a complete UI Stop RPC, promise immediate termination of an already-running process, or prove cancellation at every individual await.

## Reproduction and artifacts

Copy `diagnostic-source.test.ts` to `src/gateway/server-methods/chat-send-user-turn.authority.diagnostic.test.ts` in the pinned source checkout. Temporarily add that exact path to `databaseWorkerCoreTestFiles` in `test/vitest/vitest.database-worker-core-paths.mjs` so the native SQLite test worker owns the diagnostic. Set `VOICE_AUTHORITY_PROOF_RECEIPT` to a writable temporary JSON file, then run:

```sh
node scripts/run-vitest.mjs src/gateway/server-methods/chat-send-user-turn.authority.diagnostic.test.ts --maxWorkers=1
```

- `effect-receipt.json`: all four observed effect cases.
- `native-provider-policy-run-result.json`: successful native command receipt (38.965 seconds wall time).
- `native-run-redacted.log`: native runner output; one test passed, 3,053 ms test execution / 18.34 seconds Vitest duration.
- `diagnostic-source.test.ts`: exact executed diagnostic, including clearly labelled synthetic credential markers.

Initial attempts did not pass: the diagnostic had not configured the temporary provider's private-network policy. A first correction placed the setting on a media entry, where the native sanitizer intentionally removes it. Moving it to the supported provider request setting resolved the fixture failure without a product change. Those attempts are not presented as passing.

Temporary test routing and the diagnostic were removed from the PR checkout after execution. No extra regression test or dependency change is added to the product PR by this evidence commit. Existing Android/WebGUI screenshots and operator-confirmed refresh persistence remain separate visible-client evidence.
