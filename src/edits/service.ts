/**
 * Phase 4: the single structured-edit flow.
 *
 * CLI, MCP and library all come through {@link editCode} — there is one implementation of "resolve the
 * target, plan the change, preview it, verify it, write it, refresh the index", so the three faces
 * cannot drift apart.
 *
 * The safety order is deliberate and never reordered:
 *   1. validate the request (an argument that does not belong to the operation is an error, not ignored);
 *   2. resolve the target from the index and refuse a name that is ambiguous or a file whose index row
 *      no longer matches the bytes on disk;
 *   3. plan every file's edit and compute the result **without touching disk**;
 *   4. `apply: false` (the default) stops here and returns the preview;
 *   5. on apply, re-read and stage every target under `.codegraph/edit-transactions/`;
 *   6. commit all files, rolling earlier files back from retained backups if a later commit fails;
 *   7. refresh the index, notify live language servers and persist the terminal result for replay.
 */
import type CodeGraph from '../index';
import type { LspManager } from '../lsp/manager';
import {
  CodeEditRefusal,
  editRequestHash,
  emptyCodeEditResult,
  operationIdOf,
  previewHashOf,
  summarizeEditFiles,
  validateCodeEditRequest,
  type CodeEditRequest,
  type CodeEditResult,
  type EditFilePreview,
} from './contract';
import { planGraphEdit, FRAGMENT_KINDS } from './graph-edit';
import { planRename } from './lsp-rename';
import { resolveEditTarget, toCodeEditTarget } from './target';
import {
  applyEditTransaction,
  completeEditTransaction,
  EditTransactionError,
  markEditTransactionIndexing,
  readRecordedEdit,
} from './transaction';

/** Refresh the index for what was written, so the next query sees the edit instead of the old bytes. */
async function syncIndex(cg: CodeGraph, files: EditFilePreview[]): Promise<{ synced: boolean; indexFiles: number; warnings: string[] }> {
  const warnings: string[] = [];
  const structural = files.some((file) => file.operation === 'delete' || file.operation === 'rename');
  const targets = files
    .filter((file) => file.operation !== 'delete')
    .map((file) => (file.operation === 'rename' ? file.movedTo! : file.filePath));
  try {
    if (structural) {
      // A deletion or a moved file needs the incremental sweep (indexFiles only knows "index these paths").
      const outcome = await cg.sync();
      if (outcome.lockUnavailable) {
        warnings.push(
          'The files were written, but the index writer lock is busy; run `codegraph sync` so queries see the new paths.',
        );
        return { synced: false, indexFiles: 0, warnings };
      }
      return { synced: true, indexFiles: targets.length, warnings };
    }
    if (targets.length > 0) {
      const outcome = await cg.indexFiles(targets);
      if (!outcome.success && outcome.errors.some((error) => error.severity === 'error')) {
        warnings.push(`The index was not fully refreshed: ${outcome.errors.filter((error) => error.severity === 'error').slice(0, 3).map((error) => error.message).join('; ')}`);
        return { synced: false, indexFiles: outcome.filesIndexed, warnings };
      }
      // Extraction writes nodes and syntax edges; resolution is required for the new call edges.
      await cg.resolveReferencesForFiles(targets);
      return { synced: true, indexFiles: outcome.filesIndexed, warnings };
    }
    return { synced: true, indexFiles: 0, warnings };
  } catch (error) {
    warnings.push(`The index could not be refreshed after the edit (${error instanceof Error ? error.message : String(error)}); run \`codegraph sync\` so queries see the new content.`);
    return { synced: false, indexFiles: 0, warnings };
  }
}

function fail(result: CodeEditResult, error: unknown): void {
  if (error instanceof CodeEditRefusal) {
    result.status = error.status;
    result.canApply = false;
    const detail = error.remedy ? `${error.message} — ${error.remedy}` : error.message;
    result.blockers.push(detail);
    result.warnings.push(detail);
    if (result.operation === 'rename' && error.status === 'unavailable') {
      result.routing.lsp = { ...result.routing.lsp, available: false, reason: error.message };
    }
    return;
  }
  result.status = 'error';
  result.canApply = false;
  const detail = error instanceof Error ? error.message : String(error);
  result.blockers.push(detail);
  result.warnings.push(detail);
}

/**
 * The one entry point. `manager` may be a lazily created manager: nothing spawns unless a rename
 * actually asks the language server.
 */
