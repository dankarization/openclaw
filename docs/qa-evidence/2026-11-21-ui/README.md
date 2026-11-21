# Synthetic browser QA, 21 November 2026

These are actual Chromium captures from the integration source published at `98112c24b6274d7dd6893f9015432d12523d7000`. The suite used a mock Gateway and synthetic messages/media, including fictional names. It does not establish live Gateway, live Telegram or production deployment behavior.

The browser batch passed 39 cases in five files; nine are lightbox cases and three cover Details. The same integration source passed 101 dictation unit cases and two additional thumbnail privacy cases. The focused thumbnail source is available at `64017a5e5de673a04fae412f819d00f0a761db74`; its 11 changed files match the tested integration files. Exact refreshed-head CI and maintainer acceptance remain separate.

- [Desktop gallery](gallery-desktop.png)
- [Gallery at 390 px](gallery-mobile-390.png)
- [Failed selection at 390 px](selection-error-mobile-390.png)
- [Details retained after closing Subagents](details-after-subagents-close.png)
