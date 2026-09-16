/**
 * Target resolution for the edit path (phase 4).
 *
 * An edit must land on exactly one symbol in exactly one file, so this module is deliberately
 * stricter than a query: the name is resolved through the index (never by scanning text), an
 * ambiguous name is refused with the candidates listed, and the file's index row must still match
 * the bytes on disk — editing at positions the index only *believes* are current is how a tool
 * silently mangles a file.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { Language, Node } from '../types';
import { compareNodes, isQueryEligibleNode, normalizeToProjectRelative } from '../graph/code-query';
import { lookupSymbolNodes } from '../graph/symbol-lookup';
import { indexedFileFreshness, type FileFreshness } from '../sync/file-freshness';
import { EXTENSION_MAP } from '../extraction/grammars';
import { loadExtensionOverrides } from '../project-config';
import { byteColumnToUtf16Column } from '../lsp/code-query-lsp';
import { validatePathWithinRoot } from '../utils';
import { CodeEditRefusal, type CodeEditRequest, type CodeEditTarget } from './contract';
import { lineStartOffsets, offsetAt, type InternalPosition } from './text-edits';

/** How many candidate names an ambiguity message lists before it stops (the message, not the check, is capped). */
const MAX_AMBIGUOUS_LISTED = 5;

export interface ResolvedEditTarget {
  /** The index node the operation applies to; null only for a position-based rename with no covering node. */
  node: Node | null;
  /** Project-relative path (forward slashes). */
  filePath: string;
  /** Absolute path (resolved against the project root). */
  absolutePath: string;
  language: Language | null;
  freshness: FileFreshness;
  /** The file's current text on disk (the same bytes every position in this edit refers to). */
  text: string;
  /** Set when the target came from `file` + `line`, not from a name. */
  position: InternalPosition | null;
}

export function readFileText(absolutePath: string): string {
  try {
    return fs.readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    throw new CodeEditRefusal(`cannot read ${absolutePath}: ${(error as Error).message}`, 'error');
  }
}

/** Exact project-relative path resolution: the same rule as a query's file qualifier (no fuzzy suffix). */
export function resolveProjectFile(root: string, raw: string): string {
  const relative = normalizeToProjectRelative(root, raw);
  if (relative === null || validatePathWithinRoot(root, relative) === null) {
    throw new CodeEditRefusal('file must stay within the project root');
  }
  return relative;
}

export function languageOfFile(cg: CodeGraph, root: string, filePath: string): Language | null {
  const record = cg.getFile(filePath);
  if (record?.language) return record.language;
  const extension = path.extname(filePath).toLowerCase();
  return loadExtensionOverrides(root)[extension] ?? EXTENSION_MAP[extension] ?? null;
}

/** The narrowest index node that contains a position; a `file` node is not a symbol and never wins. */
export function nodeAtPosition(nodes: Node[], text: string, position: InternalPosition): Node | null {
  let best: Node | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.kind === 'file') continue;
    const range = nodeRangePositions(text, node);
    if (position.line < range.start.line || position.line > range.end.line) continue;
    if (position.line === range.start.line && position.character < range.start.character) continue;
    if (position.line === range.end.line && position.character > range.end.character) continue;
    const span = (range.end.line - range.start.line) * 1_000_000 + Math.max(0, range.end.character - range.start.character);
    if (span < bestSpan) {
      bestSpan = span;
      best = node;
    }
  }
  return best;
}

/** Graph node coordinates (1-based line + UTF-8 byte column) → 0-based UTF-16 position. */
export function nodeRangePositions(
  text: string,
  node: Pick<Node, 'startLine' | 'startColumn' | 'endLine' | 'endColumn'>,
): { start: InternalPosition; end: InternalPosition } {
  const lines = text.split(/\r\n|\r|\n/);
  const convert = (line: number, byteColumn: number): InternalPosition => {
    const lineText = lines[line - 1];
    return {
      line: line - 1,
      character: lineText === undefined ? byteColumn : byteColumnToUtf16Column(lineText, byteColumn),
    };
  };
  return {
    start: convert(node.startLine, node.startColumn),
    end: convert(node.endLine, node.endColumn),
  };
}