export async function editCode(
  cg: CodeGraph,
  manager: LspManager,
  request: CodeEditRequest,
): Promise<CodeEditResult> {
  const result = emptyCodeEditResult(request.operation ?? 'replace-body', Boolean(request.apply));
  result.projectRoot = cg.getProjectRoot();
  result.operationId = request.operationId ?? null;
  let requestHash: string;

  try {
    validateCodeEditRequest(request);
    requestHash = editRequestHash(request);
    result.operationId = request.operationId ?? operationIdOf(requestHash);
    if (request.apply) {
      const recorded = readRecordedEdit(
        cg.getProjectRoot(), result.operationId, requestHash, request.expectPreviewHash,
      );
      if (recorded) return recorded;
    }
    const target = resolveEditTarget(cg, request);
    result.target = toCodeEditTarget(target, { source: request.operation === 'rename' ? 'lsp' : 'index' });

    if (request.operation === 'rename') {
      const plan = await planRename(cg, manager, request, target);
      result.files = plan.files;
      result.routing.source = 'lsp';
      result.routing.lsp = { requested: true, available: true, family: plan.family, reason: null };
      result.blockers.push(...plan.blockers);
      const needsCrossFileCoverage = plan.files.length > 1
        || plan.files.some((file) => file.edits.some((edit) => edit.plannedBy === 'graph'));
      if (cg.isIndexStale() && needsCrossFileCoverage) {
        const staleIndexBlocker = '索引提取版本过旧，无法证明跨文件重命名覆盖完整；请先运行 codegraph sync --upgrade-index';
        result.blockers.push(staleIndexBlocker);
        result.warnings.push(staleIndexBlocker);
      }
      result.canApply = result.blockers.length === 0;
      result.warnings.push(...plan.warnings);
    } else {
      const planned = planGraphEdit(request, target);
      result.files = [planned];
      result.routing.source = 'index';
      result.canApply = true;
      if (cg.isIndexStale()) {
        result.warnings.push('索引提取版本过旧；当前操作不依赖全项目引用覆盖，但建议运行 codegraph sync --upgrade-index');
      }
      if (request.operation === 'replace-body') {
        // The replaced range is the definition's (modifiers included), which can start earlier than
        // the parser's node — report the range that is actually replaced.
        const edit = planned.edits[0];
        if (edit && result.target) {
          result.target.startLine = edit.startLine;
          result.target.startColumn = edit.startColumn;
          result.target.endLine = edit.endLine;
          result.target.endColumn = edit.endColumn;
        }
        if (target.node && FRAGMENT_KINDS.has(target.node.kind)) {
          result.warnings.push(
            `The index records only part of this ${target.node.kind} declaration, so the replaced range is exactly what files[].edits shows (surrounding keywords, punctuation and attributes stay as they are).`,
          );
        }
      }
    }
  } catch (error) {
    fail(result, error);
    return result;
  }

  result.summary = summarizeEditFiles(result.files);
  result.previewHash = previewHashOf(request.operation, result.files);
  result.operationId ??= operationIdOf(requestHash!);
  if (result.files.length > 0 && result.files.every((file) => file.resultHash === file.baseHash)) {
    result.warnings.push('This change produces content identical to what is already on disk.');
  }

  if (!request.apply) {
    result.status = 'preview';
    result.warnings.push('Nothing was written: this is a preview. Pass apply:true to write it; add expectPreviewHash and this operationId to bind the write to this preview (a mismatch then refuses with status="conflict" instead of writing).');
    return result;
  }

  if (!result.canApply) {
    result.status = 'rejected';
    result.warnings.push('Nothing was written because this rename preview has apply blockers.');
    return result;
  }

  if (request.expectPreviewHash !== undefined && request.expectPreviewHash !== result.previewHash) {
    result.status = 'conflict';
    result.canApply = false;
    const detail = `expectPreviewHash does not match this preview (${result.previewHash}); the file or the request changed since the preview. Nothing was written.`;
    result.blockers.push(detail);
    result.warnings.push(detail);
    return result;
  }

  try {
    const recorded = readRecordedEdit(
      cg.getProjectRoot(), result.operationId, requestHash!, request.expectPreviewHash,
    );
    if (recorded) return recorded;
    result.applied = applyEditTransaction(
      cg.getProjectRoot(), result.operationId, requestHash!, result.previewHash, result.files, result,
    );
  } catch (error) {
    if (error instanceof EditTransactionError) {
      result.applied = error.applied;
      result.warnings.push(...error.applied.warnings);
    }
    fail(result, error);
    if (result.operationId && result.applied) {
      try { completeEditTransaction(cg.getProjectRoot(), result.operationId, result); } catch { /* Keep the original transaction record. */ }
    }
    return result;
  }
  result.status = 'applied';

  markEditTransactionIndexing(cg.getProjectRoot(), result.operationId);
  const synced = await syncIndex(cg, result.files);
  result.applied.indexSynced = synced.synced;
  result.applied.indexFiles = synced.indexFiles;
  result.applied.warnings.push(...synced.warnings);
  result.warnings.push(...synced.warnings);
  const lspWarnings = manager.notifyFileOperations(result.files);
  result.applied.warnings.push(...lspWarnings);
  result.warnings.push(...lspWarnings);
  completeEditTransaction(cg.getProjectRoot(), result.operationId, result);
  return result;
}
