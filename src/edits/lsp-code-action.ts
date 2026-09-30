import * as path from 'path';
import type CodeGraph from '../index';
import type { LspManager, LspPosition, LspWorkspaceEditOperation } from '../lsp/manager';
import { familyForLanguage, type LspFamily } from '../lsp/servers';
import { uriToNormalizedPath } from '../lsp/uri';
import { validatePathWithinRoot } from '../utils';
import {
  CodeEditRefusal,
  sha256,
  type CodeEditRequest,
  type EditFilePreview,
} from './contract';
import type { ResolvedEditTarget } from './target';
import { readFileText } from './target';
import {
  applyTextEdits,
  buildEditPreview,
  detectEol,
  lineStartOffsets,
  normalizeEol,
  offsetAt,
  type InternalTextEdit,
} from './text-edits';

export interface CodeActionPlan {
  files: EditFilePreview[];
  family: LspFamily;
  title: string;
  warnings: string[];
}

function filesFromWorkspaceEdit(root: string, operations: LspWorkspaceEditOperation[]): EditFilePreview[] {
  if (operations.some((operation) => operation.kind !== 'edits')) {
    throw new CodeEditRefusal(
      'the selected code action creates, renames, or deletes files; only text edits are supported',
      'rejected',
      'Apply this action in an IDE, or choose an action that returns ordinary text edits.',
    );
  }
  const grouped = new Map<string, InternalTextEdit[]>();
  for (const operation of operations) {
    const current = grouped.get(operation.uri) ?? [];
    current.push(...operation.edits.map((edit) => ({
      start: edit.range.start,
      end: edit.range.end,
      newText: edit.newText,
      plannedBy: 'lsp' as const,
    })));
    grouped.set(operation.uri, current);
  }

  const files: EditFilePreview[] = [];
  for (const [uri, edits] of grouped) {
    const absolutePath = uriToNormalizedPath(uri);
    if (!absolutePath) throw new CodeEditRefusal(`the code action edits a non-file document: ${uri}`);
    const safePath = validatePathWithinRoot(root, absolutePath);
    if (!safePath) throw new CodeEditRefusal(`the code action would edit a file outside the project root: ${absolutePath}`);
    const relative = path.relative(root, safePath).replace(/\\/g, '/');
    const text = readFileText(safePath);
    const eol = detectEol(text);
    const normalized = edits.map((edit) => ({ ...edit, newText: normalizeEol(edit.newText, eol) }));
    const resultText = applyTextEdits(text, normalized, eol);
    const preview = buildEditPreview(text, normalized, { eol });
    const starts = lineStartOffsets(text);
    files.push({
      filePath: relative,
      operation: 'modify',
      baseHash: sha256(text),
      resultHash: sha256(resultText),
      edits: normalized.map((edit) => ({
        plannedBy: 'lsp',
        startLine: edit.start.line + 1,
        startColumn: edit.start.character,
        endLine: edit.end.line + 1,
        endColumn: edit.end.character,
        oldText: text.slice(offsetAt(text, starts, edit.start), offsetAt(text, starts, edit.end)),
        newText: edit.newText,
      })),
      preview: preview.lines,
      previewTruncated: preview.truncated,
      additions: preview.additions,
      deletions: preview.deletions,
    });
  }
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export async function planCodeAction(
  cg: CodeGraph,
  manager: LspManager,
  request: CodeEditRequest,
  target: ResolvedEditTarget,
): Promise<CodeActionPlan> {
  const family = familyForLanguage(target.language);
  if (!family) throw new CodeEditRefusal('the target file has no configured language server for code actions', 'unavailable');
  const start: LspPosition = target.position!;
  const end: LspPosition = {
    line: (request.endLine ?? request.line!) - 1,
    character: request.endColumn ?? request.column ?? 0,
  };
  const outcome = await manager.codeActions(
    target.absolutePath,
    { start, end },
    target.language,
    request.actionKinds ?? [],
  );
  const index = request.actionIndex ?? 0;
  const action = outcome.items[index];
  if (!action) {
    throw new CodeEditRefusal(
      `no code action exists at index ${index}${outcome.items.length ? ` (available: 0-${outcome.items.length - 1})` : ''}`,
      'not_found',
    );
  }
  if (action.edit.length === 0) {
    throw new CodeEditRefusal(
      action.command
        ? `code action "${action.title}" requires command execution, which CodeGraph does not apply`
        : `code action "${action.title}" returned no file edits`,
      'unavailable',
    );
  }
  return {
    files: filesFromWorkspaceEdit(cg.getProjectRoot(), action.edit),
    family,
    title: action.title,
    warnings: outcome.retried ? ['The language server was still indexing; code actions were retried once.'] : [],
  };
}
