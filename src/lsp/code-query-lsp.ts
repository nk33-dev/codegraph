/**
 * Adapter from LSP queries to the phase-one unified result contract.
 *
 * Three principles:
 *   1. The same `mode` returns the same structure as a graph query (same coordinates/page/status/
 *      warnings semantics); the only differences are `backend`, `coordinates.columnEncoding`,
 *      the `lsp` block, and `source: 'lsp'` on items.
 *   2. Name queries borrow the graph index for locating: the graph says "where this name is", the
 *      language server gives the semantic result. A name absent from the index is never fuzzily
 *      substituted; it is reported as not_found.
 *   3. Language servers return positions, not names, so a match against the index fills in the
 *      name/symbol kind/node ID, and a miss leaves null — symbol information is never fabricated.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { Language, Node } from '../types';
import {
  buildIndexBlock,
  compareNodes,
  emptyCodeQueryResult,
  indexWarnings,
  isQueryEligibleNode,
  makeSymbolBuilder,
  resolveFileInput,
  validateCodeQueryRequest,
  type CodeQueryRequest,
  type CodeQueryResult,
  type CodeQueryItem,
  type ImpactItem,
  type LspDiagnosticItem,
  type LspDocumentSymbolItem,
  type LspReferenceItem,
  type LspResultBlock,
  type LspSymbolItem,
} from '../graph/code-query';
import { assertRoutableMode } from '../graph/code-query-route';
import { lookupSymbolNodes } from '../graph/symbol-lookup';
import { EXTENSION_MAP } from '../extraction/grammars';
import { loadExtensionOverrides } from '../project-config';
import {
  LspUnavailableError,
  SERVER_WARMUP_HINT_MS,
  type LspDiagnostic,
  type LspManager,
  type LspPosition,
  type LspSymbolNode,
} from './manager';
import { LspError } from './protocol';
import { familyForLanguage, type LspFamily } from './servers';
import { uriKey, uriToNormalizedPath } from './uri';

/** Maximum number of files per query that get a documentSymbol fallback (a language server can be slow). */
const MAX_DOCUMENT_SYMBOL_LOOKUPS = 8;
/** Maximum number of candidate definitions a name query sends LSP requests for. */
const MAX_CANDIDATES_DEFINITIONS = 5;
const MAX_CANDIDATES_REFERENCES = 3;

/** UTF-8 byte column → UTF-16 code-unit column (LSP's `character` unit). */
export function byteColumnToUtf16Column(line: string, byteColumn: number): number {
  if (byteColumn <= 0) return 0;
  let bytes = 0;
  let units = 0;
  for (const char of line) {
    if (bytes >= byteColumn) break;
    bytes += Buffer.byteLength(char, 'utf-8');
    units += char.length; // a surrogate pair is 2 code units in UTF-16, which is the JS string length
  }
  return units;
}

/** LSP SymbolKind → CodeGraph NodeKind; anything without a counterpart is null (no forcing a match). */
export function lspSymbolKindToNodeKind(kind: number): Node['kind'] | null {
  switch (kind) {
    case 2: return 'module';
    case 3: return 'namespace';
    case 4: return 'module';
    case 5: return 'class';
    case 6: return 'method';
    case 7: return 'property';
    case 8: return 'field';
    case 9: return 'method';
    case 10: return 'enum';
    case 11: return 'interface';
    case 12: return 'function';
    case 13: return 'variable';
    case 14: return 'constant';
    case 15: return 'constant';
    case 16: return 'constant';
    case 17: return 'constant';
    case 18: return 'variable';
    case 20: return 'variable';
    case 21: return 'variable';
    case 22: return 'variable';
    case 23: return 'struct';
    case 26: return 'type_alias';
    default: return null;
  }
}

