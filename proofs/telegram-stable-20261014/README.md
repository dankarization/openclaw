# Telegram title and quoted-audio ports on 2026.10.2

Checked October 14, 2026. This is source-identified deployment and focused boundary evidence, not new authenticated Telegram acceptance.

## Source and serving identity

Stock release: v2026.10.2, `b8952d477f0c932d8ddc6da5c89cab5a169b6ff1`.
Installed integration: `6c3111c1101ccd99a5167436364fd6e591a1c640`, tree `74d9fa821d46f02bb98c54b5032a6de926d87346`.
Public package-equivalent source: [7c7f50cfc6576b623208bb244b2e452f3d4490d9](https://github.com/dankarization/openclaw/tree/7c7f50cfc6576b623208bb244b2e452f3d4490d9).
The public commit has a different commit SHA because of publication metadata; its complete source tree is identical.

The authorized operator Gateway is now serving this integration. Health, readiness and WebGUI checks succeeded. Its stock managed Codex dependency remains 0.160.0. No additional QA server or credential was created.

## #166011: private topic titles

PR head: `9dc17035535d9256689425164f806e169f1e4621`.

The release port preserves the existing account-scoped topic cache, native metadata write, committed rename notification and display priority. Explicit GUI labels remain authoritative. Title-only service events update existing metadata without creating a session or invoking the model.

Focused release-port proof completed on `b78e4dcc8dea78ae55fc93b18a7a1d52ff349ab5`: 17 Telegram/cache cases, 23 origin metadata cases, one accessor notification case and one display-priority case passed (42 total). The focused accessor/display runs deliberately selected one case each; respectively 71 and 104 other cases were skipped, not claimed passed. Source blobs in the six inspected production owners are unchanged between that tested source and the installed `6c3111c`.

Previously published retained-SQLite/manual-label evidence and the October 7 operator screenshots remain their original source scopes. They are not relabelled current-port Telegram proof.

Remaining live gate: actual Telegram intake → committed rename → connected list refresh, without an additional model turn, including explicit manual-name priority. The existing maintainer-owned QA request remains applicable.

## #166640: quoted audio

PR head: `50d631dd248586d3e4e5fdf1a84a92a1d99d2f4d`.

All six production quote-provenance owners, including the writer/input-type/reconstruction followup, are now installed. This corrects the older October 7 deployment status that said the writer followup was not installed. Quote markers survive persistence and reconstruction; quoted STT remains model context; only current-message audio is selected for echo.

Stock v2026.10.2 lacks the `source: "quote"` contract in the inspected media-facts, transcript-message, normal transcription and audio-preflight owners. Therefore the release does not supersede this repair.

Focused persisted-media suite: 22/22 passed in 76.8 seconds, including `preserves quote provenance through transcript write, reload and reconstruction`. Three normal-transcription assertions passed for quoted-only input, mixed quoted/current input, and original-index provenance after an invalid earlier attachment. The six quote production owners and persisted-media test blob are byte-identical between tested `b78e4dcc` and installed `6c3111c`.

The original combined media run had three durable-replay broker failures (64 passed / three failed); these are not hidden or described as a green run. The same three durable cases passed separately in the maintained forked infra lane on `6c3111c`, 72.3 seconds. Replay proof belongs to #162565 and does not substitute for Telegram quote delivery.

Remaining live gate: one initial echo; no extra echo from an admitted quoted-only text reply; mixed current/quoted voice echoes only the new audio while retaining quoted context; distinct new voice notes with identical transcripts remain independently eligible. A legitimate reply from another bot pipeline is excluded from this bot's echo count.

## Access boundary and readiness

The authorized WebGUI connection is usable. No matching authorized Telegram operator identity was available through the current browser surface. No messages, topic renames or manual-name changes were sent for this audit. No private account identities, transcripts or credentials are published.

Both upstream PRs currently report merge conflicts. Historical green CI is retained as historical evidence, not current merged-main proof. No source conflict resolution, CI rerun, proof-sufficient label override or readiness claim is made by this artifact.
