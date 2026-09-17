/**
 * `rename` (phase 4): the language server produces the edits, CodeGraph previews and applies them.
 *
 * Why rename is the one operation that requires a language server: a name can occur in strings, in
 * comments, in a different scope with the same spelling, and in files the index has no edge for.
 * Replacing the spellings the graph happens to know about would be a guess, and a wrong guess in a
 * write path is not something a caller can ignore — so with no usable server this reports
 * `unavailable` instead of approximating.
 *
 * The whole WorkspaceEdit is validated and previewed **before anything is written**: every target must
 * live inside the project root, every range must be valid for the bytes on disk, and an edit kind this
 * code does not understand refuses the entire rename rather than applying the part it understands.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import { byteColumnToUtf16Column, symbolNamePosition } from '../lsp/code-query-lsp';
import {
  LspUnavailableError,
  type LspManager,
  type LspPosition,
  type LspWorkspaceEditOperation,
} from '../lsp/manager';
import { LspError } from '../lsp/protocol';
import { familyForLanguage, type LspFamily } from '../lsp/servers';
import { uriToNormalizedPath } from '../lsp/uri';
import { validatePathWithinRoot } from '../utils';
import { indexedFileFreshness } from '../sync/file-freshness';
import {
  CodeEditRefusal,
  sha256,
  type CodeEditRequest,
  type EditFilePreview,
} from './contract';
import {
  applyTextEdits,
  buildEditPreview,
  detectEol,
  lineStartOffsets,
  normalizeEol,
  type InternalTextEdit,
} from './text-edits';
import { nodeAtPosition, nodeRangePositions, readFileText, type ResolvedEditTarget } from './target';

export interface RenamePlan {
  files: EditFilePreview[];
  family: LspFamily | null;
  warnings: string[];
}

interface GraphRenameLocation {
  filePath: string;
  line: number;
  column: number;
  kind: 'definition' | 'reference';
}

const RENAME_REFERENCE_KINDS = new Set([
  'calls', 'imports', 'exports', 'extends', 'implements', 'references',
  'type_of', 'returns', 'instantiates', 'overrides', 'decorates',
]);

/** Project-relative path of an absolute path inside the root; null when it is outside (or not a file). */
function toProjectRelative(root: string, absolutePath: string): string | null {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (validatePathWithinRoot(root, absolutePath) === null) return null;
  return relative.replace(/\\/g, '/');
}

/**
 * 用 Graph 已知的静态引用核对 LSP WorkspaceEdit 的覆盖范围。
 * Graph 只充当安全哨兵，不生成替代编辑；启发式边没有可靠文本位置，因此不参与拒绝判断。
 */
function graphRenameLocations(
  cg: CodeGraph,
  target: ResolvedEditTarget,
  warnings: string[],
): GraphRenameLocation[] {
  if (!target.node) return [];
  const root = cg.getProjectRoot();
  const name = target.node.name;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_$])`, 'gu');
  const linesByFile = new Map<string, string[]>([[target.filePath, target.text.split(/\r\n|\r|\n/)]]);
  const locations = new Map<string, GraphRenameLocation>();
  const add = (location: GraphRenameLocation): void => {
    const key = `${location.filePath}:${location.line}:${location.column}`;
    if (!locations.has(key)) locations.set(key, location);
  };

  const definition = symbolNamePosition(linesByFile.get(target.filePath)!, target.node);
  if (!definition) throw new CodeEditRefusal('Cannot locate the indexed definition name for rename coverage.', 'stale');
  add({ filePath: target.filePath, line: definition.line + 1, column: definition.character, kind: 'definition' });
  let unverified = 0;
  for (const edge of cg.getIncomingEdges(target.node.id)) {
    if (!RENAME_REFERENCE_KINDS.has(edge.kind) || edge.provenance === 'heuristic' || edge.metadata?.synthesizedBy) continue;
    const source = cg.getNode(edge.source);
    if (!source) continue;
    let lines = linesByFile.get(source.filePath);
    if (!lines) {
      const absolute = validatePathWithinRoot(root, source.filePath);
      if (!absolute) throw new CodeEditRefusal('An indexed reference is outside the project root.');
      const text = readFileText(absolute);
      if (indexedFileFreshness(root, cg.getFile(source.filePath), text) !== 'current') {
        throw new CodeEditRefusal(`${source.filePath}: reference locations are stale; run \`codegraph sync\` before renaming.`, 'stale');
      }
      lines = text.split(/\r\n|\r|\n/);
      linesByFile.set(source.filePath, lines);
    }
    const lineText = edge.line ? lines[edge.line - 1] ?? '' : '';
    const matches = [...lineText.matchAll(pattern)];
    const column = edge.column === undefined ? null : byteColumnToUtf16Column(lineText, edge.column);
    const match = column === null ? (matches.length === 1 ? matches[0] : undefined)
      : matches.find((candidate) => candidate.index! >= column);
    if (!match) {
      // 别名和跨行关系不一定含原名；无可靠文本位置时只能报告未核实，不能猜测补改。
      unverified += 1;
      continue;
    }
    add({ filePath: source.filePath, line: edge.line!, column: match.index!, kind: 'reference' });
  }
  if (unverified > 0) {
    warnings.push(`${unverified} graph relationship(s) have no verifiable original-name location (for example aliases); their rename coverage is unverified.`);
  }
  return [...locations.values()];
}

