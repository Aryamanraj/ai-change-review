import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";

/** Keeps the file-level decision controls visible in the current side of a diff. */
export class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly manager: SessionManager) {
    manager.onDidChange(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    const sourceUri = document.uri.scheme === "ai-change-review-current" ? decodeURIComponent(document.uri.path.slice(1)) : document.uri.toString();
    const record = this.manager.record(sourceUri);
    if (!record?.changeType || record.kind !== "text") { return []; }
    return this.manager.hunks(record).then(hunks => {
      if (!hunks.length) { return this.fileLenses(record, new vscode.Range(0, 0, 0, 0)); }
      return hunks.flatMap(hunk => {
        const line = Math.min(hunk.currentStart, Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        return [
          new vscode.CodeLens(range, { title: "$(check) Keep", tooltip: "Keep only this change", command: "aiChangeReview.acceptHunk", arguments: [record.uri, hunk.id] }),
          new vscode.CodeLens(range, { title: "$(discard) Undo", tooltip: "Undo only this change", command: "aiChangeReview.rejectHunk", arguments: [record.uri, hunk.id] })
        ];
      });
    });
  }
  private fileLenses(record: { uri: string }, range: vscode.Range): vscode.CodeLens[] {
    return [
      new vscode.CodeLens(range, { title: "$(check) Keep file", tooltip: "Keep this file’s changes", command: "aiChangeReview.acceptFile", arguments: [record.uri] }),
      new vscode.CodeLens(range, { title: "$(discard) Undo file", tooltip: "Restore this file to its session baseline", command: "aiChangeReview.rejectFile", arguments: [record.uri] })
    ];
  }
}
