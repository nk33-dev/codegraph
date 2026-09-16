/**
 * Phase 4: the structured-edit contract.
 *
 * The query side (phases 1-3) has one contract in `src/graph/code-query.ts`; this is its editing
 * counterpart and follows the same conventions: 1-based lines, 0-based columns, project-relative
 * paths with forward slashes, an explicit `status` instead of silent substitution, and `warnings`
 * that say what was *not* done.
 *
 * Three rules this contract is built around:
 *   1. **A preview is the default.** Nothing is written unless the caller passes `apply: true`, and
 *      even then every file is verified against the hash read for the preview first.
 *   2. **Targets come from the index, not from a text search.** The symbol is resolved by the same
 *      "name (and optional file) → node" rule as a structured query; an ambiguous name is refused
 *      rather than guessed, and a file whose index is stale is refused rather than edited at
 *      positions that no longer exist.
 *   3. **Rename is the language server's job.** A cross-file rename without a language server is
 *      not approximated by textual replacement (that would rewrite strings, comments and same-named
 *      locals); it is reported `unavailable` with the remedy.
 */
import { createHash } from 'crypto';
import type { Language, Node } from '../types';
import type { FileFreshness } from '../sync/file-freshness';

export const CODE_EDIT_OPERATIONS = ['rename', 'replace-body', 'insert-before', 'insert-after'] as const;
export type CodeEditOperation = typeof CODE_EDIT_OPERATIONS[number];

/** Operations that are purely textual at an indexed range; they need no language server. */
export const GRAPH_EDIT_OPERATIONS: readonly CodeEditOperation[] = ['replace-body', 'insert-before', 'insert-after'];

export const EDIT_FILE_OPERATIONS = ['modify', 'create', 'rename', 'delete'] as const;
export type EditFileOperation = typeof EDIT_FILE_OPERATIONS[number];

/**
 * The edit's outcome.
 *
 * `preview` and `applied` are successes; the rest are handleable states, mirroring the query
 * contract's "a missing symbol is not a tool failure" rule:
 *   - `not_found`   the target symbol does not exist in the index;
 *   - `ambiguous`   the name matches several definitions (say which by passing `file`);
 *   - `stale`       the index position no longer matches the file on disk;
 *   - `conflict`    the file changed between preview and apply, or `expectPreviewHash` did not match;
 *   - `unavailable` rename without a usable language server (not installed / not configured / no rename support);
 *   - `rejected`    the operation was refused on safety grounds (unsafe workspace edit, invalid range, …);
 *   - `not_indexed` the project has no index;
 *   - `error`       a real failure (I/O, protocol, timeout).
 */
export const CODE_EDIT_STATUSES = [
  'preview', 'applied', 'not_found', 'ambiguous', 'stale', 'conflict',
  'unavailable', 'rejected', 'not_indexed', 'error',
] as const;
export type CodeEditStatus = typeof CODE_EDIT_STATUSES[number];

export interface CodeEditRequest {
  operation: CodeEditOperation;
  /** Target symbol: a name/qualified name resolved through the index (the `file` qualifier narrows it). */
  symbol?: string;
  /** An exact project-relative file; pins the target when the name is not unique. */
  file?: string;
  /** rename only: a position-based target instead of a name (1-based line, 0-based UTF-16 column). */
  line?: number;
  column?: number;
  /** rename only: the new symbol name. */
  newName?: string;
  /** replace-body / insert-before / insert-after: the replacement or inserted text. */
  content?: string;
  /** false (default) = build the preview only; true = write the files after re-verifying them. */
  apply?: boolean;
  /** apply only: the `previewHash` a previous preview returned; a mismatch refuses to write. */
  expectPreviewHash?: string;
  /**
   * Stable idempotency key. A preview returns one; reuse it for apply and every retry so a lost
   * response cannot apply the same workspace edit twice.
   */
  operationId?: string;
  projectPath?: string;
}

/** One text edit in the result: 1-based lines, 0-based columns in **UTF-16 code units**. */
export interface EditTextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** The text this edit replaces (empty for a pure insertion). */
  oldText: string;
  newText: string;
}

export type EditPreviewLineKind = 'context' | 'add' | 'remove' | 'gap';

export interface EditPreviewLine {
  kind: EditPreviewLineKind;
  /** 1-based line in the file for `context`/`remove`, and in the edited file for `add`; null for a gap. */
  line: number | null;
  text: string;
}

/**
 * One file's part of the preview.
 *
 * `baseHash` is the sha256 of the file exactly as read while planning; apply refuses to write when
 * the file on disk no longer matches it. `create` has no base, `delete` has no result.
 */
