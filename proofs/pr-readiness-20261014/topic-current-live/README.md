# #166011 — current-head Telegram → connected WebGUI acceptance

## Executed source and environment

- Exact published HEAD: `243d553c89f7a4944b03b71da15aacd3ce684af7`.
- Exact tree: `9b6b59c6786faaf1495651c35974aed9c9a6f6e8`.
- Dedicated operator-authorized QA host and separate QA bot; production Gateway, tokens and sessions were not used or changed.
- Native source entry: `node --import ./scripts/tsx.mjs src/entry.ts gateway --port <QA-port>` from that checkout. Config set, config validate and Doctor lint all exited 0. Doctor reported 37 checks and no findings.
- Telegram Web and the connected WebGUI were operated through Computer Use under the authorized operator account. Only synthetic task-owned conversation text is shown. Telegram captures are cropped to the QA conversation; details exposing endpoints/identifiers are closed in GUI captures.
- The existing topic already contained a completed assistant reply, `QA_TOPIC_REPLY_OK`. The source uses the official local mock OpenAI provider for deterministic replies; Telegram intake, metadata commit and connected GUI updates are real.

## Observed acceptance

1. Opened a fresh WebGUI connection after the exact-head QA Gateway was ready. It showed **QA 166011 live fixed A**, with the earlier completed assistant reply visible (09).
2. Renamed the same private Telegram topic to **QA 166011 live fixed B**, without sending a message. The already-connected WebGUI changed both its header and sidebar to B (10); Telegram shows B and its service rename entry (11). No reload, navigation or reconnect was performed in this GUI between steps 1 and 2.
3. Used the GUI's normal rename control to set **QA 166011 manual owner**. Then renamed the native Telegram topic to **QA 166011 channel name C**. The GUI retained the explicit manual label (12), while Telegram shows C (13). Native read-only receipt confirms `topicName=C`, `label=manual owner`, the same session identity and 11 total tokens.
4. Performed one further title-only Telegram rename to **QA 166011 quiet rename D** (15). The GUI retained the manual label (14). The mock provider request journal remained at **30 → 30 records**, with identical last-write timestamp, across the bounded observation interval (2026-10-14T16:47:39.122608+00:00 to 2026-10-14T16:51:17.807481+00:00). This includes the actual incoming rename at 16:48:38 UTC. No new user message or assistant reply appeared.

## Why the publication follow-up was needed

At parent `a8b899d…`, real Telegram title metadata persisted but an already-connected GUI did not refresh until reload. The new commit publishes a metadata lifecycle notification through the existing Gateway broadcaster after the shared metadata writer commits. Native regression contains a real Gateway/WebSocket subscriber, a primed pre-rename session row and a completed assistant transcript: failure before the fix, pass after it; a missing createIfMissing:false session produces neither a new session nor a notification.

The two selected native regression shards passed (68.98 seconds wall); core TypeScript, scoped lint, formatting and native hooks passed. The exact published tree equals the tested native commit tree. Fresh scoped independent review found no actionable P0–P2 finding. This browser artifact supplies the live Telegram → committed metadata → connected GUI acceptance separately from those regressions.

## Limits and excluded setup observations

- The first GUI tab had been opened against the previous QA revision and was kept alive across a Gateway process/revision replacement. Its cached connection/build state remained stale during rename A. That attempt is **not** represented as passing current-head live acceptance. A fresh connection to the exact current source was established before the accepted A→B test. This report does not claim cross-version long-lived browser reconnect compatibility.
- An initial attempt to assert a globally unchanged model-request counter across manual-label step C was inconclusive: the QA Gateway's scheduled main-session heartbeat and background activity recaps added three records. They are not relabeled as zero requests. The separate quiet D interval above measures a genuinely unchanged counter; no config/heartbeat guard was disabled to obtain it.
- A diagnostic CLI WebSocket attempt without a device identity was rejected before sessions.list. It supplies no transport proof. The actual accepted observations use the normal connected GUI.
- Earlier stable-based integration screenshots and the old causal report remain historical evidence, not current-head execution. This artifact does not claim full before/during/after model phases on the new source; it directly tests the required post-reply connected update, manual-label priority and a title-only no-model-request interval.
- The QA topic was reused for the separately documented #162565 synthetic audio proof; that older synthetic traffic appears in Telegram captures and is unrelated to title acceptance.

## Files

- 09: current-head GUI before live rename B.
- 10/11: paired already-connected GUI and Telegram after B.
- 12/13: manual GUI label versus Telegram C.
- 14/15: manual GUI label versus quiet Telegram D.
- `receipt.json`: source/startup, native committed metadata and bounded mock-request counter evidence; routing identifiers replaced by SHA256.

No proof-sufficient or merge-readiness label is self-assigned; maintainer review should evaluate these artifacts.
