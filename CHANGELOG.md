# Changelog

All notable changes to this project are documented in this file.

## 0.1.14 — 2026-07-20

- Make the native, theme-aware VS Code editor the default review surface for created and modified files.
- Open at the current change and advance to the next pending hunk or file after Keep or Undo.
- Keep the dedicated review page only for deleted files, which have no current editor document.

## 0.1.13 — 2026-07-20

- Restore the dedicated unified review layout with inline added/removed code and Keep/Undo toolbars.

## 0.1.12 — 2026-07-20

- Use the native, theme-aware VS Code editor for review, with semantic syntax highlighting and inline Keep/Undo controls.

## 0.1.11 — 2026-07-20

- Show the pending-file count as an Activity Bar badge.

## 0.1.10 — 2026-07-16

- Add theme-aware syntax colors to the inline review editor.

## 0.1.9 — 2026-07-16

- Remove accepted files from the pending sidebar automatically.

## 0.1.8 — 2026-07-16

- Exclude files matched by root and nested `.gitignore` rules from review sessions.

## 0.1.7 — 2026-07-16

- Detect Git branch changes and offer a safe review-baseline reset.
- Add a visible manual reset-baseline action.

## 0.1.6 — 2026-07-16

- Advance to the next pending change after keeping a hunk or file.
- Render completed review files as final code without review controls.
- Make the tracking on/off action visible in the Session actions list.

## 0.1.5 — 2026-07-15

- Add a single sidebar power control to start or end a review session.

## 0.1.4 — 2026-07-15

- Align the extension publisher identifier with the registered Visual Studio Marketplace publisher.

## 0.1.3 — 2026-07-15

- Ship PNG-only artwork to satisfy Visual Studio Marketplace publishing requirements.

## 0.1.2 — 2026-07-15

- Make kept hunks render as normal code in the review editor.
- Advance automatically to the next pending hunk, including in another file.

## 0.1.1 — 2026-07-15

- Replace the generic Activity Bar icon with a dedicated AI change-review mark.

## 0.1.0 — 2026-07-15

- First public release of AI Change Review.
- Review created, modified, and deleted workspace files without Git or an API key.
- Keep or undo individual hunks and complete files.
- Dedicated full-file review view, native CodeLens controls, and theme-aware diff decorations.
- Persistent sessions, recovery after restart, and optional always-on tracking.
