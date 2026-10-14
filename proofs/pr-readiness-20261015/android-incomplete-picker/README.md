# Android canonical Medium: actual send and queued reconnect

Executed 15 October 2026 Asia/Tbilisi (14 October 20:36–20:43 UTC) for upstream PR [#163516](https://github.com/openclaw/openclaw/pull/163516).

## Exact source and scope

- Installed unchanged APK source: `a3dd5af5727afd66f3dbedf42cc9a85152bb7ca0`.
- APK SHA-256: `681118665160db825edeacbda7d4e30c9294f55b33052d2ca8e7c3e9f309ea8b`.
- Current PR test-only head: `1508bc63fd59fe4ef4242288464e70fe3bf29ce2`, tree `c3acc44fd01f0aaec8c0c5a68944010c4cab3724`. A full tracked-tree comparison found only 50 deletions in `ChatThinkingLevelClampTest.kt`; every runtime/main/build/dependency file is identical to the APK source. No new APK or production change is claimed.
- Actual native Gateway source: `a8b899d9a0039249bc01e362684f6c51c3de40c9`.
- Isolated contributor-owned AVD and native QA Gateway. The Android connection used native read+write admission without admin. Native administrative setup established Medium/Fast false before the UI run.

The transparent metadata fixture omits only Medium entries from advertised thinking arrays. It preserves effective values, native hello/auth/scopes, handlers and native results. This is a controlled incomplete-catalog reproducer, not a claim that the production catalog naturally omitted Medium. The OpenAI-compatible model fixture returns deterministic ACK text after real native agent invocations; it proves orchestration and transmitted effort, not model intelligence. Its actual requests reported `reasoning_effort: medium` twice. Neither message nor outbox item was injected by RPC.

## Executed result

1. Actual Android Thinking UI showed **Medium** as effective, with listed choices Off/Minimal/Low/High/Ultra: [before capture](before-medium-picker.jpg), [native hierarchy](before-medium-picker.xml).
2. Actual UI typed and sent `QA_MEDIUM_DIRECT_20261015`. The actual Android `chat.send` carried `thinking: medium` at **20:38:55.074 UTC**; native Gateway accepted it at **20:39:07.996**. Model request 1 at **20:39:28.507** retained `reasoning_effort: medium`; Android displayed `QA_CANONICAL_MEDIUM_ACK_1`.
3. The fixture closed its own transport at **20:40:02.803**. Actual Android UI typed and sent `QA_MEDIUM_QUEUED_20261015`: [actual queued UI](offline-native-queue.jpg), [hierarchy](offline-native-queue.xml), explicitly displaying **Queued — sends when reconnected**. No Android `chat.send` was observed between offline and online.
4. Transport was allowed online at **20:41:21.031**. Native Android reconnect flushed the actual UI-created queue item: `thinking: medium` at **20:42:03.105**, real native accepted result at **20:42:03.380**, model request 2 at **20:42:10.127** with `reasoning_effort: medium`. Android displayed `QA_CANONICAL_MEDIUM_ACK_2`.
5. [Both native replies in actual Android UI](both-native-replies.jpg), [hierarchy](both-native-replies.xml). Reopening Thinking still showed **Medium** with the same incomplete choices: [after capture](after-medium-picker.jpg), [hierarchy](after-medium-picker.xml). A real native `sessions.list` read retained **Medium / Fast false**.

The result closes only the canonical Medium direct-send and current-owner queued-reconnect acceptance cells. It does not introduce a permission grant, replace native validation, claim naturally faulty production metadata, or decide the [maintainer write-versus-admin admission policy question](https://github.com/openclaw/openclaw/pull/163516#issuecomment-6169517289). Existing separately published read-only and pending-revocation observations retain their original scopes; this run is not another revocation test.

## Evidence and reproduction contract

- [Structured result and exact original/public fixture SHA-256 values](result.sanitized.json).
- [Actual transport trace](transport-trace.sanitized.json): native scopes, controlled metadata observations, actual Android requests, matching native results, and transport transitions. Opaque IDs are consistently hashed; the complete private trace hash binds the source record. Native response timing is retained.
- [Actual model request summaries](model-requests.sanitized.json): real timestamps, effort and private-body hashes. Full prompts are not published.
- [Native persisted-state observation](final-state.sanitized.json).
- Actual executed fixture source: [transparent metadata/transport relay](metadata-relay.mjs), [deterministic ACK provider](metadata-provider.mjs), [native Gateway launcher](gateway-minimal.mjs), [process launcher](incomplete-launch.py), [actual UI driver](incomplete-ui.py), [native credential setup](incomplete-credential.py), [native identity/auth-store helper](OpenClawNativeCredentialFixture.java).

Source path literals are replaced by `/QA_ROOT`; credentials and private configuration are excluded. JPEGs are quality-85 format conversions of the original Android screenshots, with full native XML beside them; no content redaction or UI fabrication. The fixture requires explicit `OC_ANDROID_INCOMPLETE_PROOF=1`. Reproduction requires the existing public exact source/APK, Node 24, Android SDK/emulator, and a disposable native QA profile/grant. The supplied scripts describe the executed operands; secret-bearing native configuration is deliberately not a turnkey deployment file.

After evidence capture, the task's own AVD, native Gateway, relay and provider were stopped. Production Gateway and unrelated QA services were not changed. No new product source, tests, build, or package was introduced for this proof.
