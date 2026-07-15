import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { applyPatch, diffLines, reversePatch, structuredPatch, StructuredPatch, StructuredPatchHunk } from "diff";
import { SnapshotStore, hashBytes } from "./snapshotStore";
import { AcceptedHunk, ChangeType, FileKind, FileRecord, ReviewHunk, ReviewSession } from "./types";

const DEFAULT_EXCLUDED = ["/.git/", "/.svn/", "/.hg/", "/node_modules/", "/vendor/", "/.next/", "/.nuxt/", "/dist/", "/build/", "/out/", "/coverage/", "/.turbo/", "/.cache/", "/target/", "/Pods/", "/.gradle/"];

export class SessionManager implements vscode.Disposable {
  private session: ReviewSession | undefined;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private mutating = false;
  constructor(private readonly store: SnapshotStore, private readonly output: vscode.OutputChannel) {}
  get active(): boolean { return Boolean(this.session); }
  get current(): ReviewSession | undefined { return this.session; }
  records(): FileRecord[] { return Object.values(this.session?.files ?? {}).filter(r => r.changeType); }
  visibleRecords(): FileRecord[] { return Object.values(this.session?.files ?? {}).filter(r => r.changeType || r.acceptedFile || r.acceptedHunks?.length); }
  get acceptedCount(): number { return Object.values(this.session?.files ?? {}).filter(r => !r.changeType && (r.acceptedFile || r.acceptedHunks?.length)).length; }
  pendingStats(): { files: number; added: number; removed: number } {
    return this.records().reduce((total, record) => ({ files: total.files + 1, added: total.added + (record.addedLines ?? 0), removed: total.removed + (record.removedLines ?? 0) }), { files: 0, added: 0, removed: 0 });
  }
  record(uri: string): FileRecord | undefined { return this.session?.files[uri]; }
  private excluded(uri: vscode.Uri): boolean {
    const path = uri.path;
    const custom = vscode.workspace.getConfiguration("aiChangeReview").get<string[]>("exclude", []);
    return DEFAULT_EXCLUDED.some(part => path.includes(part)) || custom.some(part => path.includes(part.replaceAll("**/", "").replaceAll("/**", "")));
  }
  private kind(bytes: Uint8Array): FileKind {
    const max = vscode.workspace.getConfiguration("aiChangeReview").get<number>("maxFileSizeBytes", 5 * 1024 * 1024);
    if (bytes.byteLength > max) { return "large"; }
    return bytes.subarray(0, Math.min(bytes.byteLength, 8192)).includes(0) ? "binary" : "text";
  }
  private stats(baseline: Uint8Array | undefined, current: Uint8Array | undefined, kind: FileKind): { addedLines?: number; removedLines?: number } {
    if (kind !== "text") { return {}; }
    const before = new TextDecoder().decode(baseline ?? new Uint8Array());
    const after = new TextDecoder().decode(current ?? new Uint8Array());
    return diffLines(before, after).reduce((total, change) => ({
      addedLines: total.addedLines + (change.added ? (change.count ?? 0) : 0),
      removedLines: total.removedLines + (change.removed ? (change.count ?? 0) : 0)
    }), { addedLines: 0, removedLines: 0 });
  }
  async start(): Promise<void> {
    if (this.session) { void vscode.window.showInformationMessage("AI Change Review is already tracking this workspace."); return; }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { void vscode.window.showErrorMessage("Open a folder or workspace before starting AI Change Review."); return; }
    const files: Record<string, FileRecord> = {};
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "AI Change Review: capturing workspace baseline…", cancellable: true }, async (progress, token) => {
      const uris = await vscode.workspace.findFiles("**/*");
      let count = 0;
      for (const uri of uris) {
        if (token.isCancellationRequested) { throw new Error("Baseline capture cancelled."); }
        if (this.excluded(uri)) { continue; }
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const record: FileRecord = { uri: uri.toString(), label: vscode.workspace.asRelativePath(uri, false), baselineExists: true, kind: this.kind(bytes) };
          if (record.kind !== "large") { files[record.uri] = await this.store.writeBaseline(record, bytes); }
          else { files[record.uri] = { ...record, baselineHash: hashBytes(bytes), baselineSize: bytes.byteLength }; }
          count++;
          if (count % 50 === 0) { progress.report({ message: `${count} files snapshotted` }); }
        } catch (error) { this.output.appendLine(`Could not snapshot ${uri.toString()}: ${String(error)}`); }
      }
    });
    this.session = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceFolders: folders.map(f => f.uri.toString()), files };
    await this.persist();
    this.installObservers();
    this.changes.fire();
    void vscode.window.showInformationMessage("AI Change Review is on. All included workspace changes are now tracked.");
  }
  async recover(): Promise<boolean> {
    if (this.session) { return true; }
    const saved = await this.store.load();
    if (!saved) { return false; }
    this.session = saved;
    this.installObservers();
    await this.reconcile();
    void vscode.window.showInformationMessage("AI Change Review session recovered.");
    return true;
  }
  private installObservers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const changed = () => { if (!this.mutating) { void this.schedule(); } };
    this.disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed), vscode.workspace.onDidSaveTextDocument(changed));
    const interval = vscode.workspace.getConfiguration("aiChangeReview").get<number>("reconcileIntervalMs", 5000);
    this.timer = setInterval(() => void this.reconcile(), interval);
  }
  private async schedule(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 200)); await this.reconcile(); }
  async reconcile(): Promise<void> {
    if (!this.session || this.reconciling || this.mutating) { return; }
    this.reconciling = true;
    try {
      const seen = new Set<string>();
      for (const uri of await vscode.workspace.findFiles("**/*")) {
        if (this.excluded(uri)) { continue; }
        const id = uri.toString(); seen.add(id);
        let record = this.session.files[id];
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const currentHash = hashBytes(bytes);
          if (!record) {
            const kind = this.kind(bytes);
            record = { uri: id, label: vscode.workspace.asRelativePath(uri, false), baselineExists: false, kind, changeType: "created", currentHash, ...this.stats(undefined, bytes, kind) };
            this.session.files[id] = record;
          } else {
            record.currentHash = currentHash;
            record.changeType = !record.baselineExists ? "created" : currentHash === record.baselineHash ? undefined : "modified";
            Object.assign(record, record.changeType ? this.stats(await this.store.readBaseline(record), bytes, record.kind) : { addedLines: undefined, removedLines: undefined });
          }
        } catch { /* inaccessible files are ignored until a later pass */ }
      }
      for (const record of Object.values(this.session.files)) {
        if (record.baselineExists && !seen.has(record.uri)) {
          record.changeType = "deleted"; record.currentHash = undefined;
          Object.assign(record, this.stats(await this.store.readBaseline(record), undefined, record.kind));
        }
      }
      await this.persist(); this.changes.fire();
    } finally { this.reconciling = false; }
  }
  private async persist(): Promise<void> { if (this.session) { this.session.updatedAt = new Date().toISOString(); await this.store.save(this.session); } }
  private async withMutation(action: () => Promise<void>): Promise<void> { this.mutating = true; try { await action(); } finally { this.mutating = false; await this.reconcile(); } }
  async accept(record: FileRecord): Promise<void> {
    if (!this.session) { return; }
    await this.withMutation(async () => {
      const uri = vscode.Uri.parse(record.uri);
      if (record.changeType === "deleted") { Object.assign(record, { baselineExists: false, baselineSnapshotKey: undefined, baselineHash: undefined, baselineSize: undefined, changeType: undefined, addedLines: undefined, removedLines: undefined }); }
      else {
        const acceptedHunks = await this.hunks(record);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const updated = await this.store.writeBaseline({ ...record, kind: this.kind(bytes) }, bytes);
        const accepted = acceptedHunks.map(hunk => ({ id: hunk.id, oldStart: hunk.oldStart, newStart: hunk.newStart, oldLines: hunk.oldLines, newLines: hunk.newLines, lines: hunk.lines, acceptedAt: new Date().toISOString() }));
        Object.assign(record, updated, { changeType: undefined, addedLines: undefined, removedLines: undefined, acceptedFile: true, acceptedHunks: [...(record.acceptedHunks ?? []), ...accepted] });
      }
      await this.persist();
    });
  }
  async reject(record: FileRecord): Promise<void> {
    if (!this.session) { return; }
    const uri = vscode.Uri.parse(record.uri);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === record.uri && d.isDirty);
    if (open && !await vscode.window.showWarningMessage(`“${record.label}” has unsaved editor changes. Reject and discard them?`, { modal: true }, "Reject File")) { return; }
    await this.withMutation(async () => {
      if (!record.baselineExists) { try { await vscode.workspace.fs.delete(uri, { useTrash: false }); } catch { /* already gone */ } }
      else {
        const bytes = await this.store.readBaseline(record);
        if (!bytes) { throw new Error(`Baseline unavailable for ${record.label}`); }
        const slash = uri.path.lastIndexOf("/");
        if (slash > 0) { await vscode.workspace.fs.createDirectory(uri.with({ path: uri.path.slice(0, slash) })); }
        await vscode.workspace.fs.writeFile(uri, bytes);
      }
      await this.persist();
    });
  }
  async acceptAll(): Promise<void> { for (const record of [...this.records()]) { await this.accept(record); } }
  async rejectAll(): Promise<void> { for (const record of [...this.records()]) { await this.reject(record); } }
  async clearAccepted(): Promise<void> {
    if (!this.session) { return; }
    for (const record of Object.values(this.session.files)) {
      if (!record.changeType) { record.acceptedFile = undefined; record.acceptedHunks = undefined; }
    }
    await this.persist();
    this.changes.fire();
  }
  async hunks(record: FileRecord): Promise<ReviewHunk[]> {
    if (record.kind !== "text" || !record.changeType || record.changeType === "deleted") { return []; }
    const baseline = await this.store.readBaseline(record);
    const current = await vscode.workspace.fs.readFile(vscode.Uri.parse(record.uri));
    const baselineText = new TextDecoder().decode(baseline ?? new Uint8Array());
    const currentText = new TextDecoder().decode(current);
    const patch = structuredPatch(record.label, record.label, baselineText, currentText);
    return patch.hunks.map((hunk, index) => ({
      id: hashBytes(new TextEncoder().encode(`${record.uri}:${index}:${hunk.oldStart}:${hunk.newStart}:${hunk.lines.join("\n")}`)),
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      currentStart: Math.max(0, hunk.newStart - 1),
      baselineHash: record.baselineHash ?? hashBytes(baseline ?? new Uint8Array()),
      currentHash: hashBytes(current),
      lines: hunk.lines
    }));
  }
  private async selectedPatch(record: FileRecord, hunkId: string): Promise<{ patch: StructuredPatch; hunk: StructuredPatchHunk; meta: ReviewHunk; current: Uint8Array; baseline: Uint8Array }> {
    const baseline = await this.store.readBaseline(record) ?? new Uint8Array();
    const current = await vscode.workspace.fs.readFile(vscode.Uri.parse(record.uri));
    const patch = structuredPatch(record.label, record.label, new TextDecoder().decode(baseline), new TextDecoder().decode(current));
    const all = await this.hunks(record);
    const index = all.findIndex(h => h.id === hunkId);
    if (index < 0 || !patch.hunks[index]) { throw new Error("This change is stale. Refresh the diff and review it again."); }
    const meta = all[index];
    if (meta.currentHash !== hashBytes(current) || meta.baselineHash !== hashBytes(baseline)) { throw new Error("This change is stale. Refresh the diff and review it again."); }
    return { patch, hunk: patch.hunks[index], meta, current, baseline };
  }
  async acceptHunk(record: FileRecord, hunkId: string): Promise<void> {
    await this.withMutation(async () => {
      const { patch, hunk, baseline } = await this.selectedPatch(record, hunkId);
      const applied = applyPatch(new TextDecoder().decode(baseline), { ...patch, hunks: [hunk] });
      if (applied === false) { throw new Error("Could not apply this change to the baseline. Refresh and try again."); }
      Object.assign(record, await this.store.writeBaseline(record, new TextEncoder().encode(applied)));
      const accepted: AcceptedHunk = { id: hunkId, oldStart: hunk.oldStart, newStart: hunk.newStart, oldLines: hunk.oldLines, newLines: hunk.newLines, lines: hunk.lines, acceptedAt: new Date().toISOString() };
      record.acceptedHunks = [...(record.acceptedHunks ?? []).filter(h => h.id !== hunkId), accepted];
      await this.persist();
    });
  }
  async rejectHunk(record: FileRecord, hunkId: string): Promise<void> {
    await this.withMutation(async () => {
      const { patch, hunk, current } = await this.selectedPatch(record, hunkId);
      const reversed = reversePatch({ ...patch, hunks: [hunk] });
      const applied = applyPatch(new TextDecoder().decode(current), reversed);
      if (applied === false) { throw new Error("Could not reverse this change. Refresh and try again."); }
      await vscode.workspace.fs.writeFile(vscode.Uri.parse(record.uri), new TextEncoder().encode(applied));
      await this.persist();
    });
  }
  async reviewContent(record: FileRecord): Promise<{ current: string; hunks: ReviewHunk[]; accepted: AcceptedHunk[] }> {
    let current = "";
    try { current = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(record.uri))); } catch { /* deleted file */ }
    return { current, hunks: await this.hunks(record), accepted: record.acceptedHunks ?? [] };
  }
  async end(discard: boolean): Promise<void> { this.stopObservers(); this.session = undefined; if (discard) { await this.store.clear(); } this.changes.fire(); }
  private stopObservers(): void { this.disposables.splice(0).forEach(d => d.dispose()); if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
  dispose(): void { this.stopObservers(); this.changes.dispose(); }
}
