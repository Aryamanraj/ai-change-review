import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { FileRecord } from "./types";

export class ReviewTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly manager: SessionManager) { manager.onDidChange(() => this.emitter.fire(undefined)); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      if (!this.manager.active) { return [new vscode.TreeItem("Start a review session", vscode.TreeItemCollapsibleState.None)]; }
      const records = this.manager.visibleRecords();
      const actions = new vscode.TreeItem("Session actions", vscode.TreeItemCollapsibleState.Expanded);
      actions.contextValue = "aiChangeReviewActions";
      const category = (record: FileRecord) => record.changeType ?? "modified";
      const groups = ["modified", "created", "deleted"].filter(type => records.some(r => category(r) === type)).map(type => {
        const matching = records.filter(r => category(r) === type);
        const added = matching.reduce((sum, r) => sum + (r.addedLines ?? 0), 0);
        const removed = matching.reduce((sum, r) => sum + (r.removedLines ?? 0), 0);
        const group = new vscode.TreeItem(type[0].toUpperCase() + type.slice(1), vscode.TreeItemCollapsibleState.Expanded);
        group.description = `${matching.length} file${matching.length === 1 ? "" : "s"} · +${added} −${removed}`;
        group.contextValue = `aiChangeReviewGroup:${type}`; return group;
      });
      return [actions, ...groups];
    }
    if (element.contextValue === "aiChangeReviewActions") { return this.actions(); }
    const type = element.contextValue?.replace("aiChangeReviewGroup:", "");
    if (!type) { return []; }
    return this.manager.visibleRecords().filter(r => (r.changeType ?? "modified") === type).sort((a,b) => a.label.localeCompare(b.label)).map(r => this.file(r));
  }
  private actions(): vscode.TreeItem[] {
    const action = (label: string, command: string, icon: string, description: string) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = description;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.command = { command, title: label };
      return item;
    };
    const pending = this.manager.pendingStats();
    const actions: vscode.TreeItem[] = [action("Refresh changes", "aiChangeReview.refresh", "refresh", "scan workspace now")];
    if (pending.files) {
      actions.push(action("Accept all changes", "aiChangeReview.acceptAll", "check-all", `${pending.files} files · +${pending.added} −${pending.removed}`));
      actions.push(action("Reject all changes", "aiChangeReview.rejectAll", "discard", "restore baseline"));
    }
    if (this.manager.acceptedCount) { actions.push(action("Clear accepted files", "aiChangeReview.clearAccepted", "clear-all", `${this.manager.acceptedCount} accepted`)); }
    actions.push(action("End session", "aiChangeReview.endSession", "stop-circle", "keep or clear snapshot"));
    return actions;
  }
  private file(record: FileRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(record.label, vscode.TreeItemCollapsibleState.None);
    const accepted = record.acceptedFile || record.acceptedHunks?.length;
    item.description = record.kind === "text" ? (record.changeType ? `+${record.addedLines ?? 0} −${record.removedLines ?? 0}${accepted ? " · partly accepted" : ""}` : "Accepted") : `${record.kind} · file only`;
    item.tooltip = `${record.changeType ?? "accepted"}: ${record.label}\n${record.addedLines ?? 0} lines added, ${record.removedLines ?? 0} lines removed`;
    item.contextValue = "aiChangeReviewFile";
    // VS Code passes the selected tree element to context-menu commands.
    (item as vscode.TreeItem & { recordUri?: string }).recordUri = record.uri;
    item.iconPath = !record.changeType && accepted
      ? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"))
      : record.changeType === "created"
      ? new vscode.ThemeIcon("diff-added", new vscode.ThemeColor("gitDecoration.addedResourceForeground"))
      : record.changeType === "deleted"
        ? new vscode.ThemeIcon("diff-removed", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"))
        : new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
    item.command = { command: "aiChangeReview.openFileDiff", title: "Open Diff", arguments: [record.uri] };
    return item;
  }
}
