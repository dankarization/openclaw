# PR #166640 — current-main quote provenance, 2026-10-14

Source: [0d33d13c5206](https://github.com/dankarization/openclaw/commit/0d33d13c5206512f8e712a53b7362c402c454317); full tree `4b62f4e2a644bb0c60bbd411d97c28b20b629680`.
Parents: prior contributor head `50d631dd248586d3e4e5fdf1a84a92a1d99d2f4d` and pinned main `04f2e80e9a172c4decdc4c2c37fb261c78ea53fa`. GitHub verified the prior fork base is an ancestor of this main; public branch advancement was checked and fast-forward only.

## Conflict repair

Resolved two overlapping test edits and the transcript reconstruction setter. Main's typed setter remains, and tests already retired by main are not resurrected. The PR's quote provenance, echo filtering and ordinary writer/reconstruction behavior remain. The introduced delta is ten files, +196/-4.

## Executed checks

```text
node scripts/run-vitest.mjs src/channels/inbound-event/context.test.ts src/media-understanding/apply.test.ts src/media-understanding/audio-preflight.test.ts src/sessions/user-turn-transcript.media.test.ts --maxWorkers=1
unit-fast: 12 passed
media-understanding: 42 passed
channels: 19 passed
total: 73 passed, 4 files / 3 shards
exit: 0; wall: 197.1 seconds
```

Native tests ran on exactly the reviewed tree with all ten source blobs rechecked after execution. Ordinary scoped Oxlint passed: 10 files, 258 rules, zero warnings/errors, 3.0 seconds. Formatting and whitespace checks passed. Canonical independent P0–P2 review was scoped-clean (confidence 0.84); source content was unchanged afterward and execution/review trees matched.

The initial separate checkout failed before assertions because external-symlink dependency reuse omitted extension-local quickjs-wasi; type-aware lint separately refused declarations outside that checkout. The complete candidate was moved into an existing fully installed checkout, with verified full-tree equality. Native guards, configurations and assertions were retained. No guard bypass or additional dependency installation was used. Type-aware lint was not rerun and is not reported as passed. Hosted CI belongs separately to the newly published source head.

## Still required

These native tests are not actual Telegram delivery observations. Quoted-only text, fresh voice, mixed current/quoted audio with quoted context retained, and independent new notes with identical transcript text still need source-bound delivery/count evidence. The earlier stable preservation artifact remains scoped storage/composition proof.

No production Gateway, credentials, configuration, bundled Codex or APK were changed. No QA server was created.
