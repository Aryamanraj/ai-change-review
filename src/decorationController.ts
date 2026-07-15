import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

/** Adds a lightweight native-editor review mode alongside the richer webview editor. */
export class DecorationController implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: "+ ", color: new vscode.ThemeColor("gitDecoration.addedResourceForeground") }
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: "− ", color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground") }
  });
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly manager: SessionManager) {
    this.disposables = [
      manager.onDidChange(() => void this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => void this.refresh()),
      vscode.workspace.onDidChangeTextDocument(() => void this.refresh())
    ];
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      const record = this.manager.record(editor.document.uri.toString());
      if (!record?.changeType || record.kind !== "text") {
        editor.setDecorations(this.added, []); editor.setDecorations(this.removed, []); continue;
      }
      const hunks = await this.manager.hunks(record);
      const added: vscode.DecorationOptions[] = [];
      const removed: vscode.DecorationOptions[] = [];
      for (const hunk of hunks) {
        let currentLine = Math.max(0, hunk.newStart - 1);
        for (const patchLine of hunk.lines) {
          if (patchLine.startsWith("+")) {
            if (currentLine < editor.document.lineCount) {
              added.push({ range: new vscode.Range(currentLine, 0, currentLine, 0), hoverMessage: "AI Change Review pending addition" });
            }
            currentLine++;
          } else if (patchLine.startsWith("-")) {
            const anchor = Math.min(currentLine, Math.max(0, editor.document.lineCount - 1));
            removed.push({ range: new vscode.Range(anchor, 0, anchor, 0), hoverMessage: `AI Change Review pending removal: ${patchLine.slice(1)}` });
          } else { currentLine++; }
        }
      }
      editor.setDecorations(this.added, added);
      editor.setDecorations(this.removed, removed);
    }
  }

  dispose(): void { this.disposables.forEach(disposable => disposable.dispose()); this.added.dispose(); this.removed.dispose(); }
}
