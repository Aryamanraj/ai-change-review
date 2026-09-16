import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { applyPatch, diffLines, reversePatch, structuredPatch, StructuredPatch, StructuredPatchHunk } from "diff";
import ignore = require("ignore");
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
  private branchPromptOpen = false;
  private debounce: NodeJS.Timeout | undefined;
  private readonly touched = new Set<string>();
  private settingsCache: { maxFileSizeBytes: number; exclude: string[]; reconcileIntervalMs: number } | undefined;
  private readonly gitIgnoreCache = new Map<string, ignore.Ignore | undefined>();
  private readonly hunkCache = new Map<string, { key: string; hunks: ReviewHunk[] }>();
  constructor(private readonly store: SnapshotStore, private readonly output: vscode.OutputChannel) {}
  get active(): boolean { return Boolean(this.session); }
  get current(): ReviewSession | undefined { return this.session; }
  records(): FileRecord[] { return Object.values(this.session?.files ?? {}).filter(r => r.changeType); }
  nextPendingRecord(currentUri: string): FileRecord | undefined {
    const pending = this.records().sort((left, right) => left.label.localeCompare(right.label));
    const sameFile = pending.find(record => record.uri === currentUri);
    if (sameFile) { return sameFile; }
    const current = this.record(currentUri);
    if (!current) { return pending[0]; }
    return pending.find(record => record.label.localeCompare(current.label) > 0) ?? pending[0];
  }
  /** The sidebar is an inbox: only changes that still require a decision belong here. */
  visibleRecords(): FileRecord[] { return this.records(); }
  pendingStats(): { files: number; added: number; removed: number } {
    return this.records().reduce((total, record) => ({ files: total.files + 1, added: total.added + (record.addedLines ?? 0), removed: total.removed + (record.removedLines ?? 0) }), { files: 0, added: 0, removed: 0 });
  }
  record(uri: string): FileRecord | undefined { return this.session?.files[uri]; }
  /** Read once per settings change: a scan asks for these for every file it touches. */
  private get settings(): { maxFileSizeBytes: number; exclude: string[]; reconcileIntervalMs: number } {
    if (!this.settingsCache) {
      const configuration = vscode.workspace.getConfiguration("aiChangeReview");
      this.settingsCache = {
        maxFileSizeBytes: configuration.get<number>("maxFileSizeBytes", 5 * 1024 * 1024),
        exclude: configuration.get<string[]>("exclude", []).map(part => part.replaceAll("**/", "").replaceAll("/**", "")),
        reconcileIntervalMs: configuration.get<number>("reconcileIntervalMs", 5000)
      };
    }
    return this.settingsCache;
  }
  private excludedByConfig(uri: vscode.Uri): boolean {
    const path = uri.path;
    return DEFAULT_EXCLUDED.some(part => path.includes(part)) || this.settings.exclude.some(part => path.includes(part));
  }
  private async excluded(uri: vscode.Uri): Promise<boolean> {
    if (this.excludedByConfig(uri)) { return true; }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) { return false; }
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/^\/+/, "");
    const parts = relative.split("/");
    // Each .gitignore applies to files below its own directory. Check the root
    // first, then every ancestor that can contain a nested .gitignore.
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = depth ? vscode.Uri.joinPath(folder.uri, ...parts.slice(0, depth)) : folder.uri;
      const rules = await this.gitIgnore(directory);
      if (!rules) { continue; }
      const candidate = parts.slice(depth).join("/");
      if (candidate && rules.ignores(candidate)) { return true; }
    }
    return false;
  }
  private async gitIgnore(directory: vscode.Uri): Promise<ignore.Ignore | undefined> {
    const key = directory.toString();
    if (this.gitIgnoreCache.has(key)) { return this.gitIgnoreCache.get(key); }
    try {
      const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, ".gitignore")));
      const rules = ignore().add(contents);
      this.gitIgnoreCache.set(key, rules);
      return rules;
    } catch {
      this.gitIgnoreCache.set(key, undefined);
      return undefined;
    }
  }
  /** Workspace files can vanish mid-session; callers treat that as "no longer changed". */
  private async read(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    try { return await vscode.workspace.fs.readFile(uri); } catch { return undefined; }
  }
  private async stat(uri: vscode.Uri): Promise<{ mtime: number; size: number } | undefined> {
    try { const stat = await vscode.workspace.fs.stat(uri); return { mtime: stat.mtime, size: stat.size }; } catch { return undefined; }
  }
  private kind(bytes: Uint8Array): FileKind {
    if (bytes.byteLength > this.settings.maxFileSizeBytes) { return "large"; }
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
    this.settingsCache = undefined;
    this.gitIgnoreCache.clear();
    this.hunkCache.clear();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "AI Change Review: capturing workspace baseline…", cancellable: true }, async (progress, token) => {
      const uris = await vscode.workspace.findFiles("**/*");
      let count = 0;
      for (const uri of uris) {
        if (token.isCancellationRequested) { throw new Error("Baseline capture cancelled."); }
        if (await this.excluded(uri)) { continue; }
        try {
          // Stat first: a file written between the stat and the read keeps a
          // modification time newer than the one recorded, so the next scan
          // still notices it.
          const stat = await this.stat(uri);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const record: FileRecord = { uri: uri.toString(), label: vscode.workspace.asRelativePath(uri, false), baselineExists: true, kind: this.kind(bytes), mtime: stat?.mtime, size: stat?.size };
          const captured = record.kind !== "large"
            ? await this.store.writeBaseline(record, bytes)
            : { ...record, baselineHash: hashBytes(bytes), baselineSize: bytes.byteLength };
          files[record.uri] = { ...captured, currentHash: captured.baselineHash };
          count++;
          if (count % 50 === 0) { progress.report({ message: `${count} files snapshotted` }); }
        } catch (error) { this.output.appendLine(`Could not snapshot ${uri.toString()}: ${String(error)}`); }
      }
    });
    this.session = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceFolders: folders.map(f => f.uri.toString()), files, gitHead: await this.gitHead(folders[0].uri) };
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
    const changed = (uri: vscode.Uri) => {
      if (uri.path.endsWith("/.gitignore")) { this.gitIgnoreCache.clear(); }
      // Excluded trees churn constantly — .git alone writes on every command —
      // and waking a scan for them is pure cost.
      if (this.mutating || this.excludedByConfig(uri)) { return; }
      this.touched.add(uri.toString());
      this.scheduleDrain();
    };
    this.disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
      vscode.workspace.onDidSaveTextDocument(document => changed(document.uri)),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("aiChangeReview")) { this.settingsCache = undefined; this.gitIgnoreCache.clear(); } }));
    this.timer = setInterval(() => void this.reconcile(), this.settings.reconcileIntervalMs);
  }
  private scheduleDrain(): void {
    if (this.debounce) { return; }
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.drain(); }, 200);
  }
  /** Re-examine only what the watcher reported; the periodic pass is the safety net. */
  private async drain(): Promise<void> {
    const targets = [...this.touched];
    this.touched.clear();
    if (await this.scan(targets)) { return; }
    // A scan that could not run leaves its reports for the next attempt.
    targets.forEach(uri => this.touched.add(uri));
    this.scheduleDrain();
  }
  async reconcile(): Promise<void> { await this.scan(); }
  /** Returns whether the scan ran; it is skipped while another one or a mutation is in flight. */
  private async scan(targets?: string[]): Promise<boolean> {
    const session = this.session;
    if (!session || this.reconciling || this.mutating) { return false; }
    this.reconciling = true;
    let dirty = false;
    try {
      await this.detectBranchChange();
      if (this.session !== session) { return true; }
      const uris = targets ? targets.map(uri => vscode.Uri.parse(uri)) : await vscode.workspace.findFiles("**/*");
      const seen = new Set<string>();
      for (const uri of uris) {
        if (await this.excluded(uri)) { continue; }
        // A watcher event says the file changed, so its recorded stat cannot be trusted.
        const state = await this.examine(uri, Boolean(targets));
        // Deletions reported by the watcher are left to the pass below, which
        // owns the difference between a lost file and a lost record.
        if (state === "missing") { continue; }
        seen.add(uri.toString());
        dirty = state === "changed" || dirty;
      }
      const records = targets
        ? targets.map(uri => session.files[uri]).filter((record): record is FileRecord => Boolean(record))
        : Object.values(session.files);
      for (const record of records) {
        // Anything the pass just examined is present and included by definition.
        if (seen.has(record.uri)) { continue; }
        const uri = vscode.Uri.parse(record.uri);
        if (await this.excluded(uri)) { this.forget(record.uri); dirty = true; continue; }
        if (await this.stat(uri)) { continue; }
        // A file created during the session and then deleted or renamed has no
        // baseline to restore, so the record is dropped instead of lingering as
        // a pending change that points at a path which no longer exists.
        if (!record.baselineExists) { this.forget(record.uri); dirty = true; continue; }
        if (record.changeType !== "deleted") {
          this.hunkCache.delete(record.uri);
          record.changeType = "deleted"; record.currentHash = undefined; record.mtime = undefined; record.size = undefined;
          Object.assign(record, this.stats(await this.store.readBaseline(record), undefined, record.kind));
          dirty = true;
        }
      }
      if (dirty) { await this.persist(); this.changes.fire(); }
      return true;
    } finally { this.reconciling = false; }
  }
  /** Brings one file's record up to date. */
  private async examine(uri: vscode.Uri, force: boolean): Promise<"missing" | "same" | "changed"> {
    const session = this.session;
    if (!session) { return "same"; }
    const id = uri.toString();
    const record = session.files[id];
    const stat = await this.stat(uri);
    if (!stat) { return "missing"; }
    // Reading and hashing every file was the bulk of a scan. An unchanged size
    // and modification time means the recorded result still describes the file.
    if (!force && record?.currentHash && record.mtime === stat.mtime && record.size === stat.size) { return "same"; }
    const bytes = await this.read(uri);
    if (!bytes) { return "missing"; }
    const currentHash = hashBytes(bytes);
    if (!record) {
      const kind = this.kind(bytes);
      session.files[id] = { uri: id, label: vscode.workspace.asRelativePath(uri, false), baselineExists: false, kind, changeType: "created", currentHash, mtime: stat.mtime, size: stat.size, ...this.stats(undefined, bytes, kind) };
      return "changed";
    }
    const changeType: ChangeType | undefined = !record.baselineExists ? "created" : currentHash === record.baselineHash ? undefined : "modified";
    const settled = record.currentHash === currentHash && record.changeType === changeType;
    Object.assign(record, { currentHash, changeType, mtime: stat.mtime, size: stat.size });
    if (!settled) { Object.assign(record, changeType ? this.stats(await this.store.readBaseline(record), bytes, record.kind) : { addedLines: undefined, removedLines: undefined }); }
    return settled ? "same" : "changed";
  }
  async resetBaseline(): Promise<void> {
    if (!this.session) { return this.start(); }
    this.stopObservers();
    this.session = undefined;
    await this.store.clear();
    await this.start();
    void vscode.window.showInformationMessage("AI Change Review baseline reset for the current Git branch.");
  }
  private async gitHead(root: vscode.Uri): Promise<string | undefined> {
    try {
      const dotGit = vscode.Uri.joinPath(root, ".git");
      const stat = await vscode.workspace.fs.stat(dotGit);
      if (stat.type !== vscode.FileType.Directory) { return undefined; }
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dotGit, "HEAD"))).trim();
    } catch { return undefined; }
  }
  private async detectBranchChange(): Promise<void> {
    if (!this.session || this.branchPromptOpen || this.session.workspaceFolders.length !== 1) { return; }
    const current = await this.gitHead(vscode.Uri.parse(this.session.workspaceFolders[0]));
    if (!current) { return; }
    if (!this.session.gitHead) { this.session.gitHead = current; await this.persist(); return; }
    if (current === this.session.gitHead) { return; }
    this.branchPromptOpen = true;
    try {
      const choice = await vscode.window.showWarningMessage("Git branch changed. Reset the AI Change Review baseline for this branch?", "Reset baseline", "Keep reviewing old baseline");
      if (!this.session) { return; }
      if (choice === "Reset baseline") { await this.resetBaseline(); }
      else if (choice === "Keep reviewing old baseline") { this.session.gitHead = current; await this.persist(); }
    } finally { this.branchPromptOpen = false; }
  }
  private forget(uri: string): void { this.hunkCache.delete(uri); if (this.session) { delete this.session.files[uri]; } }
  private async persist(): Promise<void> { if (this.session) { this.session.updatedAt = new Date().toISOString(); await this.store.save(this.session); } }
  private async withMutation(uris: string[], action: () => Promise<void>): Promise<void> {
    this.mutating = true;
    try { await action(); } finally {
      this.mutating = false;
      await this.persist();
      // The decision itself is already reflected in memory, so the views are
      // told straight away and the scan only reports what it also finds on disk.
      this.changes.fire();
      await this.scan(uris);
    }
  }
  async accept(record: FileRecord): Promise<void> {
    if (!this.session) { return; }
    await this.withMutation([record.uri], () => this.applyAccept(record));
  }
  private async applyAccept(record: FileRecord): Promise<void> {
    const session = this.session;
    if (!session) { return; }
    const uri = vscode.Uri.parse(record.uri);
    // Accepting a deletion, and accepting a file that has since been deleted
    // behind our back, both mean "there is nothing left to review here".
    const bytes = record.changeType === "deleted" ? undefined : await this.read(uri);
    if (!bytes) {
      const forgettable = record.changeType !== "deleted" && !record.baselineExists;
      Object.assign(record, { baselineExists: false, baselineSnapshotKey: undefined, baselineHash: undefined, baselineSize: undefined, changeType: undefined, addedLines: undefined, removedLines: undefined });
      if (forgettable) { this.forget(record.uri); }
      return;
    }
    const acceptedHunks = await this.hunks(record, true);
    const updated = await this.store.writeBaseline({ ...record, kind: this.kind(bytes) }, bytes);
    const accepted = acceptedHunks.map(hunk => ({ id: hunk.id, oldStart: hunk.oldStart, newStart: hunk.newStart, oldLines: hunk.oldLines, newLines: hunk.newLines, lines: hunk.lines, acceptedAt: new Date().toISOString() }));
    Object.assign(record, updated, { changeType: undefined, addedLines: undefined, removedLines: undefined, acceptedFile: true, acceptedHunks: [...(record.acceptedHunks ?? []), ...accepted] });
    this.hunkCache.delete(record.uri);
  }
  private async confirmReject(record: FileRecord): Promise<boolean> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === record.uri && document.isDirty);
    if (!open) { return true; }
    return Boolean(await vscode.window.showWarningMessage(`“${record.label}” has unsaved editor changes. Reject and discard them?`, { modal: true }, "Reject File"));
  }
  async reject(record: FileRecord): Promise<void> {
    if (!this.session || !await this.confirmReject(record)) { return; }
    await this.withMutation([record.uri], () => this.applyReject(record));
  }
  private async applyReject(record: FileRecord): Promise<void> {
    const uri = vscode.Uri.parse(record.uri);
    if (!record.baselineExists) { try { await vscode.workspace.fs.delete(uri, { useTrash: false }); } catch { /* already gone */ } }
    else {
      const bytes = await this.store.readBaseline(record);
      if (!bytes) { throw new Error(`Baseline unavailable for ${record.label}`); }
      const slash = uri.path.lastIndexOf("/");
      if (slash > 0) { await vscode.workspace.fs.createDirectory(uri.with({ path: uri.path.slice(0, slash) })); }
      await vscode.workspace.fs.writeFile(uri, bytes);
    }
    this.hunkCache.delete(record.uri);
  }
  async acceptAll(): Promise<void> {
    const records = [...this.records()];
    await this.withMutation(records.map(record => record.uri), async () => { for (const record of records) { await this.applyAccept(record); } });
  }
  async rejectAll(): Promise<void> {
    const records = [...this.records()];
    await this.withMutation(records.map(record => record.uri), async () => {
      for (const record of records) { if (await this.confirmReject(record)) { await this.applyReject(record); } }
    });
  }
  /**
   * The code lens, the gutter decorations and the review panel all ask for the
   * same hunks on every reconciliation and every keystroke, so the last result
   * is reused while the tracked hashes still describe the file. `fresh` forces a
   * re-read for callers that are about to write based on the result.
   */
  async hunks(record: FileRecord, fresh = false): Promise<ReviewHunk[]> {
    if (record.kind !== "text" || !record.changeType || record.changeType === "deleted") { return []; }
    const cached = this.hunkCache.get(record.uri);
    if (!fresh && record.currentHash && cached?.key === this.hunkKey(record, record.currentHash)) { return cached.hunks; }
    const baseline = await this.store.readBaseline(record);
    const current = await this.read(vscode.Uri.parse(record.uri));
    if (!current) { return []; }
    const baselineText = new TextDecoder().decode(baseline ?? new Uint8Array());
    const currentText = new TextDecoder().decode(current);
    const currentHash = hashBytes(current);
    const baselineHash = record.baselineHash ?? hashBytes(baseline ?? new Uint8Array());
    const patch = structuredPatch(record.label, record.label, baselineText, currentText);
    const hunks = patch.hunks.map((hunk, index) => ({
      id: hashBytes(new TextEncoder().encode(`${record.uri}:${index}:${hunk.oldStart}:${hunk.newStart}:${hunk.lines.join("\n")}`)),
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      currentStart: Math.max(0, hunk.newStart - 1),
      baselineHash,
      currentHash,
      lines: hunk.lines
    }));
    this.hunkCache.set(record.uri, { key: this.hunkKey(record, currentHash), hunks });
    return hunks;
  }
  private hunkKey(record: FileRecord, currentHash: string): string { return `${record.baselineHash ?? ""}:${currentHash}`; }
  private async selectedPatch(record: FileRecord, hunkId: string): Promise<{ patch: StructuredPatch; hunk: StructuredPatchHunk; meta: ReviewHunk; current: Uint8Array; baseline: Uint8Array }> {
    const baseline = await this.store.readBaseline(record) ?? new Uint8Array();
    const current = await this.read(vscode.Uri.parse(record.uri));
    if (!current) { throw new Error("This change is stale. Refresh the diff and review it again."); }
    const patch = structuredPatch(record.label, record.label, new TextDecoder().decode(baseline), new TextDecoder().decode(current));
    const all = await this.hunks(record, true);
    const index = all.findIndex(h => h.id === hunkId);
    if (index < 0 || !patch.hunks[index]) { throw new Error("This change is stale. Refresh the diff and review it again."); }
    const meta = all[index];
    if (meta.currentHash !== hashBytes(current) || meta.baselineHash !== hashBytes(baseline)) { throw new Error("This change is stale. Refresh the diff and review it again."); }
    return { patch, hunk: patch.hunks[index], meta, current, baseline };
  }
  async acceptHunk(record: FileRecord, hunkId: string): Promise<void> {
    await this.withMutation([record.uri], async () => {
      const { patch, hunk, baseline, current } = await this.selectedPatch(record, hunkId);
      const applied = applyPatch(new TextDecoder().decode(baseline), { ...patch, hunks: [hunk] });
      if (applied === false) { throw new Error("Could not apply this change to the baseline. Refresh and try again."); }
      const bytes = new TextEncoder().encode(applied);
      // The file itself is untouched, so the scan that follows cannot tell that
      // the remaining diff shrank: restate the counts against the new baseline.
      Object.assign(record, await this.store.writeBaseline(record, bytes), this.stats(bytes, current, record.kind));
      const accepted: AcceptedHunk = { id: hunkId, oldStart: hunk.oldStart, newStart: hunk.newStart, oldLines: hunk.oldLines, newLines: hunk.newLines, lines: hunk.lines, acceptedAt: new Date().toISOString() };
      record.acceptedHunks = [...(record.acceptedHunks ?? []).filter(h => h.id !== hunkId), accepted];
      this.hunkCache.delete(record.uri);
    });
  }
  async rejectHunk(record: FileRecord, hunkId: string): Promise<void> {
    await this.withMutation([record.uri], async () => {
      const { patch, hunk, current } = await this.selectedPatch(record, hunkId);
      const reversed = reversePatch({ ...patch, hunks: [hunk] });
      const applied = applyPatch(new TextDecoder().decode(current), reversed);
      if (applied === false) { throw new Error("Could not reverse this change. Refresh and try again."); }
      await vscode.workspace.fs.writeFile(vscode.Uri.parse(record.uri), new TextEncoder().encode(applied));
      this.hunkCache.delete(record.uri);
    });
  }
  async reviewContent(record: FileRecord): Promise<{ current: string; hunks: ReviewHunk[]; accepted: AcceptedHunk[] }> {
    let current = "";
    const bytes = await this.read(vscode.Uri.parse(record.uri));
    if (bytes) { current = new TextDecoder().decode(bytes); }
    return { current, hunks: await this.hunks(record), accepted: record.acceptedHunks ?? [] };
  }
  async end(discard: boolean): Promise<void> { this.stopObservers(); this.hunkCache.clear(); this.session = undefined; if (discard) { await this.store.clear(); } this.changes.fire(); }
  private stopObservers(): void {
    this.disposables.splice(0).forEach(d => d.dispose());
    this.touched.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = undefined; }
  }
  dispose(): void { this.stopObservers(); this.changes.dispose(); }
}
