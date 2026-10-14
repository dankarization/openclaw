# #170200: real Telegram document → native host tool access

## Exact sources and result

- Candidate: `b6e89d0ee6988565f74bc1b82778f8df65196f32`.
- Pinned clean-main control: `c05c277d04326b53858f85e2ea83c16b4756e83b`. This identifies the executed baseline, not a claim that a moving main ref was tested.
- Executed 2026-10-14 UTC: baseline 17:24:31–17:25:49; candidate 17:27:09–17:28:43.
- Synthetic `qa-large-document.bin`: **54,525,952 bytes (52 MiB)**, SHA-256 `2fade4fa841545c954a8b55e00989b7aa559ece325011a080dae3d4e95fef124`.
- Both processes exited 0; a baseline pass means the expected causal rejection was observed.
- Exact candidate dependencies were installed with native pnpm 12.9.0 `install --frozen-lockfile --ignore-scripts --prefer-offline`; manifests and product source were unchanged. Node 24.21.0. Each source uses its own dependencies and TypeScript source aliases.

| Executed case | Channel / account MiB | Result |
| --- | --- | --- |
| Clean-main control | 128 / 64 | Real Telegram intake succeeded; staging rejected at 52,428,800 bytes (50 MiB), no staged path |
| Candidate | 128 / 64 | Native staging + exec read 54,525,952 bytes; checksum matches original |
| Account is lower | 128 / 51 | Native staging rejected at 53,477,376 bytes (51 MiB) |
| Account is higher | 51 / 64 | Native staging + exec checksum succeeded |
| Existing main-created managed reference | 128 / 64 | Same existing URI and bytes accepted by candidate; native exec checksum succeeded |

Receipts: [clean main](native03-main.sanitized.json), [candidate](native03-candidate.sanitized.json).

## What actually ran

The operator uploaded this synthetic document to a contributor-owned QA bot through real Telegram. A bounded getUpdates capture saved that exact document update privately; the capture exited before either proof process. [Upload screenshot](large-document-sent-52MiB.jpg) shows that upload only, not tool access. Earlier QA audio/error messages visible in the screenshot predate this document scenario.

Each isolated process loaded the selected source's native plugin registry (`pluginSdkResolution: "src"`, no preferred built artifacts), entered the real Telegram plugin-instance scope, and executed `createTelegramBot` / `handleUpdate` on the captured update. Its native intake made **one actual network getFile call**, then produced the managed inbound media reference and native Telegram/account/session context through `buildChannelInboundEventContext`. The harness did not assign Telegram identity to a fabricated context. Both receipts contain equal hashed message/session identities, real intake size/hash, and the exact source identity.

After capturing that context the QA callback deliberately stops before a model turn. The native `stageSandboxMedia` owner then receives a clone of that native context and the case's configured channel/account values. For accepted cases, native `createExecTool` executes only `sha256sum` against the actual returned host-workspace staged path. The receipt is emitted only after a completed exec result contains the original checksum.

The unchanged-reference compatibility case clones only the baseline's actual native managed file into the isolated candidate profile, keeping its native media URI, basename and bytes exactly unchanged. It asserts URI equality before staging. This checks compatibility of existing managed references; it is not a full installed-stable configuration/database upgrade test.

## Real transport and QA mapping

This used the already existing local Telegram Bot API, reached through an SSH loopback forward. Its actual getFile response contains a host-local absolute path unavailable on the separate QA host. Only this QA bot's synthetic document was streamed to a task-owned QA mirror and verified byte-for-byte. The exact API-returned QA path was absent; a QA-only directory alias maps that path to the owned mirror. Only that precise document parent is trusted. The native actual getFile response was not mocked or rewritten. This transport mapping is part of the proof setup and is not a product change.

Tokens, raw chat/message/file IDs, API-returned token-bearing path, configuration, raw captured update and raw logs are private and excluded. Public source contains no credential value or production endpoint. Source/message/path identities are hashed in the receipts.

## Reproduce

The [QA harness public copy](native-large-document.mjs) takes explicit checkout/head/run inputs and refuses reuse of an existing profile. The public copy substitutes only two private filesystem literals (the QA task root and token-file suffix) with explicit placeholders. The executed private source is retained. A reproducer must set their own isolated root and token path, captured synthetic document and actual Bot API file. No control flow or API call was changed for publication. No production credentials or state are needed.

```sh
OC_MEDIA_QA_API_ROOT=http://127.0.0.1:APPROVED_FORWARD_PORT node native-large-document.mjs \
  --repo MAIN_CHECKOUT --head c05c277d04326b53858f85e2ea83c16b4756e83b \
  --kind main --run native03

OC_MEDIA_QA_API_ROOT=http://127.0.0.1:APPROVED_FORWARD_PORT node native-large-document.mjs \
  --repo PR_CHECKOUT --head b6e89d0ee6988565f74bc1b82778f8df65196f32 \
  --kind candidate --run native03 --baseline-receipt BASELINE_PRIVATE_RECEIPT
```

Prerequisites and private inputs are enumerated in the harness. A new run name is mandatory for a repeat. No guard, queue or previous state is cleared.

## Scope and exclusions

This is a real Telegram upload/download followed by selected-source native handler/identity/staging/host-exec owner execution. It is **not** the maintained leased Telegram Test Server lane, a complete Gateway polling/model run, Docker/local-sandbox runtime execution, SSH sandbox execution, a 4 GiB stress test, aggregate-budget proof, or installed-stable upgrade. The existing scoped source tests/CI remain separate evidence for ordinary smaller media and unchanged paths; they are not relabelled as newly executed runtime cases.

Two earlier harness attempts are excluded from acceptance: native01 lacked the required exact QA absolute-path mapping; native02 candidate used the obsolete exec argument `timeout` rather than native `timeoutSeconds`. Both failed before a complete accepted staging/tool result. Native03 additionally derives identity from the real handler instead of assigning it manually.

## Maintainer decision still open

The PR's configured per-file allowance up to 4 GiB, increased disk/I/O consumption, absence of aggregate staging budget, and overlap with #169163 remain explicit resource-policy decisions. The existing [maintainer question](https://github.com/openclaw/openclaw/pull/170200#issuecomment-6143543007) is unchanged. Passing this 52 MiB scenario does not answer those policy questions or authorize merging.
