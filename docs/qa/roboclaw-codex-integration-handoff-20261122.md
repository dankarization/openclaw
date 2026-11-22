# OpenClaw upgrade handoff — public sanitized copy

**Sanitized handoff, updated 2026-11-22.** This file contains no private paths, human names, private account identifiers, infrastructure hostnames/IPs, session identifiers or authentication details. No Team upload or receipt is claimed.

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
| OpenClaw PR #200155 | Upstream head remains `f78ef5226a8dc0cee020adbc0ca342d49b1f9b47`. Focused adoption branch is `93b8333148bbff64e5bc37aded7a6ab285a2bb6b` on base `a48440bbdf3e1f827e72eb7d674b63bcbb2fe4cf`; RC5 integrates the four-file race fix. Fourteen owning tests, focused core types, and the RC5 loopback proof passed. The published adoption note is [here](https://github.com/openclaw/openclaw/pull/200155#issuecomment-7071879074). | Fresh metadata still reports this head with a merge conflict. Existing PR owner must adopt/rebase the source, then rerun checks on the resulting exact upstream head. No combined status contexts were returned for the focused/RC5 commits. No merge or production acceptance is claimed. |
| Issue #202741 | Delivery incident remains open. Sanitized role/session-creator context is approved and published in the [issue discussion](https://github.com/openclaw/openclaw/issues/202741); the qualified synthetic proof is [comment 7070450003](https://github.com/openclaw/openclaw/issues/202741#issuecomment-7070450003). | The remaining maintainer ask is proof of final external Telegram attachment delivery. Synthetic loopback evidence does not satisfy it; keep the issue open. |
| PR #198825 | Focused fork update exists at `22b0d586ecba1f046955d20099bceee0778d7b4c`; UI unit and built-browser checks passed on the combined candidate, not as exact-head proof. | Upstream PR reports a merge conflict and pending CI. Adopt/rebase the focused change and obtain exact-head CI/review. |
| PR #199455 | Current upstream head `4caed6730919c4bbba9ae77bfe1373356ead8671`; earlier tests were on a prior base. | A fresh metadata read still has this head but now reports a merge conflict; prior CI also required maintainer action. Rebase/adopt the reviewed change and obtain exact-head checks; maintainer review and exact-head acceptance remain open. Job-level cause was not refreshed here. |
| Agent-mail router PR #6 | Final [source 826ebca](https://github.com/dankarization/agent-mail-router/commit/826ebcadabadc7c516e14ea21e32ad7f6cf49275) is installed. Guarded activation passed the actual workspace validator; settings, scope and Gateway process stayed unchanged, rollback was unnecessary. Exact final Linux check: 585 total, 9 skipped, no failures; Node suite: 31 passes / 8 optional skips; helper 7/7. Final evidence excerpts preserve Unicode token boundaries within 160 UTF-8 bytes; a Node-to-Python regression covers a formerly split grounding word. Final configured-model classifier-only QA selected the expected session at high confidence from all 77 authorized sessions with verbatim evidence and zero injection. On the preceding ef5d207 revision, whose Python/delivery code is unchanged in 826ebca, one explicitly synthetic passive injection had a current-incarnation receipt and matching chat.history message/marker; re-entry and duplicate Message-ID ingest were suppressed. The final normal worker exited 0; timer active. All five observed review findings are author-resolved. | This is synthetic context-routing QA, not fresh external IMAP/SMTP or task execution. No second message was injected for final-r6 acceptance. One older context effect remains interrupted_after_intent with no receipt; bounded history did not prove delivery or nondelivery. Do not replay/reset it or close the incident. Existing caches, held records and journals were retained. Hosted CI/maintainer approval is not claimed. |

## Additional ownership gates

- **#198119:** the v3 integration scope in RC5 passed 172 focused unit cases and two isolated Gateway cases. This does not establish installation in the running R3 release. The [corrected compatibility note](https://github.com/openclaw/openclaw/pull/198119#issuecomment-7066170588) withdraws an unsupported rollback interpretation: the real older release refused the newer schema. Do not present the frozen 175c/a8ba repair as accepted, infer authority from IDs, or remove authority on downgrade. Canonical adoption, compatibility/security review and production acceptance remain distinct.
- **#198785 / #198388:** the older draft is not admitted as the complete dual-surface repair. The owner still needs to publish the complete source and prove actual history/live/reload visibility and no duplicates; saved delivery-mirror data alone is insufficient.
- Adoption source is accessible in the [#200155 focused commit](https://github.com/dankarization/openclaw/commit/93b8333148bbff64e5bc37aded7a6ab285a2bb6b) and [#198825 focused commit](https://github.com/dankarization/openclaw/commit/22b0d586ecba1f046955d20099bceee0778d7b4c). Preserve existing author ownership; do not overwrite the RoboClaw branches blindly.

## Candidate overlays and test gate

- Candidates for later release-specific evaluation: merged Doctor PRs #192406/#192407; merged #198387 (`reasoning: none`, reported absent from stable 2026.11.6); SQLite cache #195292; subagent yield #197335. These are implementation candidates, not installation or cherry-pick approval. #198845's scope is already in RC5 provenance above.
- **Android: TEST ONLY LAST.** No Android build, emulator run, SDK/cache discovery or download was done. If validation is needed, run it only after all non-Android gates and keep it test-only.
- The inventory snapshot is limited to 34 screenshot PRs and 30 screenshot issues, with connector capture at 2026-11-22 00:44–00:45 UTC. A separate related-work refresh followed around 01:06 UTC. Combined checks are not full Actions-job enumeration; historical records beyond the screenshot scope are not claimed current.

## Evidence boundaries

| Claim class | Current qualification |
|---|---|
| Source reviewed | Targeted candidate source, selected PR metadata and current PR #6 review threads; not a complete source review of every inventory item. |
| Tested | RC5 official build/typecheck/artifact smoke, 14 owning tests and one isolated loopback Gateway proof as scoped above. Mail exact final source: official 585 total / 9 skipped; Node 31 passed / 8 optional skips; helper 7/7; configured-model full-catalog classifier-only acceptance passed. Earlier ef5d207 model-to-history/dedup proof applies to unchanged Python/delivery code; it was not repeated on r6. |
| CI | Screenshot metadata is a bounded combined-status snapshot. Final mail PR-triggered Actions first-page lookup returned no runs. No full Actions enumeration or maintainer approval is inferred; author-resolved threads are separate. |
| Installed | Gateway remains R3; RC5/C531 are not installed. Mail 826ebca is installed and its normal worker completed successfully; Gateway stayed ready without restart. Fresh external-mail delivery remains unproven. |

The source publication and existing #200155/#198825 comments predate this handoff update. Publication of this sanitized handoff is tracked separately; source publication and test results do not establish delivery to the Team conversation.

## Recoverable cleanup

Fourteen owned incomplete native payload files, about 9.16 GiB, were moved normally to private recoverable Trash. Active state, builds, manual recovery materials, logs and receipts were retained. No content/hash reconciliation or Trash emptying was performed.

Final handoff update: 2026-11-22T02:52:37.090866+00:00 UTC. A fresh metadata read of #200155, #198825 and #199455 retained the heads above and reported merge conflicts for all three. The broader screenshot inventory remains its explicitly dated snapshot.

Mail final-r6 acceptance update: 2026-11-22 03:09 UTC. The normal worker exited successfully after guarded activation, without a Gateway restart. The canonical PR conflict snapshot above remains dated 02:52 UTC.
