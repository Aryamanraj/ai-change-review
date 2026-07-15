import * as vscode from "vscode";
import { SnapshotStore } from "./snapshotStore";
import { FileRecord } from "./types";

export class BaselineProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly store: SnapshotStore, private readonly find: (uri: string) => FileRecord | undefined) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const record = this.find(decodeURIComponent(uri.path.slice(1)));
    if (!record) { return "Baseline is unavailable."; }
    const bytes = await this.store.readBaseline(record);
    return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "";
  }
  refresh(uri: vscode.Uri): void { this.changed.fire(uri); }
}
