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
  const codeLens = new ReviewCodeLensProvider(manager);
  const decorations = new DecorationController(manager);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "aiChangeReview.openReview";
  const refreshStatus = () => {
    const pending = manager.pendingStats();
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
    ["aiChangeReview.toggleSession", () => manager.active ? endSession().catch(showError) : manager.start().catch(showError)],
    ["aiChangeReview.startSession", () => manager.start().catch(showError)],
    ["aiChangeReview.refresh", () => manager.reconcile().catch(showError)],
    ["aiChangeReview.resetBaseline", () => manager.resetBaseline().catch(showError)],
    ["aiChangeReview.openReview", () => { if (!manager.active) { return manager.start().catch(showError); } return vscode.commands.executeCommand("workbench.view.extension.aiChangeReview"); }],
    ["aiChangeReview.openFileDiff", async (uri?: unknown) => {
      const record = fileArg(uri);
      if (!record) { return; }
      if (record.kind !== "text") { void vscode.window.showInformationMessage("Binary and large files support file-level acceptance or rejection only."); return; }
      ReviewPanel.open(manager, record);
    }],
    ["aiChangeReview.acceptFile", (uri?: unknown) => { const r = fileArg(uri); return r ? manager.accept(r).catch(showError) : undefined; }],
    ["aiChangeReview.rejectFile", (uri?: unknown) => { const r = fileArg(uri); return r ? manager.reject(r).catch(showError) : undefined; }],
    ["aiChangeReview.acceptHunk", (uri?: unknown, hunkId?: string) => { const r = fileArg(uri); return r && hunkId ? manager.acceptHunk(r, hunkId).catch(showError) : undefined; }],
    ["aiChangeReview.rejectHunk", (uri?: unknown, hunkId?: string) => { const r = fileArg(uri); return r && hunkId ? manager.rejectHunk(r, hunkId).catch(showError) : undefined; }],
    ["aiChangeReview.acceptAll", () => manager.acceptAll().catch(showError)],
    ["aiChangeReview.rejectAll", () => manager.rejectAll().catch(showError)],
    ["aiChangeReview.clearAccepted", () => manager.clearAccepted().catch(showError)],
    ["aiChangeReview.toggleAlwaysOn", async () => {
      const configuration = vscode.workspace.getConfiguration("aiChangeReview");
      const next = !configuration.get<boolean>("alwaysOn", false);
      await configuration.update("alwaysOn", next, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(next ? "AI Change Review will keep tracking this workspace across restarts." : "AI Change Review always-on tracking is disabled for this workspace.");
      if (next && !manager.active) { await manager.start(); }
    }],
    ["aiChangeReview.endSession", () => endSession().catch(showError)]
  ];
  const currentProvider: vscode.TextDocumentContentProvider = { provideTextDocumentContent: () => "" };
  context.subscriptions.push(output, manager, status, decorations, vscode.workspace.registerTextDocumentContentProvider("ai-change-review-baseline", provider), vscode.workspace.registerTextDocumentContentProvider("ai-change-review-current", currentProvider), vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "vscode-remote" }, { scheme: "ai-change-review-current" }], codeLens), vscode.window.registerTreeDataProvider("aiChangeReview.changes", tree), ...commands.map(([id, handler]) => vscode.commands.registerCommand(id, handler)));
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
