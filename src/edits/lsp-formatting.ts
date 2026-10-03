/**
 * `format` (phase 4): a language server's whole-file formatting, planned through the same
 * preview → verify → transaction path as every other edit. The server decides the edits; CodeGraph
 * only proves they stay inside the project root and writes them atomically (or not at all).
 */
import type CodeGraph from '../index';
import type { LspManager } from '../lsp/manager';
import { familyForLanguage, type LspFamily } from '../lsp/servers';
import { pathToUri } from '../lsp/uri';
import { CodeEditRefusal, type CodeEditRequest, type EditFilePreview } from './contract';
import { filesFromWorkspaceEdit } from './lsp-code-action';
import type { ResolvedEditTarget } from './target';

export interface FormattingPlan {
  files: EditFilePreview[];
  family: LspFamily;
  warnings: string[];
}

export async function planFormatting(
  cg: CodeGraph,
  manager: LspManager,
  request: CodeEditRequest,
  target: ResolvedEditTarget,
): Promise<FormattingPlan> {
  const family = familyForLanguage(target.language);
  if (!family) {
    throw new CodeEditRefusal('the target file has no configured language server for formatting', 'unavailable');
  }
  const outcome = await manager.formatting(target.absolutePath, target.language, {
    tabSize: request.tabSize ?? 2,
    insertSpaces: request.insertSpaces ?? true,
  });
  const warnings = outcome.retried
    ? ['The language server was still indexing; formatting was retried once.']
    : [];
  if (outcome.items.length === 0) {
    // Not an error: an already-formatted file legitimately produces no edits. An empty plan keeps
    // canApply false and says so instead of writing identical bytes.
    warnings.push('The language server returned no formatting edits (the file is already formatted, or the server cannot format it).');
    return { files: [], family, warnings };
  }
  const files = filesFromWorkspaceEdit(cg.getProjectRoot(), [{
    kind: 'edits',
    uri: pathToUri(target.absolutePath),
    edits: outcome.items,
    newUri: null,
  }]);
  return { files, family, warnings };
}
