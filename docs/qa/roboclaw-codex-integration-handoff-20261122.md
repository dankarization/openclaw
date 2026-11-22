# OpenClaw upgrade handoff — public sanitized copy

**Sanitized handoff, updated 2026-11-22.** This file contains no private paths, human names, account identifiers, infrastructure hostnames/IPs, session identifiers or authentication details. No Team upload or receipt is claimed.

## Release state

- **RC5:** public source commit `4a2a3d472c599ee245dadacbace964d783eaa28c`, tree `49f59e0497cef3c4f2bdb72dc84566d9c31a12a8`. Official validator, full build, core typecheck and isolated built-artifact smoke passed. Build ID: `2026.11.6-4a2a3d472c59-2026-11-22T00-56-31.109Z`. The smoke verified readiness, `sessions.list` and `models.list` RPCs, and four served UI assets matching the build. The owning follow-up suite passed 14/14; an isolated loopback actual-Gateway proof passed 1/1.
- A C531 actual-Gateway proof also passed on matching product-runtime code; it did not cover the later-found unknown-transport/revocation P2, which RC5 fixes. The RC5 Gateway proof uses a scripted loopback provider. It demonstrates a spawned child, positive follow-up and dispatch-boundary refusal; it does not demonstrate a live external provider, Telegram delivery or an end-to-end timeout/revocation race. The race regression passed at its owning mocked boundary.
- **Deployment:** RC5 is not installed. C531 is inactive, never installed, and still contains the known unknown-transport/revocation P2 fixed by RC5. Production remains on the prior R3 release.
- **Storage blocker:** three native capture attempts stopped before Doctor and before a valid backup receipt because of generic ext4 journal/capture stalls. No fourth attempt has been made. Partial captures are not rollback images. Do not cut over until a durable backup, Doctor/migration receipt and release acceptance are available. The old RC4 plan is superseded; do not reuse its supervisor.

## RC5 source provenance

RC5 inherits 13 reviewed integration PR scopes recorded in RC4 metadata: #198725, #198734, #198735, #198829, #198832, #198849, #198845, #198825, #198815, #199557, #199455, #200155 and #198119. These are integration ports or upstream replacements; this list does not claim byte-identical content from every canonical PR head. RC5 retains the prior R3 patches. Its source lineage records pinned main base `a484…` and prior R3 patch base `c538…`; it is not a floating latest-main or pristine stable branch. In particular, #198845 is already represented in the integrated source and is not an additional later overlay candidate.

## PR and incident handoff

| Area | Current evidence | Remaining gate |
|---|---|---|
| OpenClaw PR #200155 | Upstream head remains `f78ef5226a8dc0cee020adbc0ca342d49b1f9b47`. Focused adoption branch is `93b8333148bbff64e5bc37aded7a6ab285a2bb6b` on base `a48440bbdf3e1f827e72eb7d674b63bcbb2fe4cf`; RC5 integrates the four-file race fix. Fourteen owning tests, focused core types, and the RC5 loopback proof passed. The published adoption note is [here](https://github.com/openclaw/openclaw/pull/200155#issuecomment-7071879074). | Existing PR owner must adopt the source, then rerun checks on the resulting exact upstream head. No combined status contexts were returned for the focused/RC5 commits. No merge or production acceptance is claimed. |
| Issue #202741 | Delivery incident remains open. Sanitized role/session-creator context is approved and published in the [issue discussion](https://github.com/openclaw/openclaw/issues/202741); the qualified synthetic proof is [comment 7070450003](https://github.com/openclaw/openclaw/issues/202741#issuecomment-7070450003). | The remaining maintainer ask is proof of final external Telegram attachment delivery. Synthetic loopback evidence does not satisfy it; keep the issue open. |
| PR #198825 | Focused fork update exists at `22b0d586ecba1f046955d20099bceee0778d7b4c`; UI unit and built-browser checks passed on the combined candidate, not as exact-head proof. | Upstream PR reports a merge conflict and pending CI. Adopt/rebase the focused change and obtain exact-head CI/review. |
| PR #199455 | Current upstream head `4caed6730919c4bbba9ae77bfe1373356ead8671`; earlier tests were on a prior base. | Current-head combined CI showed failure in the prior snapshot; maintainer review and exact-head acceptance remain open. Job-level cause was not refreshed here. |
| Agent-mail router PR #6 | Final PR #6 source commit `eb8eeb0178c2a5f67caa0a11dcf864366dee879a` is installed per the actual guarded receipt. All four PR #6 review threads were replied to and resolved by the author after the verified fix; this does not imply maintainer approval. | Linux Python check: 581 total, 9 skipped, no failures; final Node suite: 19 pass / 8 optional skip; helper: 7/7 pass. Timer active; Gateway unchanged. Actual configured-classifier QA received the full 77-session catalog but the result was held as invalid_output; one classifier call, zero chat.inject calls. A classifier-only diagnostic is in progress; delivery is not accepted. A prior `mail-delivery_held` context remains outcome-unknown; do not blind-resend or close its incident. Mail hosted CI was not refreshed in this handoff. Do not call classifier selection or external delivery complete. |

## Candidate overlays and test gate

- Candidates for later release-specific evaluation: merged Doctor PRs #192406/#192407; merged #198387 (`reasoning: none`, reported absent from stable 2026.11.6); SQLite cache #195292; subagent yield #197335. These are implementation candidates, not installation or cherry-pick approval. #198845's scope is already in RC5 provenance above.
- **Android: TEST ONLY LAST.** No Android build, emulator run, SDK/cache discovery or download was done. If validation is needed, run it only after all non-Android gates and keep it test-only.
- The inventory snapshot is limited to 34 screenshot PRs and 30 screenshot issues, with connector capture at 2026-11-22 00:44–00:45 UTC. A separate related-work refresh followed around 01:06 UTC. Combined checks are not full Actions-job enumeration; historical records beyond the screenshot scope are not claimed current.

## Evidence boundaries

| Claim class | Current qualification |
|---|---|
| Source reviewed | Targeted candidate source, selected PR metadata and current PR #6 review threads; not a complete source review of every inventory item. |
| Tested | RC5 official build/typecheck/artifact smoke; owning tests and loopback Gateway proof as scoped above. Final mail source receipts: Python 581/9 skipped, Node 19/8 optional skipped, helper 7/7. Actual-classifier QA held invalid output; zero delivery calls. |
| CI | Screenshot metadata is a bounded combined-status snapshot. Mail hosted CI was not refreshed; author-resolved review threads do not imply maintainer approval. |
| Installed | RC5/C531 not installed. Final PR #6 source is installed per guarded receipt; timer active and Gateway unchanged. Actual-classifier selection is not accepted; external delivery remains unproven. |

The source publication and existing #200155/#198825 comments predate this handoff update. Publication of this sanitized handoff is tracked separately; source publication and test results do not establish delivery to the Team conversation.

## Recoverable cleanup

Fourteen owned incomplete native payload files, about 9.16 GiB, were moved normally to private recoverable Trash. Active state, builds, manual recovery materials, logs and receipts were retained. No content/hash reconciliation or Trash emptying was performed.
