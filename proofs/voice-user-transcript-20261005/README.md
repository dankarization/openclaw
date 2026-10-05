# Voice transcript user-history proof, 2026-10-05

Related PR: https://github.com/openclaw/openclaw/pull/163557

## Capture and runtime

The operator sent a real voice note from the Android application at approximately 15:22 Asia/Tbilisi. The supplied Android and WebGUI screenshots show the recognized transcript inside the user message, rather than only an assistant recognition reply or an attachment placeholder.

The actual installed Gateway was OpenClaw 2026.9.8, operator integration commit b2f11f84d189125752c32d45ad0d306853ee7d7c, with stock managed Codex 0.158.0. This was verified from installed build metadata during the test window. The newer a35 operator package was still undergoing native installation; these captures are not attributed to it.

The operator separately confirmed that the transcript remains in both clients after fully refreshing WebGUI and reopening the Android chat. The attached images show the initial display; no separate after-reload screenshot is claimed.

## Images

- [Android](android-user-transcript.png): the transcript appears in the outgoing user bubble.
- [WebGUI](web-user-transcript-redacted-v2.png): the same transcript appears with the original audio attachment in the user turn.

## Privacy and integrity

WebGUI personal names, initials, avatars, device-owner text and the attachment identifier were removed with deterministic opaque masks. OCR was run before and after masking. Original dimensions are preserved; pixel verification found zero changes outside the nine declared redaction regions. The Android image has no protected OCR matches and has zero changed pixels. No generative image editing was used. Original files and private verification records are preserved separately and are not included on this public branch.

## Scope

This is real operator evidence for Android-origin voice transcript visibility in Android and WebGUI, plus the operator's reload/reopen confirmation. It does not prove macOS/iOS rendering, multi-account Telegram STT/echo behavior, latest source-only admission/workspace guards, or denied/revoked upload/conversion paths. The older Telegram delivery-confirmation error visible above the voice message is a separate unresolved reproduction, not evidence of successful final reply delivery.

The exact upstream PR-head CI is tracked separately. Skipped or failing checks are not represented as passing by these screenshots. No source or runtime code is changed by this proof branch.
