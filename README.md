# AI Change Review

> Review, keep, or undo AI-generated workspace changes in VS Code.

AI Change Review is a local-first companion extension for Codex, Claude Code, Aider, Copilot, formatters, and scripts. Start a session before a task, then review every saved change against that session's baseline. It requires no Git repository, model API key, or AI subscription.

## Features

- Review created, modified, and deleted files from one Activity Bar view.
- Keep or undo a complete file, or a single changed code block.
- Native, theme-aware editor review with inline Keep/Undo controls and green/red pending-change decorations.
- Preserve dirty work that existed before the session started.
- Recover active sessions after a VS Code reload or restart.
- Optional always-on tracking for a workspace.
- Local-only snapshots: no uploads, telemetry, shell commands, or model calls.

## Use

1. Open the workspace the agent will edit.
2. Run **AI Change Review: Start Session** and wait for its baseline to finish.
3. Use Codex, Claude Code, Aider, scripts, or another editor normally.
4. Open the AI Change Review Activity Bar view and inspect pending files.
5. Open a text file to enter the AI Change Review editor. Each changed code block has its own **Keep** and **Undo** controls.
6. Run **AI Change Review: End Session** when done.

### Always-on tracking

Run **AI Change Review: Toggle Always-On Tracking** once for a workspace to keep tracking across VS Code restarts. AI Change Review then restores its saved session automatically; if no session exists, it starts one when the workspace opens. Toggle it again to turn this behavior off.

AI Change Review tracks *all included saved workspace changes* while a session is active. It cannot determine whether a change was made by an agent, you, a formatter, or another process. Avoid unrelated edits during a session.

AI Change Review opens pending created and modified files in VS Code's normal editor, so syntax highlighting, colors, fonts, and accessibility settings follow your selected theme. It adds green/red pending-change decorations and native **Keep**/**Undo** CodeLens controls above each changed block. Deleted files use the dedicated review page because there is no current workspace file to open.

Keeping or undoing a block advances to the next pending change, including a change in another file. Once a file has no pending changes, it leaves the sidebar automatically and remains as final code in the editor.

## Guarantees and limits

- A session captures the workspace as it existed at start, including pre-existing uncommitted changes.
- Snapshots are stored in VS Code extension storage, outside the project, and never uploaded.
- Created, modified, and deleted files support file-level accept/reject. Binary and large files are file-level only.
- Active sessions can be recovered after a reload or restart.
- Unsaved editor buffers are not part of the review baseline. Rejecting a file with unsaved changes requires confirmation.
- Renames are displayed as a deletion and a creation.
- Binary and oversized files support file-level decisions only.
- The extension tracks every included saved workspace change; it cannot attribute an edit to a particular agent, formatter, or person.
- When it detects a Git branch checkout, it offers to reset the review baseline so branch changes are not mistaken for reviewable edits.

## Install

Download the latest `.vsix` from [GitHub Releases](https://github.com/Aryamanraj/ai-change-review/releases), then install it:

```bash
code --install-extension ai-change-review-0.1.0.vsix --force
```

## Development

```bash
npm install
npm run compile
npm run lint
```

Open the folder in VS Code and press `F5` to run an Extension Development Host. Package a VSIX with:

```bash
npm run package
```

## Smoke test the packaged extension

First install the generated VSIX and reload VS Code:

```bash
code --install-extension ./agent-review-0.1.0.vsix --force
```

Run **Developer: Reload Window** from the Command Palette, then open a small throwaway workspace:

```bash
mkdir -p /tmp/agent-review-smoke
printf 'export const value = 1;\n' > /tmp/agent-review-smoke/sample.ts
code /tmp/agent-review-smoke
```

In that new VS Code window:

1. Run **AI Change Review: Start Session** and wait for baseline capture to finish.
2. Change `sample.ts` to `export const value = 2;` and save it.
3. Open the **AI Change Review** Activity Bar view. `sample.ts` should appear under **Modified**.
4. Click it to inspect the diff, then use the visible **Reject File** CodeLens above the current file. Its contents should return to `export const value = 1;`.
5. Change it to `2` again, save, and use **Accept File**. It should remain `2` and disappear from the pending list.
6. Create `new.ts`, save it, and reject it from the **Created** group; it should be deleted.
7. Start another session, make a saved change, run **Developer: Reload Window**, and choose **Recover** when prompted.
