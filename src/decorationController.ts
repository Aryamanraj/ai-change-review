import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

const REFRESH_DELAY_MS = 150;
/** Upper bound per editor: applying a decoration per changed line slows scrolling in a very large diff. */
const MAX_DECORATIONS = 5000;
/** Past this many added lines the inline "+" markers are dropped; see `addedLines`. */
const MAX_MARKERS = 500;

/** Adds a lightweight native-editor review mode alongside the richer webview editor. */
export class DecorationController implements vscode.Disposable {
  private static readonly addedStyle: vscode.DecorationRenderOptions = {
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  };
  private readonly added = vscode.window.createTextEditorDecorationType({
    ...DecorationController.addedStyle,
    before: { contentText: "+ ", color: new vscode.ThemeColor("gitDecoration.addedResourceForeground") }
  });
  /**
   * The same highlight without the inline marker. An inline "before" decoration
   * is laid out per line, so a file with thousands of added lines scrolls
   * noticeably slower than one drawn with the line background alone.
   */
  private readonly addedLines = vscode.window.createTextEditorDecorationType(DecorationController.addedStyle);
  private readonly removed = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    before: { contentText: "− ", color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground") }
  });
  private readonly disposables: vscode.Disposable[];
  private timer: NodeJS.Timeout | undefined;
  private readonly queued = new Set<string>();
  private queuedAll = false;

  constructor(private readonly manager: SessionManager) {
    this.disposables = [
      manager.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      // This fires on every keystroke, and for documents that are not under
      // review at all, so only the edited file is queued.
      vscode.workspace.onDidChangeTextDocument(event => this.schedule(event.document.uri))
    ];
    this.schedule();
  }

  private schedule(uri?: vscode.Uri): void {
    if (uri) {
      if (uri.scheme !== "file" || !this.manager.record(uri.toString())?.changeType) { return; }
      this.queued.add(uri.toString());
    } else {
      this.queuedAll = true;
    }
    if (this.timer) { return; }
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    const queued = new Set(this.queued);
    const all = this.queuedAll;
    this.queued.clear();
    this.queuedAll = false;
    for (const editor of vscode.window.visibleTextEditors) {
      if (all || queued.has(editor.document.uri.toString())) { await this.apply(editor); }
    }
  }

  private async apply(editor: vscode.TextEditor): Promise<void> {
    const record = this.manager.record(editor.document.uri.toString());
    if (!record?.changeType || record.kind !== "text") {
      for (const type of [this.added, this.addedLines, this.removed]) { editor.setDecorations(type, []); }
      return;
    }
    const hunks = await this.manager.hunks(record);
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    for (const hunk of hunks) {
      if (added.length + removed.length >= MAX_DECORATIONS) { break; }
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
    const marked = added.length <= MAX_MARKERS;
    editor.setDecorations(this.added, marked ? added : []);
    editor.setDecorations(this.addedLines, marked ? [] : added);
    editor.setDecorations(this.removed, removed);
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.disposables.forEach(disposable => disposable.dispose());
    this.added.dispose(); this.addedLines.dispose(); this.removed.dispose();
  }
}
