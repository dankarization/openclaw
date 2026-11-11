# Live managed-child check after parent yield

Captured on 2026-11-11 from a running OpenClaw 2026.11.3 Gateway, deployment commit `16c7223`. The parent and child used the configured Codex runtime; transcript records identify `codex-app-server` as their source. These are selected actual Gateway history records, not mocked tool responses. Private routing and run identifiers are omitted.

All times below are UTC+4.

| Time | Recorded event | Actual result |
| --- | --- | --- |
| 21:41:48 | Parent `sessions_yield` returned | `{"status":"yielded"}` |
| 21:41:54 | Child ordinary shell call returned | `DELEGATION_BEFORE_20261111` |
| before 21:42:36 | Child wait returned | `Wall time: 35.0121 seconds; Sleep completed.` |
| 21:42:36 | A separate child shell call returned | `DELEGATION_AFTER_20261111` |
| 21:42:39 | Child finished | `CHILD_DONE_20261111` |
| 21:42:52 | Automatic requester-settle continuation finished | `DELEGATION_PASS_20261111` |
| Later, same parent session | New user turn completed | `FOLLOWUP_PASS_20261111` |

The automatic parent continuation said:

```text
DELEGATION_PASS_20261111

DELEGATION_BEFORE_20261111
DELEGATION_AFTER_20261111
CHILD_DONE_20261111

Verified separate shell calls with a 35.0121-second wait. Managed completion resumed this session successfully.
```

This checks real managed `sessions_spawn` after yield and a subsequent user turn. It does not test a native Codex helper, Telegram delivery of this completion, a reload racing admission, or final tool/delivery effects after authority revocation. Those require separate evidence. The Telegram reset/model-selection screenshot is a different live check.
