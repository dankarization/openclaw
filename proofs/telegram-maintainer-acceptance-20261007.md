# Remaining Telegram acceptance: maintainer QA handoff

This is a verification request, not an executed test or a claim of merge readiness. No production Gateway token, Telegram account, bot, audio, or state is required or requested.

## Native lane and authority

Use the exact checkout/ref under test and its `.agents/skills/telegram-e2e-userbot/SKILL.md`. The maintained runner owns an isolated Gateway, real Telegram Test Server bot, independently authorized TDLib user, exclusive Convex lease, proxy, recording, and cleanup. Do not substitute a second bot's API receipt for the user's observation. Keep a lease throughout setup, execution and cleanup. The generic text baseline does not cover these features; the inspected driver exposes text/photo sends, so audio, replay and private-topic actions may need a dedicated scenario/driver extension rather than an invented existing command.

The operator environment was checked on Mac and Linux: installed convex/bunx absent, existing npx offline cache unavailable, explicit broker variables absent. No install, login, credential acquisition or Test Server run was performed. The runtime guide allows broker discovery only through existing authenticated launchers or privately supplied owner credentials. This is access/tool readiness, not a proved invalid credential or failed network service.

## PR #162565 — source 53bfd434bfe35bd7e00c240df9c01b77c505db49

1. Send a synthetic real-user voice note and record the source account/chat/message identity plus actual SUT transcript-echo messages observed by TDLib.
2. Exercise repeated processing of that SAME inbound source message through the owned ingress/replay path. Forwarding or resending creates another message ID and cannot prove deduplication. Observe exactly one echo for the repeated identity.
3. Send a second independent message with identical audio/text. Its distinct message ID must receive its own echo; record both original message relationships.
4. After completed delivery, replace only the run-owned Gateway process, retaining its owned state. Replay the original identity and verify no new echo while the independent message remains independently deliverable. Preserve failed/uncertain observations; no blind resend.
5. Keep the already accepted two-process SQLite upgrade artifact as storage evidence. Its fake adapter does not replace these Telegram observations. Addressed-bot-only echo acceptance belongs to #146348, not this PR.

Maintainer decisions still required: whether keyed echo should refuse live-only fallback after durable admission failure; whether 24-hour / 2,000-entry namespace receipt retention is acceptable. Do not weaken these policies solely to clear labels. This request does not propose a new retention/config/schema contract.

## PR #166011 — source bdc8bf4d8e50d44df3e2fafd150235eabb955936

1. Use a real private bot topic and an authenticated client connected to the isolated Gateway. Record its native Telegram identity and the matching canonical session.
2. Rename before a model turn, during a real model request, and after its reply. Observe the actual Telegram rename update, committed session metadata and connected session-list change together, preserving routing identity and explicit user labels.
3. Retain an existing New Chat entry plus an explicit manual-label control through the run-owned restart. Rename again; the unlabeled entry must follow topicName while the manual label stays highest priority.
4. Verify account-scoped persisted topic cache recovery with the maintained fixture/lease owners. The published core-state diagnostic preserves distinct account/thread metadata; it does not prove identical-coordinate account-cache isolation. Existing cache CI cases are supplemental, not live transport proof.
5. The operator already accepted fresh-chat renames on the serving 9.8 integration. That is useful human evidence, but is deliberately distinct from this current-main source port. The new process-upgrade diagnostic addresses core retained-state/title/label compatibility, not the entire connected-client flow.

## Publishable evidence and cleanup

Record source/build identity, sanitized native command, actual user actions and post-action TDLib observations, relevant committed-state/list events, model request presence where applicable, process replacement, and conclusions for each case. Inspect real client screenshots for visible claims; event logs are not visual screenshots. Remove private endpoints, account/chat IDs, credentials and recovery material from public evidence. Confirm all runner-owned children/listeners exited, lease released and credential scratch removed; retain uncertain cleanup as failure, not success.
