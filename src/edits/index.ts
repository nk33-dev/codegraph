/**
 * Structured editing (phase 4): rename, replace a symbol body, insert before/after a symbol.
 *
 * The public entry point is `CodeGraph.editCode(request)`; MCP's `codegraph_edit` and the CLI's
 * `codegraph edit` are thin faces over it. See `docs/person/structured-edits.md`.
 */
export { editCode } from './service';
export {
  CODE_EDIT_OPERATIONS,
  CODE_EDIT_STATUSES,
  EDIT_FILE_OPERATIONS,
  GRAPH_EDIT_OPERATIONS,
  CodeEditRefusal,
  emptyCodeEditResult,
  editRequestHash,
  operationIdOf,
  previewHashOf,
  sha256,
  summarizeEditFiles,
  validateCodeEditRequest,
  type CodeEditApplied,
  type CodeEditOperation,
  type CodeEditRequest,
  type CodeEditResult,
  type CodeEditRouting,
  type CodeEditStatus,
  type CodeEditSummary,
  type CodeEditTarget,
  type EditFileOperation,
  type EditFilePreview,
  type EditPreviewLine,
  type EditPreviewLineKind,
  type EditTextEdit,
} from './contract';
export {
  PREVIEW_MAX_LINES,
  applyTextEdits,
  buildEditPreview,
  detectEol,
  lineStartOffsets,
  normalizeEol,
  offsetAt,
  positionAt,
  splitLines,
  type Eol,
  type InternalPosition,
  type InternalTextEdit,
} from './text-edits';
export { resolveEditTarget, toCodeEditTarget, type ResolvedEditTarget } from './target';
