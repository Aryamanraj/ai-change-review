import * as vscode from "vscode";
import { BaselineProvider } from "./baselineProvider";
import { ReviewTreeProvider } from "./reviewTree";
import { ReviewCodeLensProvider } from "./reviewCodeLens";
import { ReviewPanel } from "./reviewPanel";
import { DecorationController } from "./decorationController";
import { SessionManager } from "./sessionManager";
import { SnapshotStore } from "./snapshotStore";
import { FileRecord } from "./types";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("AI Change Review");
  const store = new SnapshotStore(context);
  const manager = new SessionManager(store, output);
  const provider = new BaselineProvider(store, uri => manager.record(uri));
  const tree = new ReviewTreeProvider(manager);
  const treeView = vscode.window.createTreeView("aiChangeReview.changes", { treeDataProvider: tree });
  const codeLens = new ReviewCodeLensProvider(manager);
  const decorations = new DecorationController(manager);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "aiChangeReview.openReview";
  const refreshStatus = () => {
    const pending = manager.pendingStats();
    treeView.badge = pending.files
      ? { value: pending.files, tooltip: `${pending.files} file${pending.files === 1 ? "" : "s"} pending review` }
      : undefined;
    status.text = manager.active ? `$(diff) AI Change Review: ${pending.files} file${pending.files === 1 ? "" : "s"} · $(add) ${pending.added} $(remove) ${pending.removed}` : "$(eye) AI Change Review: OFF";
    status.tooltip = manager.active ? "Open pending AI Change Review changes" : "Start AI Change Review";
    status.show();
  };
  manager.onDidChange(() => {
    refreshStatus();
    void vscode.commands.executeCommand("setContext", "aiChangeReviewActive", manager.active);
  });
  refreshStatus();
  void vscode.commands.executeCommand("setContext", "aiChangeReviewActive", manager.active);
  const fileArg = (arg?: unknown): FileRecord | undefined => {
    if (typeof arg === "string") { return manager.record(arg); }
    if (arg && typeof arg === "object" && "recordUri" in arg && typeof (arg as { recordUri?: unknown }).recordUri === "string") {
      return manager.record((arg as { recordUri: string }).recordUri);
    }
    return undefined;
  };
  const showError = (error: unknown) => { output.appendLine(String(error)); void vscode.window.showErrorMessage(`AI Change Review: ${error instanceof Error ? error.message : String(error)}`); };
  type ReviewTarget = { record: FileRecord; hunkId?: string };
  /** Native editor flow, used when reviewing from a normal workspace editor. */
  const openNativeReview = async (target: ReviewTarget): Promise<void> => {
    const { record, hunkId } = target;
    if (record.changeType === "deleted" || record.kind !== "text") {
      ReviewPanel.open(manager, record);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(record.uri));
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const hunks = await manager.hunks(record);
      const hunk = hunks.find(item => item.id === hunkId) ?? hunks[0];
      if (hunk) {
        const line = Math.min(hunk.currentStart, Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (error) {
      output.appendLine(`Could not open native review for ${record.label}: ${String(error)}`);
      ReviewPanel.open(manager, record);
    }
  };
  const hunkIndex = async (record: FileRecord, hunkId?: string): Promise<number> => {
    if (!hunkId || record.kind !== "text") { return 0; }
    return Math.max(0, (await manager.hunks(record)).findIndex(hunk => hunk.id === hunkId));
  };
  /**
   * Land on the change that took the reviewed one's place, so review keeps
   * moving forward. Only the reviewed file is re-diffed: enumerating hunks for
   * every pending file made a single decision cost one diff per changed file.
   */
  const advanceAfter = async (uri: string, index: number): Promise<void> => {
    const record = manager.record(uri);
    if (record?.changeType) {
      if (record.kind !== "text") { await openNativeReview({ record }); return; }
      const hunks = await manager.hunks(record);
      if (hunks.length) { await openNativeReview({ record, hunkId: hunks[Math.min(index, hunks.length - 1)].id }); return; }
    }
    const next = manager.nextPendingRecord(uri);
    if (next && next.uri !== uri) { await openNativeReview({ record: next }); }
  };
  const endSession = async (): Promise<void> => {
    if (!manager.active) { return; }
    const pending = manager.records().length;
    if (pending) {
      const choice = await vscode.window.showWarningMessage(`${pending} pending file${pending === 1 ? "" : "s"} remain.`, "Accept all and end", "Reject all and end", "Keep recovery snapshot", "Cancel");
      if (choice === "Accept all and end") { await manager.acceptAll(); await manager.end(true); }
      else if (choice === "Reject all and end") { await manager.rejectAll(); await manager.end(true); }
      else if (choice === "Keep recovery snapshot") { await manager.end(false); }
    } else { await manager.end(true); }
  };
  const commands: [string, (...args: any[]) => any][] = [
    ["aiChangeReview.toggleSession", () => manager.active ? endSession() : manager.start()],
    ["aiChangeReview.startSession", () => manager.start()],
    ["aiChangeReview.refresh", () => manager.reconcile()],
    ["aiChangeReview.resetBaseline", () => manager.resetBaseline()],
    ["aiChangeReview.openReview", () => { if (!manager.active) { return manager.start(); } return vscode.commands.executeCommand("workbench.view.extension.aiChangeReview"); }],
    ["aiChangeReview.openFileDiff", async (uri?: unknown) => {
      const record = fileArg(uri);
      if (!record) { return; }
      if (record.kind !== "text") { void vscode.window.showInformationMessage("Binary and large files support file-level acceptance or rejection only."); return; }
      // Selecting an item in the AI Change Review sidebar is an explicit
      // request for the richer review panel. Opening the workspace file via
      // VS Code's normal UI continues to use the native editor.
      ReviewPanel.open(manager, record);
    }],
    ["aiChangeReview.acceptFile", async (uri?: unknown) => {
      const record = fileArg(uri); if (!record) { return; }
      await manager.accept(record); await advanceAfter(record.uri, 0);
    }],
    ["aiChangeReview.rejectFile", async (uri?: unknown) => {
      const record = fileArg(uri); if (!record) { return; }
      await manager.reject(record); await advanceAfter(record.uri, 0);
    }],
    ["aiChangeReview.acceptHunk", async (uri?: unknown, hunkId?: string) => {
      const record = fileArg(uri); if (!record || !hunkId) { return; }
      const index = await hunkIndex(record, hunkId);
      await manager.acceptHunk(record, hunkId); await advanceAfter(record.uri, index);
    }],
    ["aiChangeReview.rejectHunk", async (uri?: unknown, hunkId?: string) => {
      const record = fileArg(uri); if (!record || !hunkId) { return; }
      const index = await hunkIndex(record, hunkId);
      await manager.rejectHunk(record, hunkId); await advanceAfter(record.uri, index);
    }],
    ["aiChangeReview.acceptAll", () => manager.acceptAll()],
    ["aiChangeReview.rejectAll", () => manager.rejectAll()],
    ["aiChangeReview.toggleAlwaysOn", async () => {
      const configuration = vscode.workspace.getConfiguration("aiChangeReview");
      const next = !configuration.get<boolean>("alwaysOn", false);
      await configuration.update("alwaysOn", next, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(next ? "AI Change Review will keep tracking this workspace across restarts." : "AI Change Review always-on tracking is disabled for this workspace.");
      if (next && !manager.active) { await manager.start(); }
    }],
    ["aiChangeReview.endSession", () => endSession()]
  ];
  // Every command reports its own failures: an unhandled rejection here reaches
  // the user as a bare stack-trace notification with no hint of which file or
  // action it came from.
  const register = (id: string, handler: (...args: any[]) => any) => vscode.commands.registerCommand(id, (...args: any[]) => {
    try { return Promise.resolve(handler(...args)).catch(showError); } catch (error) { showError(error); }
  });
  const currentProvider: vscode.TextDocumentContentProvider = { provideTextDocumentContent: () => "" };
  context.subscriptions.push(output, manager, status, decorations, treeView, vscode.workspace.registerTextDocumentContentProvider("ai-change-review-baseline", provider), vscode.workspace.registerTextDocumentContentProvider("ai-change-review-current", currentProvider), vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "vscode-remote" }, { scheme: "ai-change-review-current" }], codeLens), ...commands.map(([id, handler]) => register(id, handler)));
  const saved = await store.load();
  const alwaysOn = vscode.workspace.getConfiguration("aiChangeReview").get<boolean>("alwaysOn", false);
  if (saved && alwaysOn) { await manager.recover(); }
  else if (saved) {
    const choice = await vscode.window.showInformationMessage("Recover the previous AI Change Review session?", "Recover", "Discard");
    if (choice === "Recover") { await manager.recover(); }
    if (choice === "Discard") { await store.clear(); }
  } else if (alwaysOn) { await manager.start(); }
}

export function deactivate(): void { /* persisted session remains available for recovery */ }
