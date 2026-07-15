import * as vscode from "vscode";
import { createHash } from "crypto";
import { FileRecord, ReviewSession } from "./types";

export const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SnapshotStore {
  private readonly root: vscode.Uri;
  constructor(context: vscode.ExtensionContext) {
    this.root = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, "agent-review", "active");
  }
  private get manifest(): vscode.Uri { return vscode.Uri.joinPath(this.root, "manifest.json"); }
  private snapshotUri(key: string): vscode.Uri { return vscode.Uri.joinPath(this.root, "files", `${key}.bin`); }
  async initialize(): Promise<void> { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, "files")); }
  async save(session: ReviewSession): Promise<void> {
    await this.initialize();
    const temp = vscode.Uri.joinPath(this.root, "manifest.json.tmp");
    await vscode.workspace.fs.writeFile(temp, encoder.encode(JSON.stringify(session)));
    await vscode.workspace.fs.rename(temp, this.manifest, { overwrite: true });
  }
  async load(): Promise<ReviewSession | undefined> {
    try { return JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(this.manifest))) as ReviewSession; }
    catch { return undefined; }
  }
  async writeBaseline(record: FileRecord, bytes: Uint8Array): Promise<FileRecord> {
    const key = hashBytes(encoder.encode(record.uri)).slice(0, 32);
    await this.initialize();
    await vscode.workspace.fs.writeFile(this.snapshotUri(key), bytes);
    return { ...record, baselineExists: true, baselineSnapshotKey: key, baselineHash: hashBytes(bytes), baselineSize: bytes.byteLength };
  }
  async readBaseline(record: FileRecord): Promise<Uint8Array | undefined> {
    if (!record.baselineExists || !record.baselineSnapshotKey) { return undefined; }
    try { return await vscode.workspace.fs.readFile(this.snapshotUri(record.baselineSnapshotKey)); } catch { return undefined; }
  }
  async clear(): Promise<void> { try { await vscode.workspace.fs.delete(this.root, { recursive: true, useTrash: false }); } catch { /* absent */ } }
}