const SEVERITY_LABELS: Record<number, LspDiagnosticItem['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

/** Severity sort value; when LSP gives no severity, treat it as information (conservative: filtering never hides errors). */
function severityRank(diagnostic: LspDiagnostic): number {
  return diagnostic.severity ?? 3;
}

function severityLabel(diagnostic: LspDiagnostic): LspDiagnosticItem['severity'] {
  return SEVERITY_LABELS[diagnostic.severity ?? 3] ?? 'information';
}

interface PositionCandidate {
  absPath: string;
  position: LspPosition;
  language: Language | null;
  node: Node | null;
}

interface FlatDocumentSymbol {
  node: LspSymbolNode;
  parentIndex: number | null;
}

function flattenDocumentSymbols(nodes: LspSymbolNode[], parentIndex: number | null, out: FlatDocumentSymbol[]): void {
  for (const node of nodes) {
    const index = out.length;
    out.push({ node, parentIndex });
    flattenDocumentSymbols(node.children, index, out);
  }
}

/** Convert a path inside the project root to a relative path (forward slashes); null outside the root. */
function projectRelative(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/** Whether a is not after b (same line compares columns). */
function positionBefore(a: LspPosition, b: LspPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/** Read the file's lines; null on failure (missing or unreadable file). */
function readLines(absPath: string): string[] | null {
  try {
    return fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Position of a symbol's **name** inside its declaration, used by definition/references requests and
 * by rename (a language server returns nothing for goto-definition or rename on `pub`/`int`/`const`).
 *
 * The graph records the declaration start, so Rust's `pub fn foo` and C's `int foo(...)` both point at
 * column 0. On the declaration line (and up to two lines further, to cover multi-line signatures) the
 * name is found once by word boundary; null means "not found here", and the caller falls back to the
 * node start. TypeScript/Java nodes already point at the name, so nothing changes for them.
 */
export function symbolNamePosition(
  lines: string[],
  node: Pick<Node, 'name' | 'startLine' | 'startColumn'>,
): LspPosition | null {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(node.name)}(?![\\w$])`);
  for (let offset = 0; offset < 3; offset += 1) {
    const lineIndex = node.startLine - 1 + offset;
    const text = lines[lineIndex];
    if (text === undefined) break;
    // On the first line, start searching after the node start to avoid hitting an earlier same-name reference on that line.
    const from = offset === 0
      ? Math.min(byteColumnToUtf16Column(text, node.startColumn), text.length)
      : 0;
    const match = pattern.exec(text.slice(from));
    if (match) return { line: lineIndex, character: from + match.index };
  }
  return null;
}

/**
 * Per-query context: file contents, index nodes and documentSymbols are all cached per file, so a
 * single query reads each file from disk once and asks the server once.
 */
class LspQueryContext {
  private readonly lines = new Map<string, string[] | null>();
  private readonly nodes = new Map<string, Node[]>();
  private readonly documentSymbolCache = new Map<string, LspSymbolNode[] | null>();
  private readonly overrides: Record<string, Language>;
  private symbolLookups = 0;

  constructor(
    readonly cg: CodeGraph,
    readonly manager: LspManager,
    readonly root: string,
  ) {
    this.overrides = loadExtensionOverrides(root);
  }

  relPath(absPath: string): string | null {
    return projectRelative(this.root, absPath);
  }

  /** Paths in results: relative inside the root, absolute and marked external outside it. */
  toResultPath(absPath: string): { filePath: string; external: boolean } {
    const rel = this.relPath(absPath);
    return rel === null
      ? { filePath: absPath.replace(/\\/g, '/'), external: true }
      : { filePath: rel, external: false };
  }

  languageFor(absPath: string): Language | null {
    const rel = this.relPath(absPath);
    if (rel) {
      const record = this.cg.getFile(rel);
      if (record?.language) return record.language;
    }
    const ext = path.extname(absPath).toLowerCase();
    return this.overrides[ext] ?? EXTENSION_MAP[ext] ?? null;
  }

  private fileLines(absPath: string): string[] | null {
    const cached = this.lines.get(absPath);
    if (cached !== undefined) return cached;
    const value = readLines(absPath);
    this.lines.set(absPath, value);
    return value;
  }

  /** Graph node coordinates (1-based line + UTF-8 byte column) to LSP position. */
  private nodePosition(absPath: string, line: number, byteColumn: number): LspPosition {
    const text = this.fileLines(absPath)?.[line - 1] ?? null;
    return {
      line: line - 1,
      character: text === null ? byteColumn : byteColumnToUtf16Column(text, byteColumn),
    };
  }

  /**
   * Position of the symbol **name**, used for definition/references requests; see
   * {@link symbolNamePosition} for why the declaration start is not enough.
   */
  nodeNamePosition(absPath: string, node: Node): LspPosition {
    const lines = this.fileLines(absPath);
    if (lines) {
      const found = symbolNamePosition(lines, node);
      if (found) return found;
    }
    return this.nodePosition(absPath, node.startLine, node.startColumn);
  }

  private nodeContains(absPath: string, node: Node, position: LspPosition): boolean {
    const start = this.nodePosition(absPath, node.startLine, node.startColumn);
    const end = this.nodePosition(absPath, node.endLine, node.endColumn);
    if (position.line < start.line || position.line > end.line) return false;
    if (position.line === start.line && position.character < start.character) return false;
    if (position.line === end.line && position.character > end.character) return false;
    return true;
  }

  nodesInFile(relPath: string): Node[] {
    const cached = this.nodes.get(relPath);
    if (cached) return cached;
    const value = this.cg.getNodesInFile(relPath);
    this.nodes.set(relPath, value);
    return value;
  }

  /** Which index node the position falls inside (the narrowest one); null when nothing matches. */
  graphNodeAt(absPath: string, position: LspPosition): Node | null {
    const rel = this.relPath(absPath);
    if (!rel) return null;
    let best: Node | null = null;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const node of this.nodesInFile(rel)) {
      // A file node is not a symbol: using it as "the symbol at this position" would only yield a misleading name and kind.
      if (node.kind === 'file') continue;
      if (!this.nodeContains(absPath, node, position)) continue;
      const span = (node.endLine - node.startLine) * 1_000_000 + Math.max(0, node.endColumn - node.startColumn);
      if (span < bestSpan) {
        bestSpan = span;
        best = node;
      }
    }
    return best;
  }

  /** Full range of a graph node (UTF-16 columns), for `source: "index"` result items. */
  nodeRangeUtf16(absPath: string, node: Node): { start: LspPosition; end: LspPosition } {
    const lines = this.fileLines(absPath);
    const convert = (line: number, byteColumn: number): LspPosition => {
      const text = lines?.[line - 1] ?? null;
      return {
        line: line - 1,
        character: text === null ? byteColumn : byteColumnToUtf16Column(text, byteColumn),
      };
    };
    return {
      start: this.nodeNamePosition(absPath, node),
      end: convert(node.endLine, node.endColumn),
    };
  }

  /**
   * Find a **use site** in the graph to anchor a definition query.
   *
   * Some servers (rust-analyzer) return nothing for textDocument/definition when the position
   * already is the definition, while querying the same symbol from a call site always works. The
   * graph's calls/references edges carry call-site coordinates, which serve as exactly that anchor.
   */
  usageAnchors(node: Node, cap: number): Array<{ absPath: string; position: LspPosition; language: Language | null }> {
    const out: Array<{ absPath: string; position: LspPosition; language: Language | null }> = [];
    let edges: Array<{ source: string; line?: number | null; column?: number | null; kind: string }>;
    try {
      edges = this.cg.getIncomingEdgesTo([node.id]);
    } catch {
      return out;
    }
    for (const edge of edges) {
      if (edge.kind === 'contains') continue;
      if (typeof edge.line !== 'number' || edge.line < 1) continue;
      const source = this.cg.getNode(edge.source);
      if (!source) continue;
      const rel = this.relPath(path.resolve(this.root, source.filePath));
      if (rel === null) continue;
      const absPath = path.resolve(this.root, source.filePath);
      const lines = this.fileLines(absPath);
      const text = lines?.[edge.line - 1] ?? null;
      const byteColumn = typeof edge.column === 'number' && edge.column >= 0 ? edge.column : 0;
      out.push({
        absPath,
        position: {
          line: edge.line - 1,
          character: text === null ? byteColumn : byteColumnToUtf16Column(text, byteColumn),
        },
        language: source.language,
      });
      if (out.length >= cap) break;
    }
    return out;
  }

  /** Build a result item from the graph node itself (`source: "index"`, labelling faithfully that it did not come from the language server). */
  indexItem(absPath: string, node: Node): LspSymbolItem {
    const { filePath, external } = this.toResultPath(absPath);
    const range = this.nodeRangeUtf16(absPath, node);
    return {
      source: 'index',
      filePath,
      external,
      startLine: range.start.line + 1,
      startColumn: range.start.character,
      endLine: range.end.line + 1,
      endColumn: range.end.character,
      name: node.name,
      kind: node.kind,
      language: node.language,
      symbolId: node.id,
    };
  }

  /** When the index has no entry, fall back to documentSymbol once to get the name and symbol kind. */
  private async lspSymbolAt(
    absPath: string,
    position: LspPosition,
    language: Language | null,
  ): Promise<{ name: string; kind: Node['kind'] | null } | null> {
    if (!this.documentSymbolCache.has(absPath)) {
      if (this.symbolLookups >= MAX_DOCUMENT_SYMBOL_LOOKUPS) return null;
      this.symbolLookups += 1;
      try {
        const outcome = await this.manager.documentSymbols(absPath, language);
        this.documentSymbolCache.set(absPath, outcome.items.length > 0 ? outcome.items : null);
      } catch {
        this.documentSymbolCache.set(absPath, null);
      }
    }
    const symbols = this.documentSymbolCache.get(absPath);
    if (!symbols) return null;

    let bestName: string | null = null;
    let bestKind: Node['kind'] | null = null;
    let bestSpan = Number.POSITIVE_INFINITY;
    const visit = (node: LspSymbolNode): void => {
      const { range } = node;
      if (positionBefore(range.start, position) && positionBefore(position, range.end)) {
        const span = (range.end.line - range.start.line) * 1_000_000
          + Math.max(0, range.end.character - range.start.character);
        if (span < bestSpan) {
          bestSpan = span;
          bestName = node.name;
          bestKind = lspSymbolKindToNodeKind(node.kind);
        }
      }
      for (const child of node.children) visit(child);
    };
    for (const node of symbols) visit(node);
    return bestName === null ? null : { name: bestName, kind: bestKind };
  }

  /** Position → result item, filling in the name and symbol kind wherever possible. */
  async symbolItemAt(
    absPath: string,
    position: LspPosition,
    language: Language | null,
    range?: { start: LspPosition; end: LspPosition },
  ): Promise<LspSymbolItem> {
    const { filePath, external } = this.toResultPath(absPath);
    const node = this.graphNodeAt(absPath, position);
    const span = range ?? { start: position, end: position };
    const base: LspSymbolItem = {
      source: 'lsp',
      filePath,
      external,
      startLine: span.start.line + 1,
      startColumn: span.start.character,
      endLine: span.end.line + 1,
      endColumn: span.end.character,
      name: node?.name ?? null,
      kind: node?.kind ?? null,
      language: node?.language ?? language,
      symbolId: node?.id ?? null,
    };
    if (node) return base;
    const fromServer = await this.lspSymbolAt(absPath, position, language);
    return fromServer === null ? base : { ...base, name: fromServer.name, kind: fromServer.kind };
  }
}

/** Name/position → the position candidates to query. */
function resolveCandidates(
  cg: CodeGraph,
  context: LspQueryContext,
  request: CodeQueryRequest,
  file: string | null,
): { candidates: PositionCandidate[]; total: number; ambiguous: boolean; note: string | null } {
  const root = context.root;
  if (request.line !== undefined) {
    if (!file) throw new Error('line/column queries require a file');
    const absPath = path.resolve(root, file);
    const position: LspPosition = { line: request.line - 1, character: request.column ?? 0 };
    return {
      candidates: [{ absPath, position, language: context.languageFor(absPath), node: context.graphNodeAt(absPath, position) }],
      total: 1,
      ambiguous: false,
      note: null,
    };
  }

  const nodes = lookupSymbolNodes(cg, request.query).nodes
    .filter((node) => file === null || node.filePath === file)
    .filter((node) => isQueryEligibleNode(root, node))
    .sort(compareNodes);

  const cap = request.mode === 'references' ? MAX_CANDIDATES_REFERENCES : MAX_CANDIDATES_DEFINITIONS;
  const candidates = nodes.slice(0, cap).map((node) => {
    const absPath = path.resolve(root, node.filePath);
    return {
      absPath,
      position: context.nodeNamePosition(absPath, node),
      language: node.language,
      node,
    } satisfies PositionCandidate;
  });
  const note = file !== null && nodes.length === 0
    ? `no indexed definition matches "${request.query}" in ${file}`
    : null;
  return { candidates, total: nodes.length, ambiguous: nodes.length > 1, note };
}

function locationKey(uri: string, start: LspPosition, end: LspPosition): string {
  return `${uriKey(uri)}|${start.line}:${start.character}|${end.line}:${end.character}`;
}

function serverBlock(manager: LspManager, family: LspFamily | null): LspResultBlock['server'] {
  if (!family) return null;
  const status = manager.status().find((entry) => entry.family === family);
  if (!status) return null;
  return {
    family: status.family,
    command: status.command,
    resolvedPath: status.resolvedPath,
    pid: status.pid,
    state: status.state,
    startedAt: status.startedAt,
    lastUsedAt: status.lastUsedAt,
    requestCount: status.requestCount,
    capabilities: status.capabilities,
    indexing: status.indexing,
    // stderr is only attached when something actually went wrong; normal queries carry no noise.
    stderrTail: status.lastError ? status.stderrTail.slice(-10) : [],
  };
}

function buildLspBlock(manager: LspManager, family: LspFamily | null, includeServers: boolean): LspResultBlock {
  const timeouts = manager.getTimeouts();
  const servers = manager.status();
  return {
    server: serverBlock(manager, family),
    servers: includeServers ? servers : null,
    documentsOpened: servers.reduce((sum, entry) => sum + entry.openDocuments, 0),
    idleTimeoutMs: timeouts.idleTimeoutMs,
    requestTimeoutMs: timeouts.requestTimeoutMs,
  };
}

/** Cross-file semantics degrade noticeably in clangd without compile_commands.json; say so up front. */
function compileDbWarning(root: string): string | null {
  const candidates = ['compile_commands.json', path.join('build', 'compile_commands.json')];
  if (candidates.some((rel) => fs.existsSync(path.join(root, rel)))) return null;
  return 'clangd found no compile_commands.json (project root or build/), so cross-file definitions and references may be incomplete; point lsp.json args at --compile-commands-dir to fix that.';
}

function applyFailure(result: CodeQueryResult, error: unknown): void {
  if (error instanceof LspUnavailableError) {
    result.status = 'unavailable';
    result.warnings.push(`${error.message}. ${error.remedy}`);
    return;
  }
  if (error instanceof LspError) {
    result.status = 'error';
    const prefix = error.kind === 'timeout' ? 'Language server request timed out' : 'Language server error';
    result.warnings.push(`${prefix}: ${error.message}`);
    return;
  }
  result.status = 'error';
  result.warnings.push(error instanceof Error ? error.message : String(error));
}

/** Non-file: URIs (such as jdt.ls's jdt://) are carried back as-is and marked external. */
function uriOnlyItem(uri: string, range: { start: LspPosition; end: LspPosition }): LspSymbolItem {
  return {
    source: 'lsp',
    filePath: uri,
    external: true,
    startLine: range.start.line + 1,
    startColumn: range.start.character,
    endLine: range.end.line + 1,
    endColumn: range.end.character,
    name: null,
    kind: null,
    language: null,
    symbolId: null,
  };
}

/** Reconstruct the qualified name along the parentIndex chain (parents first, joined by `.`). */
function qualifiedNameOf(flat: FlatDocumentSymbol[], entry: FlatDocumentSymbol): string {
  const parts = [entry.node.name];
  let parent = entry.parentIndex;
  let guard = 0;
  while (parent !== null && guard < 32) {
    const parentEntry = flat[parent];
    if (!parentEntry) break;
    parts.unshift(parentEntry.node.name);
    parent = parentEntry.parentIndex;
    guard += 1;
  }
  return parts.join('.');
}

/**
 * Unified entry point: CLI/MCP structured mode comes here when `backend: "lsp"`.
 * `cg` is used only for "name → position" and graph enrichment; LSP requests all go to the manager.
 */
export async function queryCodeLsp(
  cg: CodeGraph,
  manager: LspManager,
  request: CodeQueryRequest,
): Promise<CodeQueryResult> {
  const { offset, limit } = validateCodeQueryRequest(request);
  assertRoutableMode(request, 'lsp');
  const result = emptyCodeQueryResult(request.mode, request.query.trim(), 'lsp');
  const root = cg.getProjectRoot();
  result.projectRoot = root;
  result.page = { offset, limit, total: 0, nextOffset: null };
  result.index = buildIndexBlock(cg, { checkFiles: false, includeStats: request.mode === 'status' });
  result.warnings.push(...indexWarnings(result.index));

  if (request.mode === 'status') {
    result.lsp = buildLspBlock(manager, null, true);
    return result;
  }

  const file = resolveFileInput(root, request);
  if ((request.mode === 'diagnostics' || request.mode === 'symbols') && !file) {
    throw new Error(`mode "${request.mode}" requires a project-relative file`);
  }

  const context = new LspQueryContext(cg, manager, root);
  const language = file ? context.languageFor(path.resolve(root, file)) : null;
  let family: LspFamily | null = familyForLanguage(language);

  try {
    switch (request.mode) {
      case 'diagnostics': {
        const absPath = path.resolve(root, file!);
        const { items, source, retried } = await manager.diagnostics(absPath, language);
        if (source === 'none') {
          result.warnings.push('No diagnostics arrived within the wait window (neither a pull response nor publishDiagnostics); the server may not have analyzed this file yet.');
        } else if (source === 'cache') {
          result.warnings.push('Diagnostics come from the last published batch and may not reflect the current content.');
        }
        if (retried) result.warnings.push('The first diagnostics request came back empty right after startup; it was retried after the server finished indexing.');
        const threshold = request.severity ?? 4;
        const kept = items
          .filter((item) => severityRank(item) <= threshold)
          .sort((a, b) => a.range.start.line - b.range.start.line
            || a.range.start.character - b.range.start.character
            || a.message.localeCompare(b.message));
        const { filePath, external } = context.toResultPath(absPath);
        result.page.total = kept.length;
        result.items = kept.slice(offset, offset + limit).map((item) => ({
          source: 'lsp',
          filePath,
          external,
          startLine: item.range.start.line + 1,
          startColumn: item.range.start.character,
          endLine: item.range.end.line + 1,
          endColumn: item.range.end.character,
          severity: severityLabel(item),
          message: item.message,
          code: item.code,
          diagnosticSource: item.source,
          symbolId: context.graphNodeAt(absPath, item.range.start)?.id ?? null,
        } satisfies LspDiagnosticItem));
        if (kept.length === 0) result.status = 'not_found';
        break;
      }

      case 'symbols': {
        const absPath = path.resolve(root, file!);
        const outcome = await manager.documentSymbols(absPath, language);
        if (outcome.retried) result.warnings.push('The first request came back empty right after startup; it was retried after the server finished indexing.');
        const symbols = outcome.items;
        if (symbols.length === 0) {
          result.status = 'not_found';
          break;
        }
        const flat: FlatDocumentSymbol[] = [];
        flattenDocumentSymbols(symbols, null, flat);
        const { filePath, external } = context.toResultPath(absPath);
        result.page.total = flat.length;
        result.items = flat.slice(offset, offset + limit).map((entry) => {
          const node = context.graphNodeAt(absPath, entry.node.selectionRange.start);
          return {
            source: 'lsp',
            filePath,
            external,
            startLine: entry.node.range.start.line + 1,
            startColumn: entry.node.range.start.character,
            endLine: entry.node.range.end.line + 1,
            endColumn: entry.node.range.end.character,
            name: entry.node.name,
            qualifiedName: qualifiedNameOf(flat, entry),
            kind: lspSymbolKindToNodeKind(entry.node.kind),
            language: node?.language ?? language,
            symbolId: node?.id ?? null,
            parentIndex: entry.parentIndex,
          } satisfies LspDocumentSymbolItem;
        });
        break;
      }

      case 'definitions':
      case 'references': {
        const resolved = resolveCandidates(cg, context, request, file);
        result.ambiguous = resolved.ambiguous;
        if (resolved.note) result.warnings.push(resolved.note);
        if (resolved.candidates.length === 0) {
          result.status = 'not_found';
          break;
        }
        if (resolved.total > resolved.candidates.length) {
          result.warnings.push(`${resolved.total} candidate definitions matched; only the first ${resolved.candidates.length} were queried — pass file to pin one.`);
        }

        const seen = new Set<string>();
        const items: CodeQueryItem[] = [];
        let sawExternal = false;
        let warmupRetried = false;
        let indexFallbacks = 0;
        for (const candidate of resolved.candidates) {
          if (family === null) family = familyForLanguage(candidate.language);
          const outcome = request.mode === 'definitions'
            ? await manager.definition(candidate.absPath, candidate.position, candidate.language)
            : await manager.references(
                candidate.absPath,
                candidate.position,
                candidate.language,
                request.includeDeclaration ?? true,
              );
          if (outcome.retried) warmupRetried = true;
          let locations = outcome.items;

          // When the definition query is empty, ask again using the graph's use sites (rust-analyzer returns nothing on the definition itself).
          if (locations.length === 0 && request.mode === 'definitions' && request.line === undefined && candidate.node) {
            for (const anchor of context.usageAnchors(candidate.node, 2)) {
              if (anchor.absPath === candidate.absPath
                && anchor.position.line === candidate.position.line
                && anchor.position.character === candidate.position.character) continue;
              const retry = await manager.definition(anchor.absPath, anchor.position, anchor.language);
              if (retry.items.length > 0) {
                locations = retry.items;
                break;
              }
            }
          }

          // Still empty, but the index really does hold a definition for this name: faithfully return
          // the indexed location as source:"index" instead of calling "the server did not answer" a
          // "no definition".
          if (locations.length === 0 && request.mode === 'definitions'
            && request.line === undefined && candidate.node) {
            const indexItem = context.indexItem(path.resolve(root, candidate.node.filePath), candidate.node);
            const key = `index|${indexItem.filePath}|${indexItem.startLine}:${indexItem.startColumn}`;
            if (!seen.has(key)) {
              seen.add(key);
              indexFallbacks += 1;
              items.push(indexItem);
            }
          }

          const target = request.mode === 'references'
            ? await context.symbolItemAt(candidate.absPath, candidate.position, candidate.language)
            : null;
          for (const location of locations) {
            const key = locationKey(location.uri, location.range.start, location.range.end);
            if (seen.has(key)) continue;
            seen.add(key);
            const absPath = uriToNormalizedPath(location.uri);
            if (absPath === null) {
              sawExternal = true;
              const site = uriOnlyItem(location.uri, location.range);
              items.push(request.mode === 'references' && target
                ? ({ source: 'lsp', kind: 'lsp_usage', provenance: 'lsp', target, site } satisfies LspReferenceItem)
                : site);
              continue;
            }
            const site = await context.symbolItemAt(absPath, location.range.start, context.languageFor(absPath), location.range);
            if (site.external) sawExternal = true;
            items.push(request.mode === 'references' && target
              ? ({ source: 'lsp', kind: 'lsp_usage', provenance: 'lsp', target, site } satisfies LspReferenceItem)
              : site);
          }
        }

        result.page.total = items.length;
        result.items = items.slice(offset, offset + limit);
        if (warmupRetried) {
          result.warnings.push('The first request came back empty right after startup; it was retried after the server finished indexing.');
        }
        if (indexFallbacks > 0) {
          result.warnings.push(`${indexFallbacks} item(s) come from the index (source="index"): the language server returned no definition at those positions, so the indexed location is reported as such instead of being passed off as an LSP result.`);
        }
        if (items.length === 0) {
          result.status = 'not_found';
          const status = serverBlock(manager, family);
          if (status?.startedAt && Date.now() - status.startedAt < SERVER_WARMUP_HINT_MS) {
            result.warnings.push('The language server just started and may still be indexing; retrying the same query shortly may return results.');
          }
        }
        if (sawExternal) {
          result.warnings.push('Results include locations outside the project (standard library, dependencies, or virtual-document URIs); those are absolute paths or URIs with no node in the index.');
        }
        if (request.mode === 'references') {
          result.warnings.push('LSP references come from the language server and include the declaration itself by default (pass includeDeclaration=false to drop it); that set differs from the graph index\'s reference edges.');
        }
        if (family === 'cpp') {
          const warning = compileDbWarning(root);
          if (warning) result.warnings.push(warning);
        }
        break;
      }

      case 'impact': {
        // The LSP version's impact is **one hop**: the symbol containing the reference. Distance comes
        // from graph propagation, so distance=1 / via=["lsp_usage"] is labelled faithfully here
        // without pretending there is transitive depth.
        const resolved = resolveCandidates(cg, context, request, file);
        result.ambiguous = resolved.ambiguous;
        if (resolved.note) result.warnings.push(resolved.note);
        if (resolved.candidates.length === 0) {
          result.status = 'not_found';
          break;
        }
        const symbol = makeSymbolBuilder(cg, root);
        const seen = new Set<string>();
        const items: CodeQueryItem[] = [];
        let unattributable = 0;
        let warmupRetried = false;
        for (const candidate of resolved.candidates) {
          if (family === null) family = familyForLanguage(candidate.language);
          const outcome = await manager.references(candidate.absPath, candidate.position, candidate.language, false);
          if (outcome.retried) warmupRetried = true;
          for (const location of outcome.items) {
            const absPath = uriToNormalizedPath(location.uri);
            const enclosing = absPath === null ? null : context.graphNodeAt(absPath, location.range.start);
            if (!enclosing || enclosing.kind === 'file') {
              // Location outside the project or no symbol in the index: count this hop faithfully instead of inventing a symbol.
              unattributable += 1;
              continue;
            }
            if (seen.has(enclosing.id)) continue;
            seen.add(enclosing.id);
            items.push({
              ...symbol(enclosing), distance: 1, via: ['lsp_usage'], rootId: candidate.node?.id ?? '',
            } satisfies ImpactItem);
          }
        }
        const ordered = items.sort((a, b) => (a as ImpactItem).filePath.localeCompare((b as ImpactItem).filePath)
          || (a as ImpactItem).startLine - (b as ImpactItem).startLine
          || (a as ImpactItem).name.localeCompare((b as ImpactItem).name));
        result.page.total = ordered.length;
        result.items = ordered.slice(offset, offset + limit);
        if (warmupRetried) result.warnings.push('The first request came back empty right after startup; it was retried after the server finished indexing.');
        if (ordered.length === 0) result.status = 'not_found';
        if (unattributable > 0) {
          result.warnings.push(`${unattributable} reference site(s) could not be attributed to an indexed symbol (outside the project, or no node covers that position) and were left out.`);
        }
        result.warnings.push('LSP impact is one hop — the symbols containing a reference to the queried definition — and has no transitive distance; use backend "graph" or "both" for propagation depth.');
        break;
      }

      default:
        throw new Error(`unsupported LSP mode "${request.mode}"`);
    }
  } catch (error) {
    applyFailure(result, error);
  }

  result.lsp = buildLspBlock(manager, family, false);
  if (result.lsp.server?.indexing) {
    result.warnings.push('The language server is still indexing; results may be incomplete. Retry this query after indexing finishes.');
  }
  result.page.nextOffset = offset + result.items.length < result.page.total ? offset + result.items.length : null;
  result.routing.families = family ? [family] : [];
  result.routing.sources.lsp = result.page.total;
  return result;
}