/** 行列请求可能指向调用者内部，必须先解析定义，不能把外层函数当成重命名目标。 */
async function renameCoverageTarget(
  cg: CodeGraph,
  manager: LspManager,
  target: ResolvedEditTarget,
): Promise<ResolvedEditTarget | null> {
  if (!target.position) return target;
  const localName = target.node && target.node.kind !== 'import' && target.node.kind !== 'export'
    ? symbolNamePosition(target.text.split(/\r\n|\r|\n/), target.node) : null;
  if (localName && localName.line === target.position.line
    && target.position.character >= localName.character
    && target.position.character < localName.character + target.node!.name.length) return target;

  const definitions = await manager.definition(target.absolutePath, target.position, target.language);
  const candidates = new Map<string, ResolvedEditTarget>();
  for (const location of definitions.items) {
    const absolutePath = uriToNormalizedPath(location.uri);
    const filePath = absolutePath ? toProjectRelative(cg.getProjectRoot(), absolutePath) : null;
    if (!absolutePath || !filePath) continue;
    const text = readFileText(absolutePath);
    const freshness = indexedFileFreshness(cg.getProjectRoot(), cg.getFile(filePath), text);
    if (freshness !== 'current') continue;
    const node = nodeAtPosition(cg.getNodesInFile(filePath), text, location.range.start);
    if (!node || node.kind === 'import' || node.kind === 'export') continue;
    const namePosition = symbolNamePosition(text.split(/\r\n|\r|\n/), node);
    if (!namePosition || namePosition.line < location.range.start.line || namePosition.line > location.range.end.line
      || (namePosition.line === location.range.start.line && namePosition.character < location.range.start.character)
      || (namePosition.line === location.range.end.line && namePosition.character >= location.range.end.character)) continue;
    candidates.set(node.id, { node, filePath, absolutePath, text, freshness, language: node.language, position: null });
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

function missingGraphRenameLocations(
  locations: GraphRenameLocation[],
  files: EditFilePreview[],
  oldName: string,
): GraphRenameLocation[] {
  const editsByFile = new Map(files.map((file) => [file.filePath, file.edits]));
  return locations.filter((location) => {
    const edits = editsByFile.get(location.filePath) ?? [];
    return !edits.some((edit) =>
      edit.oldText.includes(oldName) && edit.newText !== edit.oldText
      && (edit.startLine < location.line || (edit.startLine === location.line && edit.startColumn <= location.column))
      && (edit.endLine > location.line || (edit.endLine === location.line && edit.endColumn >= location.column + oldName.length))
    );
  });
}

/**
 * Plan a rename: ask the language server, then turn the workspace edit into per-file previews.
 * Throws {@link CodeEditRefusal} / {@link LspUnavailableError} / {@link LspError} rather than returning
 * a half-built plan.
 */
export async function planRename(
  cg: CodeGraph,
  manager: LspManager,
  request: CodeEditRequest,
  target: ResolvedEditTarget,
): Promise<RenamePlan> {
  const root = cg.getProjectRoot();
  const warnings: string[] = [];
  const language = target.language;
  const family = familyForLanguage(language);
  if (!family) {
    throw new CodeEditRefusal(
      language
        ? `no language server is mapped to "${language}" in this phase, so rename is unavailable`
        : 'the target file has no recognized language, so no language server can rename it',
      'unavailable',
      'Rename is available for C, C++, JavaScript, TypeScript, Rust, Go, Java and Python; edit other files directly.',
    );
  }
  if (!target.position && target.node && target.node.name === request.newName) {
    throw new CodeEditRefusal(`"${request.newName}" is already the symbol's name; refusing a no-op rename`);
  }

  let position: LspPosition;
  if (target.position) {
    position = target.position;
  } else {
    const node = target.node!;
    const lines = target.text.split(/\r\n|\r|\n/);
    position = symbolNamePosition(lines, node)
      ?? nodeRangePositions(target.text, node).start;
  }

  const newName = request.newName!;
  let operations: LspWorkspaceEditOperation[];
  try {
    const outcome = await manager.rename(target.absolutePath, position, language, newName);
    operations = outcome.items;
    if (outcome.retried) {
      warnings.push('The language server was still indexing; the rename was retried once after indexing finished.');
    }
  } catch (error) {
    if (error instanceof LspUnavailableError) {
      throw new CodeEditRefusal(error.message, 'unavailable', error.remedy);
    }
    if (error instanceof LspError) {
      const status = error.kind === 'unsupported' ? 'rejected' : 'error';
      throw new CodeEditRefusal(`the language server could not compute the rename: ${error.message}`, status);
    }
    throw error;
  }

  if (operations.length === 0) {
    throw new CodeEditRefusal(
      `the ${family} language server returned no rename edits for this symbol`,
      'unavailable',
      'The symbol may be a built-in, a macro or otherwise not renamable; edit the file directly instead.',
    );
  }

  const editsByUri = new Map<string, InternalTextEdit[]>();
  const renames: Array<{ from: string; to: string }> = [];
  const creates = new Set<string>();
  const deletes = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === 'edits') {
      const edits = editsByUri.get(operation.uri) ?? [];
      for (const edit of operation.edits) {
        edits.push({
          start: edit.range.start,
          end: edit.range.end,
          newText: edit.newText,
        });
      }
      editsByUri.set(operation.uri, edits);
    } else if (operation.kind === 'rename') {
      renames.push({ from: operation.uri, to: operation.newUri! });
    } else if (operation.kind === 'create') {
      creates.add(operation.uri);
    } else {
      deletes.add(operation.uri);
    }
  }

  const uris = new Set<string>([
    ...editsByUri.keys(), ...renames.map((entry) => entry.from), ...renames.map((entry) => entry.to),
    ...creates, ...deletes,
  ]);
  const renameTargets = new Set(renames.map((entry) => entry.to));
  const renameSources = new Set(renames.map((entry) => entry.from));

  const files: EditFilePreview[] = [];
  const outside = new Set<string>();
  for (const uri of uris) {
    // A rename destination is already described by its source entry's `movedTo`; only a server that
    // also sends edits for the destination (which no editor does) would need separate handling.
    if (renameTargets.has(uri) && !renameSources.has(uri)) {
      if ((editsByUri.get(uri) ?? []).length > 0) {
        throw new CodeEditRefusal(
          'the workspace edit also edits the destination of a file rename; refusing an ambiguous change',
          'rejected',
        );
      }
      continue;
    }
    const absolutePath = uriToNormalizedPath(uri);
    if (absolutePath === null) {
      throw new CodeEditRefusal(
        `the rename would edit a document that is not a file: ${uri}`,
        'rejected',
        'A workspace edit outside the file system (a virtual document) cannot be applied; open the file in an editor instead.',
      );
    }
    const relative = toProjectRelative(root, absolutePath);
    if (relative === null) {
      outside.add(absolutePath);
      continue;
    }

    const edits = editsByUri.get(uri) ?? [];
    const isCreate = creates.has(uri);
    const isDelete = deletes.has(uri);
    const renameTo = renames.find((entry) => entry.from === uri);
    const movedAbsolute = renameTo ? uriToNormalizedPath(renameTo.to) : null;
    const movedTo = movedAbsolute === null ? null : toProjectRelative(root, movedAbsolute);

    if (isDelete && edits.length > 0) {
      throw new CodeEditRefusal(
        `${relative}: the workspace edit deletes the file and also edits it; refusing an ambiguous change`,
        'rejected',
      );
    }
    if (renameTo && movedTo === null) {
      throw new CodeEditRefusal(
        `${relative}: the rename would move the file outside the project root; refused`,
        'rejected',
      );
    }

    if (isDelete) {
      files.push({
        filePath: relative, operation: 'delete', baseHash: sha256(readFileText(absolutePath)), resultHash: null,
        edits: [], preview: [{ kind: 'gap', line: null, text: `delete ${relative}` }], previewTruncated: false,
        additions: 0, deletions: 0,
      });
      continue;
    }

    let text = '';
    let baseHash: string | null = null;
    if (isCreate) {
      if (fs.existsSync(absolutePath)) {
        throw new CodeEditRefusal(
          `${relative}: the workspace edit creates a file that already exists; refused`,
          'rejected',
        );
      }
    } else {
      text = readFileText(absolutePath);
      baseHash = sha256(text);
      if (edits.length === 0 && !renameTo) {
        throw new CodeEditRefusal(
          `${relative}: the workspace edit has no edits for this file; refusing an empty change`,
          'rejected',
        );
      }
    }

    const eol = detectEol(text);
    const normalizedEdits = edits.map((edit) => ({ ...edit, newText: normalizeEol(edit.newText, eol) }));
    let resultText: string;
    if (normalizedEdits.length === 0) {
      resultText = text;
    } else {
      try {
        resultText = applyTextEdits(text, normalizedEdits, eol);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CodeEditRefusal(
          `${relative}: the language server's edit does not fit the file on disk (${detail})`,
          'conflict',
          'The language server may hold a different version of the file; queries and edits run against the working tree, so sync and retry.',
        );
      }
    }
    const preview = normalizedEdits.length > 0
      ? buildEditPreview(text, normalizedEdits, { eol })
      : { lines: [], additions: 0, deletions: 0, truncated: false };

    files.push({
      filePath: relative,
      operation: renameTo ? 'rename' : isCreate ? 'create' : 'modify',
      baseHash,
      resultHash: sha256(resultText),
      ...(movedTo ? { movedTo } : {}),
      edits: normalizedEdits.map((edit) => ({
        startLine: edit.start.line + 1,
        startColumn: edit.start.character,
        endLine: edit.end.line + 1,
        endColumn: edit.end.character,
        oldText: originalTextOf(text, lineStartOffsets(text), edit),
        newText: edit.newText,
      })),
      preview: preview.lines,
      previewTruncated: preview.truncated,
      additions: preview.additions,
      deletions: preview.deletions,
    });
  }

  if (outside.size > 0) {
    const listed = [...outside].slice(0, 5).join(', ');
    throw new CodeEditRefusal(
      `the rename would modify ${outside.size} file(s) outside the project root (${listed}); refused`,
      'rejected',
      'Only files inside the indexed project are edited; rename the external references in their own project.',
    );
  }
  if (files.length === 0) {
    throw new CodeEditRefusal('the language server returned a workspace edit with no file changes', 'rejected');
  }

  let coverageTarget: ResolvedEditTarget | null;
  try {
    coverageTarget = await renameCoverageTarget(cg, manager, target);
  } catch (error) {
    coverageTarget = null;
    warnings.push(`Could not resolve the rename definition for coverage: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!coverageTarget) {
    const message = 'The position could not be mapped to one current indexed definition; cross-file rename coverage is unverified.';
    if (request.apply) throw new CodeEditRefusal(message, 'rejected', 'Retry with the exact symbol name and definition file after syncing the index.');
    warnings.push(`${message} Apply will be refused; retry with the symbol name and definition file.`);
  }
  const graphLocations = coverageTarget ? graphRenameLocations(cg, coverageTarget, warnings) : [];
  if (graphLocations.length > 0 && coverageTarget?.node) {
    const missing = missingGraphRenameLocations(graphLocations, files, coverageTarget.node.name);
    if (missing.length > 0) {
      const references = graphLocations.filter((location) => location.kind === 'reference').length;
      const covered = graphLocations.length - missing.length;
      const samples = missing
        .slice(0, 5)
        .map((location) => `${location.filePath}:${location.line}:${location.column}`)
        .join(', ');
      const message =
        `Graph knows ${references} reference location(s) plus the definition, but the language server ` +
        `covered only ${covered}/${graphLocations.length}; possible omissions: ${samples}`;
      if (request.apply) {
        throw new CodeEditRefusal(
          `${message}. Refusing to apply an incomplete cross-file rename.`,
          'rejected',
          'Review the preview and fix the language-server project configuration (for example, include excluded test files) before retrying.',
        );
      }
      warnings.push(`${message}. Nothing is applied by this preview; apply will be refused until the coverage gap is resolved.`);
    }
  }
  if (files.length > 1) {
    warnings.push(`The rename touches ${files.length} files; the preview lists every one and all files are verified before writing starts.`);
  }
  files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { files, family, warnings };
}

/** The text an edit currently replaces, computed on the original file content. */
function originalTextOf(text: string, starts: number[], edit: InternalTextEdit): string {
  const start = starts[edit.start.line]! + edit.start.character;
  const end = starts[edit.end.line]! + edit.end.character;
  return text.slice(start, end);
}