export interface EditFilePreview {
  filePath: string;
  operation: EditFileOperation;
  baseHash: string | null;
  resultHash: string | null;
  /** Project-relative new path (`operation: "rename"` only). */
  movedTo?: string;
  edits: EditTextEdit[];
  preview: EditPreviewLine[];
  previewTruncated: boolean;
  additions: number;
  deletions: number;
}

/** Where the edit's target came from and what it is. */
export interface CodeEditTarget {
  source: 'index' | 'lsp';
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** null when only a position was given (position-based rename) and no index node covers it. */
  name: string | null;
  qualifiedName: string | null;
  kind: Node['kind'] | null;
  language: Language | null;
  symbolId: string | null;
  freshness: FileFreshness;
}

export interface CodeEditSummary {
  files: number;
  edits: number;
  additions: number;
  deletions: number;
  previewTruncated: boolean;
}

/** The result of an applied write; null while only a preview was produced. */
export interface CodeEditApplied {
  /** Stable idempotency key persisted with the transaction record. */
  operationId: string;
  /** True when this result came from an earlier terminal record and no file was written again. */
  replayed: boolean;
  files: string[];
  /** Whether the index was refreshed for the touched files (false when that failed — see warnings). */
  indexSynced: boolean;
  indexFiles: number;
  transactionState: 'committed' | 'rolled_back' | 'recovery_required';
  fileStates: Array<{
    filePath: string;
    operation: EditFileOperation;
    state: 'committed' | 'restored' | 'unchanged' | 'recovery_required';
    /** Project-relative backup path retained when manual recovery may still be needed. */
    backupPath: string | null;
    recoveryAction: string | null;
  }>;
  warnings: string[];
}

export interface CodeEditRouting {
  /** The source that resolved the target and produced the edits. */
  source: 'index' | 'lsp' | null;
  /** Whether a language server was asked at all (rename) and whether one could be used. */
  lsp: { requested: boolean; available: boolean; family: string | null; reason: string | null };
}

export interface CodeEditResult {
  schemaVersion: 1;
  operation: CodeEditOperation;
  /** What the caller asked for; `false` means "preview only, write nothing". */
  applyRequested: boolean;
  status: CodeEditStatus;
  projectRoot: string | null;
  target: CodeEditTarget | null;
  files: EditFilePreview[];
  summary: CodeEditSummary;
  /** Stable hash of this preview; pass it back with `apply: true` so the write refuses if anything moved on. */
  previewHash: string | null;
  /** Stable idempotency key for this preview/apply. Reuse it for every retry. */
  operationId: string | null;
  routing: CodeEditRouting;
  /** Present only when files were written. */
  applied: CodeEditApplied | null;
  warnings: string[];
}

/** A refusal with the status it should be reported as; thrown rather than returned so no caller can ignore it. */
export class CodeEditRefusal extends Error {
  constructor(message: string, readonly status: CodeEditStatus = 'rejected', readonly remedy: string | null = null) {
    super(message);
    this.name = 'CodeEditRefusal';
  }
}

export function emptyCodeEditResult(
  operation: CodeEditOperation,
  applyRequested = false,
): CodeEditResult {
  return {
    schemaVersion: 1, operation, applyRequested, status: 'preview', projectRoot: null, target: null,
    files: [], summary: { files: 0, edits: 0, additions: 0, deletions: 0, previewTruncated: false },
    previewHash: null, operationId: null,
    routing: { source: null, lsp: { requested: operation === 'rename', available: false, family: null, reason: null } },
    applied: null, warnings: [],
  };
}

/** Longest accepted payloads; an edit that exceeds them is refused rather than truncated. */
const MAX_SYMBOL_LENGTH = 2000;
const MAX_FILE_LENGTH = 4096;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_NAME_LENGTH = 512;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Parameter validation. Like the query contract, an argument that does not belong to the operation
 * is an outright error: silently ignoring `newName` on a `replace-body` would let a caller believe a
 * rename happened.
 */