export function toCodeEditTarget(
  target: ResolvedEditTarget,
  options: { source: 'index' | 'lsp'; positioned?: boolean },
): CodeEditTarget {
  const range = target.node
    ? nodeRangePositions(target.text, target.node)
    : {
        start: target.position!,
        end: target.position!,
      };
  return {
    source: options.source,
    filePath: target.filePath,
    startLine: range.start.line + 1,
    startColumn: range.start.character,
    endLine: range.end.line + 1,
    endColumn: range.end.character,
    name: target.node?.name ?? null,
    qualifiedName: target.node?.qualifiedName ?? null,
    kind: target.node?.kind ?? null,
    language: target.language,
    symbolId: target.node?.id ?? null,
    freshness: target.freshness,
  };
}

/**
 * Resolve the request to one symbol in one file.
 *
 * `file` + `line` (+ `column`) is a position target (rename only) and bypasses name matching; every
 * other request resolves the name through the same lookup a structured query uses.
 */
export function resolveEditTarget(cg: CodeGraph, request: CodeEditRequest): ResolvedEditTarget {
  const root = cg.getProjectRoot();
  const positional = request.line !== undefined;

  if (positional) {
    if (!request.file) throw new CodeEditRefusal('a position target needs a file', 'error');
    const filePath = resolveProjectFile(root, request.file);
    const absolutePath = path.resolve(root, filePath);
    const text = readFileText(absolutePath);
    const freshness = indexedFileFreshness(root, cg.getFile(filePath), text);
    const starts = lineStartOffsets(text);
    const position: InternalPosition = { line: request.line! - 1, character: request.column ?? 0 };
    // Validate the position against the current bytes here (not later): a line or column past the
    // end must be a clear refusal, not an edit that silently lands somewhere else.
    offsetAt(text, starts, position);
    const node = nodeAtPosition(cg.getNodesInFile(filePath), text, position);
    if (freshness !== 'current') {
      throw new CodeEditRefusal(
        `${filePath} is not current in the index (${freshness}); run \`codegraph sync\` before editing at a recorded position`,
        freshness === 'missing' ? 'not_found' : 'stale',
        'Run `codegraph sync` (or let the watcher catch up) and repeat the query so the position is current.',
      );
    }
    return {
      node,
      filePath,
      absolutePath,
      language: languageOfFile(cg, root, filePath),
      freshness,
      text,
      position,
    };
  }

  const file = request.file !== undefined ? resolveProjectFile(root, request.file) : null;
  const nodes = lookupSymbolNodes(cg, request.symbol!.trim()).nodes
    .filter((node) => file === null || node.filePath === file)
    .filter((node) => isQueryEligibleNode(root, node))
    .sort(compareNodes);

  if (nodes.length === 0) {
    throw new CodeEditRefusal(
      file === null
        ? `no indexed definition matches "${request.symbol}"`
        : `no indexed definition matches "${request.symbol}" in ${file}`,
      'not_found',
      'Query with mode "definitions" to find the exact name (or pass the file it is defined in).',
    );
  }
  if (nodes.length > 1) {
    const listed = nodes.slice(0, MAX_AMBIGUOUS_LISTED)
      .map((node) => `${node.filePath}:${node.startLine} (${node.kind} ${node.qualifiedName})`);
    throw new CodeEditRefusal(
      `"${request.symbol}" matches ${nodes.length} definitions; pass file (and a qualified name) to pin one: ${listed.join(', ')}`,
      'ambiguous',
    );
  }

  const node = nodes[0]!;
  const absolutePath = path.resolve(root, node.filePath);
  const text = readFileText(absolutePath);
  const freshness = indexedFileFreshness(root, cg.getFile(node.filePath), text);
  if (freshness !== 'current') {
    throw new CodeEditRefusal(
      `${node.filePath} is not current in the index (${freshness}); the edit was refused rather than applied at a stale position`,
      freshness === 'missing' ? 'not_found' : 'stale',
      'Run `codegraph sync`, then query the symbol again so the positions come from the current index.',
    );
  }
  return {
    node,
    filePath: node.filePath,
    absolutePath,
    language: languageOfFile(cg, root, node.filePath),
    freshness,
    text,
    position: null,
  };
}
