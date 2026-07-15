import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { FileRecord, ReviewHunk } from "./types";

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

/** A focused review surface: native editor UI cannot host interactive hunk toolbars. */
export class ReviewPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private record: FileRecord;

  static open(manager: SessionManager, record: FileRecord): ReviewPanel {
    const panel = vscode.window.createWebviewPanel("aiChangeReview.review", `AI Change Review: ${record.label}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    return new ReviewPanel(panel, manager, record);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly manager: SessionManager, record: FileRecord) {
    this.record = record;
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage(message => void this.handle(message)),
      manager.onDidChange(() => void this.render())
    );
    void this.render();
  }

  private async handle(message: { type?: string; hunkId?: string }): Promise<void> {
    const current = this.manager.record(this.record.uri);
    if (!current) { return; }
    try {
      if (message.type === "keep" && message.hunkId) {
        await this.manager.acceptHunk(current, message.hunkId);
        this.advanceToNextPending();
      }
      if (message.type === "undo" && message.hunkId) { await this.manager.rejectHunk(current, message.hunkId); }
      if (message.type === "keepFile") {
        await this.manager.accept(current);
        this.advanceToNextPending();
      }
      if (message.type === "undoFile") { await this.manager.reject(current); }
      if (message.type === "openCurrent") { await vscode.window.showTextDocument(vscode.Uri.parse(current.uri)); }
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Change Review: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private advanceToNextPending(): void {
    const next = this.manager.nextPendingRecord(this.record.uri);
    if (next && next.uri !== this.record.uri) {
      ReviewPanel.open(this.manager, next);
      this.panel.dispose();
    }
  }

  private async render(): Promise<void> {
    const current = this.manager.record(this.record.uri);
    if (!current) {
      this.panel.webview.html = this.html("", [], "Reviewed", this.record.label, 0, 0);
      return;
    }
    this.record = current;
    const content = await this.manager.reviewContent(current);
    this.panel.webview.html = this.html(content.current, content.hunks, this.title(current), current.label, current.addedLines ?? 0, current.removedLines ?? 0);
  }

  private title(record: FileRecord): string {
    if (!record.changeType) { return "Accepted changes"; }
    return record.changeType === "created" ? "New file" : record.changeType === "deleted" ? "Deleted file" : "Pending changes";
  }

  private html(current: string, hunks: ReviewHunk[], heading: string, label: string, added: number, removed: number): string {
    const nonce = String(Date.now());
    const blocks = this.fullFile(current, hunks);
    const changeCount = hunks.length;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style nonce="${nonce}">
      body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
      header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
      h1 { font-size: 15px; margin: 0; font-weight: 600; } .summary { color: var(--vscode-descriptionForeground); font-size: 13px; } .add { color: var(--vscode-gitDecoration-addedResourceForeground); } .remove { color: var(--vscode-gitDecoration-deletedResourceForeground); }
      main { max-width: 1100px; margin: 0 auto; padding: 20px; } .hunk { margin: 0; border-left: 2px solid var(--vscode-focusBorder); } .hunk.accepted { border-left-color: var(--vscode-testing-iconPassed); opacity: .78; } .plain { margin: 0; padding: 0; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: var(--vscode-editor-line-height); }
      .toolbar, .header-actions { display: flex; align-items: center; gap: 8px; } .toolbar { padding: 7px 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-left: 0; position: sticky; top: 50px; z-index: 2; box-shadow: 0 2px 8px color-mix(in srgb, var(--vscode-editor-background) 70%, transparent); }
      .toolbar .count { color: var(--vscode-descriptionForeground); margin-left: auto; font-size: 12px; } button { border: 0; border-radius: 3px; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; } button:hover { background: var(--vscode-button-hoverBackground); } button.undo { color: var(--vscode-textLink-foreground); background: transparent; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); }
      pre { margin: 0; padding: 8px 0; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: var(--vscode-editor-line-height); } .line { display: flex; min-height: 1.45em; white-space: pre; } .number { width: 52px; flex: none; color: var(--vscode-editorLineNumber-foreground); text-align: right; padding-right: 14px; user-select: none; } .marker { width: 18px; flex: none; text-align: center; opacity: .9; }
      .addition { background: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground) 85%, transparent); } .deletion { background: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground) 85%, transparent); } .context { opacity: .88; } .empty { padding: 40px 0; text-align: center; color: var(--vscode-descriptionForeground); } .nav { padding: 3px 7px; font-size: 14px; } .accepted-label { color: var(--vscode-testing-iconPassed); font-size: 12px; font-weight: 600; }
    </style></head><body><header><div><h1>${escapeHtml(label)}</h1><div class="summary">${escapeHtml(heading)} · <span class="add">+${added}</span> <span class="remove">−${removed}</span></div></div><div class="header-actions"><button data-action="keepFile">Keep file</button><button class="undo" data-action="undoFile">Undo file</button><button class="nav" data-nav="previous" aria-label="Previous change">↑</button><button class="nav" data-nav="next" aria-label="Next change">↓</button><span class="summary" id="change-count">${changeCount ? `1 of ${changeCount}` : "No changes"}</span><button id="open-current">Open current file</button></div></header><main>${blocks || this.plain(current.split("\n"), 1)}</main><script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.getElementById('open-current').addEventListener('click', () => vscode.postMessage({type:'openCurrent'})); document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => vscode.postMessage({type: button.dataset.action, hunkId: button.dataset.hunk}))); const cards=[...document.querySelectorAll('.hunk')]; let index=0; const counter=document.getElementById('change-count'); const go=step=>{if(!cards.length)return; index=(index+step+cards.length)%cards.length; cards[index].scrollIntoView({behavior:'smooth',block:'start'}); counter.textContent=(index+1)+' of '+cards.length;}; document.querySelectorAll('[data-nav]').forEach(button=>button.addEventListener('click',()=>go(button.dataset.nav==='next'?1:-1))); if(cards.length){setTimeout(()=>cards[0].scrollIntoView({block:'center'}),0);}</script></body></html>`;
  }

  private fullFile(current: string, hunks: ReviewHunk[]): string {
    const blocks = hunks.map(hunk => ({ ...hunk, state: "pending" as const }))
      .sort((a, b) => a.currentStart - b.currentStart);
    const source = current.split("\n");
    let cursor = 0;
    let output = "";
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const start = Math.max(cursor, block.newStart - 1);
      output += this.plain(source.slice(cursor, start), cursor + 1);
      output += this.hunk(block, index, blocks.length);
      cursor = Math.max(cursor, start + block.newLines);
    }
    return output + this.plain(source.slice(cursor), cursor + 1);
  }

  private plain(lines: string[], start: number): string {
    if (!lines.length) { return ""; }
    return `<pre class="plain">${lines.map((line, index) => `<div class="line"><span class="number">${start + index}</span><span class="marker"> </span><span>${escapeHtml(line)}</span></div>`).join("")}</pre>`;
  }

  private hunk(hunk: ReviewHunk & { state: "pending" }, index: number, total: number): string {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines = hunk.lines.map(line => {
      const prefix = line[0]; const text = escapeHtml(line.slice(1));
      if (prefix === "+") { const row = `<div class="line addition"><span class="number">${newLine++}</span><span class="marker">+</span><span>${text}</span></div>`; return row; }
      if (prefix === "-") { const row = `<div class="line deletion"><span class="number">${oldLine++}</span><span class="marker">−</span><span>${text}</span></div>`; return row; }
      const row = `<div class="line context"><span class="number">${newLine++}</span><span class="marker"> </span><span>${text}</span></div>`; oldLine++; return row;
    }).join("");
    const controls = `<button data-action="keep" data-hunk="${hunk.id}">Keep</button><button class="undo" data-action="undo" data-hunk="${hunk.id}">Undo</button>`;
    return `<section class="hunk ${hunk.state}" id="hunk-${index}"><div class="toolbar">${controls}<button class="nav" data-nav="previous" aria-label="Previous change">↑</button><button class="nav" data-nav="next" aria-label="Next change">↓</button><span class="count">Change ${index + 1} of ${total}</span></div><pre>${lines}</pre></section>`;
  }

  dispose(): void { while (this.disposables.length) { this.disposables.pop()?.dispose(); } }
}