export function validateCodeEditRequest(request: CodeEditRequest): void {
  if (!CODE_EDIT_OPERATIONS.includes(request.operation)) {
    throw new CodeEditRefusal(`operation must be one of ${CODE_EDIT_OPERATIONS.join(', ')}`, 'error');
  }
  if (request.symbol !== undefined && (typeof request.symbol !== 'string' || request.symbol.length > MAX_SYMBOL_LENGTH)) {
    throw new CodeEditRefusal(`symbol must be a string of at most ${MAX_SYMBOL_LENGTH} characters`, 'error');
  }
  if (request.file !== undefined && (typeof request.file !== 'string' || !request.file.trim() || request.file.length > MAX_FILE_LENGTH)) {
    throw new CodeEditRefusal('file must be a non-empty path', 'error');
  }
  if (request.apply !== undefined && typeof request.apply !== 'boolean') {
    throw new CodeEditRefusal('apply must be boolean', 'error');
  }
  if (request.operationId !== undefined && (
    typeof request.operationId !== 'string' || !OPERATION_ID_PATTERN.test(request.operationId)
  )) {
    throw new CodeEditRefusal(
      'operationId must be 1-128 characters using letters, numbers, dot, underscore or hyphen',
      'error',
    );
  }
  if (request.line !== undefined && (!Number.isSafeInteger(request.line) || request.line < 1)) {
    throw new CodeEditRefusal('line must be a 1-based integer', 'error');
  }
  if (request.column !== undefined && (!Number.isSafeInteger(request.column) || request.column < 0)) {
    throw new CodeEditRefusal('column must be a non-negative integer', 'error');
  }

  const positional = request.line !== undefined || request.column !== undefined;
  if (positional && request.operation !== 'rename') {
    throw new CodeEditRefusal('line/column are only supported by rename', 'error');
  }
  // `file` is optional for a name-based target: the name is resolved through the index and a name
  // that matches several definitions is refused (status "ambiguous") rather than guessed.
  if (!positional && !request.symbol?.trim()) {
    throw new CodeEditRefusal(`operation "${request.operation}" needs a symbol name (or rename with file + line)`, 'error');
  }

  if (request.operation === 'rename') {
    if (typeof request.newName !== 'string' || !request.newName.trim()) {
      throw new CodeEditRefusal('rename requires newName', 'error');
    }
    if (request.newName.length > MAX_NAME_LENGTH) {
      throw new CodeEditRefusal(`newName must be at most ${MAX_NAME_LENGTH} characters`, 'error');
    }
    if (/\s/.test(request.newName)) {
      throw new CodeEditRefusal('newName must not contain whitespace', 'error');
    }
    if (request.content !== undefined) throw new CodeEditRefusal('content is not accepted by rename', 'error');
  } else {
    if (typeof request.content !== 'string') {
      throw new CodeEditRefusal(`operation "${request.operation}" requires content`, 'error');
    }
    if (request.content.length > MAX_CONTENT_LENGTH) {
      throw new CodeEditRefusal(`content must be at most ${MAX_CONTENT_LENGTH} characters`, 'error');
    }
    if (request.newName !== undefined) throw new CodeEditRefusal('newName is only accepted by rename', 'error');
  }

  if (request.expectPreviewHash !== undefined) {
    if (typeof request.expectPreviewHash !== 'string' || request.expectPreviewHash.length > 128) {
      throw new CodeEditRefusal('expectPreviewHash must be a string', 'error');
    }
    if (!request.apply) throw new CodeEditRefusal('expectPreviewHash is only meaningful with apply:true', 'error');
  }
}

/** Request identity stored beside an operation id; apply/retry-only fields are deliberately excluded. */
export function editRequestHash(request: CodeEditRequest): string {
  return createHash('sha256').update(JSON.stringify({
    operation: request.operation,
    symbol: request.symbol ?? null,
    file: request.file ?? null,
    line: request.line ?? null,
    column: request.column ?? null,
    newName: request.newName ?? null,
    content: request.content ?? null,
  })).digest('hex');
}

/** Default idempotency key, available before planning so even a direct apply can be retried safely. */
export function operationIdOf(requestHash: string): string {
  return `edit-${requestHash.slice(0, 32)}`;
}

/**
 * A stable hash of the planned change: the same operation on the same bytes produces the same hash,
 * and any difference in target, replacement text or base content produces another. It contains no
 * randomness, so a preview taken in one process matches one taken in another.
 */
export function previewHashOf(operation: CodeEditOperation, files: EditFilePreview[]): string {
  const canonical = JSON.stringify({
    operation,
    files: [...files]
      .sort((a, b) => a.filePath.localeCompare(b.filePath))
      .map((file) => ({
        filePath: file.filePath,
        operation: file.operation,
        movedTo: file.movedTo ?? null,
        baseHash: file.baseHash,
        resultHash: file.resultHash,
        edits: file.edits.map((edit) => [
          edit.startLine, edit.startColumn, edit.endLine, edit.endColumn, edit.newText,
        ]),
      })),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function summarizeEditFiles(files: EditFilePreview[]): CodeEditSummary {
  return {
    files: files.length,
    edits: files.reduce((sum, file) => sum + file.edits.length, 0),
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    previewTruncated: files.some((file) => file.previewTruncated),
  };
}
