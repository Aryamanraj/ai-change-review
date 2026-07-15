export type ChangeType = "created" | "modified" | "deleted";
export type FileKind = "text" | "binary" | "large";

export interface FileRecord {
  uri: string;
  label: string;
  baselineExists: boolean;
  baselineSnapshotKey?: string;
  baselineHash?: string;
  baselineSize?: number;
  kind: FileKind;
  changeType?: ChangeType;
  currentHash?: string;
  addedLines?: number;
  removedLines?: number;
  acceptedHunks?: AcceptedHunk[];
  acceptedFile?: boolean;
}

export interface AcceptedHunk {
  id: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: string[];
  acceptedAt: string;
}

export interface ReviewSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceFolders: string[];
  files: Record<string, FileRecord>;
  /** The Git HEAD contents at baseline capture, when this is a local Git workspace. */
  gitHead?: string;
}

export interface ReviewHunk {
  id: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  currentStart: number;
  baselineHash: string;
  currentHash: string;
  lines: string[];
}
