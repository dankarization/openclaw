# Replay preservation on installed 2026.10.2

This is executed SQLite/channel-boundary evidence for PR #162565, not real Telegram transport acceptance.

## Source binding

- PR head: `53bfd434bfe35bd7e00c240df9c01b77c505db49`.
- Stock release: `b8952d477f0c932d8ddc6da5c89cab5a169b6ff1` (v2026.10.2).
- Installed integration: `6c3111c1101ccd99a5167436364fd6e591a1c640`.
- [Public package-equivalent source](https://github.com/dankarization/openclaw/tree/7c7f50cfc6576b623208bb244b2e452f3d4490d9), tree `74d9fa821d46f02bb98c54b5032a6de926d87346`.
- The entire echo owner has the same Git blob `1e55cc1ec49ca35a2063be470ba6b64b921c70e9` on the PR and installed source. Surrounding release owners differ; this is not an exact whole-PR runtime.
- [Executed test source](https://github.com/dankarization/openclaw/blob/7c7f50cfc6576b623208bb244b2e452f3d4490d9/src/media-understanding/echo-transcript.integration.test.ts), blob `1cfa9eeeefb0795e9c28b8ff6f04fa6a8d5fa34b`.

## Actual observations

Native infra/fork execution passed three tests using a real temporary SQLite outbound queue and a fake Telegram channel adapter:

1. Concurrent processing and completed replay, including canonical group/direct-topic target aliases, cause one adapter send.
2. Deferred account-admitted echo retains the source message identity: repeated identity causes one send; a new identity causes a second send.
3. Separate messages, accounts and chats with identical transcript text cause four independent sends.

The first and third cases are the existing PR contracts. The second tests composition with the separately carried shared-STT/account-admission SDK path.

Execution used the existing infra worker configuration. Tests and assertions were unchanged for this run. Exit 0; 3/3; 72.3 seconds wall (Vitest reported 70.87 seconds). `execution-summary.txt` is a sanitized transcription of terminal output. `receipt.json` binds the original private log checksum without publishing infrastructure paths or data.

The native update installed this source and the Gateway reports 2026.10.2, with health and readiness HTTP 200. The original update failed during post-publication Doctor snapshot stabilization; native repair subsequently completed with warnings. This is not an all-success updater contention cell.

## Remaining gates

- No genuine Telegram same-source replay/restart or interrupted API send was executed here.
- Existing accepted [two-process queue upgrade proof](https://github.com/dankarization/openclaw/blob/4b67ba8113df6612e307816e9c73fdd12803f659/proofs/replay-process-upgrade-20261007/README.md) remains separate.
- Maintainer acceptance of required durable admission and 24-hour / 2,000-entry completion retention is still required.
- A fresh voice note or forwarded note has a new source identity and cannot substitute for replay proof.
