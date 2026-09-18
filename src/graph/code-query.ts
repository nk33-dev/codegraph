import * as path from 'path';
import type CodeGraph from '../index';
import type { Edge, GraphStats, Language, Node } from '../types';
import { sortPendingFiles, type PendingFile } from '../sync';
import type { LspCapabilities, LspServerState, LspServerStatus } from '../lsp/manager';
import { indexedFileFreshness, type FileFreshness } from '../sync/file-freshness';
import { isConfigLeafNode, validatePathWithinRoot } from '../utils';
import { lookupSymbolNodes } from './symbol-lookup';
import { analyzeImpact, findAffectedTests, DEFAULT_IMPACT_DEPTH, DEFAULT_TESTS_DEPTH } from './change-impact';
import { collectIncomingRelations } from './incoming-relations';

export const CODE_QUERY_MODES = ['definitions', 'references', 'symbols', 'diagnostics', 'status', 'impact', 'tests'] as const;
export type CodeQueryMode = typeof CODE_QUERY_MODES[number];

/**
 * Query backend (the source the caller's request asks for):
 *   - `graph` = the existing graph index (synchronous, no process);
 *   - `lsp`   = the language server;
 *   - `auto`  = the implementation picks one source from the mode, language, and language-server
 *               availability; when none fits it falls back honestly and says why;
 *   - `both`  = run both sources, label each item's origin, and deduplicate (phase 3).
 *
 * `auto`/`both` are the **request**; `CodeQuerySource` is the source that **actually** produced the data.
 */
export const CODE_QUERY_BACKENDS = ['graph', 'lsp', 'auto', 'both'] as const;
export type CodeQueryBackend = typeof CODE_QUERY_BACKENDS[number];

/** The data source that actually produced the results. */
export const CODE_QUERY_SOURCES = ['graph', 'lsp'] as const;
export type CodeQuerySource = typeof CODE_QUERY_SOURCES[number];

/** Modes both the graph and LSP can answer; only the language server can answer `diagnostics`. */
export const DUAL_SOURCE_MODES: readonly CodeQueryMode[] = ['definitions', 'references', 'symbols', 'impact', 'tests'];

export interface CodeQueryRequest {
  mode: CodeQueryMode;
  query: string;
  /** An exact project-relative path; a wrong file qualifier is not replaced by a fuzzy suffix. */
  file?: string;
  offset?: number;
  limit?: number;
  /** Used only by status + graph: scan the working tree for changes without triggering a sync or building an index. */
  checkFiles?: boolean;
  backend?: CodeQueryBackend;
  /**
   * LSP-only definitions/references: a position-based query. Lines are 1-based, columns 0-based,
   * and the encoding is decided by the backend (graph = UTF-8 bytes, lsp = UTF-16 code units).
   */
  line?: number;
  column?: number;
  /** LSP-only diagnostics: the minimum severity (1=error … 4=hint; default 4 = everything). */
  severity?: number;
  /** LSP-only references: whether the declaration itself counts as a reference (default true). */
  includeDeclaration?: boolean;
  /** impact/tests only: propagation depth (default 2 for impact, 5 for tests; range 1–10). */
  depth?: number;
  /** tests only: the changed-file list; when files is given, query is not parsed for a file list. */
  files?: string[];
  /** tests only: include lower-confidence candidates reached through shared or broad dependency chains. */
  includeIndirect?: boolean;
}

export interface CodeSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: Node['kind'];
  language: Node['language'];
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  parentId: string | null;
  freshness: FileFreshness;
}

export interface CodeReference {
  source: CodeSymbol;
  target: CodeSymbol;
  kind: Edge['kind'];
  provenance: Edge['provenance'] | 'unknown';
  /** Stays null when there is no call-site coordinate; it must not impersonate the source function's definition position. */
  site: { filePath: string; line: number | null; column: number | null };
}

/**
 * One location from an LSP result. The language server returns only positions, not names: when a
 * location matches an index node it carries the name and symbol kind, and when it does not the
 * fields stay null honestly — a name is never guessed and filled in.
 * Paths outside the project root (standard library, dependencies) keep their absolute path and set `external: true`.
 */
export interface LspSymbolItem {
  /** `lsp` = came from a language-server response; `index` = the server had no answer, so this honestly falls back to a graph-index position. */
  source: 'lsp' | 'index';
  filePath: string;
  external: boolean;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  /** null when no index node matches — this means "the position exists but the index has no entry for it", not a failed query. */
  name: string | null;
  kind: Node['kind'] | null;
  language: Language | null;
  /** The node ID when an index node matched; LSP itself provides no stable ID. */
  symbolId: string | null;
}

/** An LSP reference: `target` is this query's symbol and `site` is where the reference occurs. */
export interface LspReferenceItem {
  source: 'lsp';
  kind: 'lsp_usage';
  provenance: 'lsp';
  target: LspSymbolItem;
  site: LspSymbolItem;
}

/** An LSP document symbol outline. `parentIndex` indexes the parent symbol in the **unpaged** results. */
export interface LspDocumentSymbolItem extends LspSymbolItem {
  name: string;
  /** The parent chain joined with `.`: LSP gives only the hierarchy, not a qualified name. */
  qualifiedName: string;
  parentIndex: number | null;
}

export interface LspDiagnosticItem {
  source: 'lsp';
  filePath: string;
  external: boolean;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  code: string | number | null;
  /** The diagnostic provider (such as "rustc" or "typescript"), distinct from the discriminant field `source`. */
  diagnosticSource: string | null;
  symbolId: string | null;
}

/** Edge kinds that carry impact propagation; `lsp_usage` means "a reference reported by the language server". */
export type ImpactVia = Edge['kind'] | 'lsp_usage';

/**
 * One affected symbol in the impact scope (mode=impact).
 *
 * `distance` is the number of steps along "who depends on whom" reverse edges from the changed
 * definition to here (the definition itself is 0, and a container's `contains` children have the
 * same distance as their container); `via` is the evidence for this symbol pointing at a closer
 * node on that path. It describes the **graph's propagation distance**, not "this will definitely break".
 */
export interface ImpactItem extends CodeSymbol {
  distance: number;
  via: ImpactVia[];
  /** The symbol ID of the root definition this query matched (before deduplication). */
  rootId: string;
}

/**
 * One test file in related tests (mode=tests).
 *
 * `reason: "changed"` means the changed file is itself a test; `"dependent"` means a changed file
 * reaches it through dependency edges; `distance` is the number of steps in the file dependency graph
 * (0 for changed).
 */
export interface AffectedTestItem {
  filePath: string;
  language: Language | null;
  distance: number;
  reason: 'changed' | 'dependent';
  confidence: 'direct' | 'high' | 'indirect';
  /** Deduplicated, sorted predecessor files on the shortest path at the selected confidence. */
  via: string[];
}

export type CodeQueryItem =
  | CodeSymbol
  | CodeReference
  | LspSymbolItem
  | LspReferenceItem
  | LspDocumentSymbolItem
  | LspDiagnosticItem
  | ImpactItem
  | AffectedTestItem;

/**
 * An item under `backend: "both"`: the original item's **fields are unchanged**, with origin and
 * corroboration markers appended.
 *
 * `origin` is added instead of reusing an LSP item's `source`: the latter's "index" means "the server
 * did not answer, this is an index position", which is not the same thing as "this item came from the
 * graph backend" — mixing them would collide two different meanings.
 */
export type MergedCodeQueryItem = CodeQueryItem & { origin: CodeQuerySource; corroborated: boolean };

export interface IndexBlock {
  lastIndexedAt: number | null;
  watching: boolean;
  degraded: boolean;
  degradedReason: string | null;
  pendingFiles: PendingFile[];
  pendingFileCount: number;
  pendingReferences: number;
  /** null means no full working-tree scan was done; it does not mean the whole index matches disk. */
  changes: ReturnType<CodeGraph['getChangedFiles']> | null;
  changeCounts: { added: number; modified: number; removed: number } | null;
  stats: GraphStats | null;
}

export interface LspResultBlock {
  server: {
    family: LspServerStatus['family'];
    command: string[];
    resolvedPath: string | null;
    pid: number | null;
    state: LspServerState;
    startedAt: number | null;
    lastUsedAt: number | null;
    requestCount: number;
    capabilities: LspCapabilities | null;
    /** The server is still indexing/analyzing (an unfinished $/progress was received). */
    indexing: boolean;
    stderrTail: string[];
  } | null;
  /** Only status mode returns the status table for every language family. */
  servers: LspServerStatus[] | null;
  documentsOpened: number;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * The routing and shared-service block (added in phase 3).
 *
 * With an explicit `graph`/`lsp` it only describes honestly "what was requested and what was actually
 * used"; with `auto`/`both` it additionally explains **why** that choice was made, whether there was a
 * fallback, how many items each source produced, and how many corroborate each other.
 */
export interface RoutingBlock {
  requested: CodeQueryBackend;
  /** The source combination actually executed: `graph` | `lsp` | `both`. */
  resolved: CodeQueryBackend;
  /** A human-readable reason for the choice; also given for an explicit backend, to help troubleshooting. */
  reason: string;
  /** The reason for falling back from LSP to the graph index (the first one when there was only one fallback), or null if none. */
  fallback: string | null;
  /** The LSP language families involved in this result (chosen by automatic routing based on the language). */
  families: LspServerStatus['family'][];
  /** The number of items each source produced (before merge deduplication). */
  sources: { graph: number; lsp: number };
  /** The number of items the two sources corroborate at the same location. */
  corroborated: number;
  /** Which process produced the result: this process, or the shared daemon (shared across windows). */
  servedBy: 'in-process' | 'shared-daemon';
  /** The shared daemon's pid; null when in-process. */
  daemonPid: number | null;
}

export interface CodeQueryResult {
  schemaVersion: 1;
  backend: CodeQueryBackend;
  mode: CodeQueryMode;
  query: string;
  projectRoot: string | null;
  status: 'ok' | 'not_found' | 'not_indexed' | 'unavailable' | 'error';
  /** Lines are 1-based, columns 0-based; graph uses UTF-8 byte columns and lsp uses UTF-16 code-unit columns. */
  coordinates: { lineBase: 1; columnBase: 0; columnEncoding: 'utf-8' | 'utf-16' };
  ambiguous: boolean;
  items: CodeQueryItem[];
  page: { offset: number; limit: number; total: number; nextOffset: number | null };
  index: IndexBlock | null;
  lsp: LspResultBlock | null;
  /** Which source the request resolved to, why, and whether the shared daemon served it. */
  routing: RoutingBlock;
  warnings: string[];
}

/** The default routing block: the honest description for an explicit backend, overridden per path as needed. */
export function defaultRouting(backend: CodeQueryBackend): RoutingBlock {
  return {
    requested: backend,
    resolved: backend,
    reason: backend === 'graph'
      ? 'backend "graph" was requested explicitly; the query read the index only'
      : 'backend "lsp" was requested explicitly',
    fallback: null,
    families: [],
    sources: { graph: 0, lsp: 0 },
    corroborated: 0,
    servedBy: process.env.CODEGRAPH_DAEMON_INTERNAL === '1' ? 'shared-daemon' : 'in-process',
    daemonPid: process.env.CODEGRAPH_DAEMON_INTERNAL === '1' ? process.pid : null,
  };
}

export function emptyCodeQueryResult(
  mode: CodeQueryMode,
  query: string,
  backend: CodeQueryBackend = 'graph',
): CodeQueryResult {
  return {
    schemaVersion: 1, backend, mode, query, projectRoot: null,
    status: 'ok',
    coordinates: {
      lineBase: 1, columnBase: 0,
      // both = the two sources are merged into one output, all converted to LSP's UTF-16 code-unit columns first.
      columnEncoding: backend === 'graph' ? 'utf-8' : backend === 'lsp' ? 'utf-16' : backend === 'both' ? 'utf-16' : 'utf-8',
    },
    ambiguous: false, items: [], page: { offset: 0, limit: 50, total: 0, nextOffset: null },
    index: null, lsp: null, routing: defaultRouting(backend), warnings: [],
  };
}

export function pageNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Pagination must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Backend-independent validation: the graph query and the LSP query share one set of parameter
 * rules, so the two paths cannot judge the same parameter differently.
 */
export function validateCodeQueryRequest(request: CodeQueryRequest): { offset: number; limit: number } {
  if (!CODE_QUERY_MODES.includes(request.mode)) throw new Error('Unknown code query mode');
  if (request.backend !== undefined && !CODE_QUERY_BACKENDS.includes(request.backend)) {
    throw new Error('backend must be "graph", "lsp", "auto", or "both"');
  }
  if (typeof request.query !== 'string' || request.query.length > 2000) {
    throw new Error('query must be a string of at most 2000 characters');
  }
  // `mode:"tests"` takes the changed files, so a caller may pass them as `files` and leave the
  // query empty. Every other mode is driven by the query string and must carry one.
  const filesInsteadOfQuery = request.mode === 'tests' && (request.files?.length ?? 0) > 0;
  if (!request.query.trim() && !filesInsteadOfQuery) {
    throw new Error('query must be a non-empty string of at most 2000 characters');
  }
  if (request.checkFiles !== undefined && typeof request.checkFiles !== 'boolean') throw new Error('checkFiles must be boolean');
  if (request.checkFiles && request.mode !== 'status') throw new Error('checkFiles is only supported in status mode');
  if (request.line !== undefined && (!Number.isSafeInteger(request.line) || request.line < 1)) {
    throw new Error('line must be a 1-based integer');
  }
  if (request.column !== undefined && (!Number.isSafeInteger(request.column) || request.column < 0)) {
    throw new Error('column must be a non-negative integer');
  }
  if (request.severity !== undefined
    && (!Number.isSafeInteger(request.severity) || request.severity < 1 || request.severity > 4)) {
    throw new Error('severity must be an integer between 1 (error) and 4 (hint)');
  }
  if (request.includeDeclaration !== undefined && typeof request.includeDeclaration !== 'boolean') {
    throw new Error('includeDeclaration must be boolean');
  }
  if (request.depth !== undefined) {
    if (!Number.isSafeInteger(request.depth) || request.depth < 1 || request.depth > 10) {
      throw new Error('depth must be an integer between 1 and 10');
    }
    if (request.mode !== 'impact' && request.mode !== 'tests') {
      throw new Error('depth is only supported in impact or tests mode');
    }
  }
  if (request.files !== undefined) {
    if (!Array.isArray(request.files) || request.files.some((f) => typeof f !== 'string')) {
      throw new Error('files must be an array of project-relative paths');
    }
    if (request.files.length > 500) throw new Error('files accepts at most 500 paths');
    if (request.mode !== 'tests') throw new Error('files is only supported in tests mode');
  }
  if (request.includeIndirect !== undefined) {
    if (typeof request.includeIndirect !== 'boolean') throw new Error('includeIndirect must be boolean');
    if (request.mode !== 'tests') throw new Error('includeIndirect is only supported in tests mode');
  }
  return {
    offset: pageNumber(request.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: pageNumber(request.limit, 50, 1, 200),
  };
}

/** Ownership check for backend-specific fields: rather fail outright than silently ignore a parameter. */
export function assertBackendFields(request: CodeQueryRequest, backend: CodeQuerySource): void {
  const positional = request.line !== undefined || request.column !== undefined;
  if (positional && (request.mode !== 'definitions' && request.mode !== 'references')) {
    throw new Error('line/column are only supported in definitions or references mode');
  }
  if (positional && backend !== 'lsp') throw new Error('line/column require backend "lsp"');
  if (request.severity !== undefined && backend !== 'lsp') throw new Error('severity requires backend "lsp"');
  if (request.severity !== undefined && request.mode !== 'diagnostics') {
    throw new Error('severity is only supported in diagnostics mode');
  }
  if (request.includeDeclaration !== undefined && request.mode !== 'references') {
    throw new Error('includeDeclaration is only supported in references mode');
  }
  if (request.includeDeclaration !== undefined && backend !== 'lsp') {
    throw new Error('includeDeclaration requires backend "lsp"');
  }
  if (request.checkFiles && backend !== 'graph') throw new Error('checkFiles is only supported with backend "graph"');
  if (request.mode === 'diagnostics' && backend !== 'lsp') {
    throw new Error('diagnostics requires backend "lsp": the graph index has no diagnostics');
  }
  if (request.mode === 'tests' && request.file !== undefined) {
    throw new Error('tests mode takes a changed-file list (query or files), not a single file');
  }
}

/** The status list is capped separately, so one branch switch cannot attach tens of thousands of paths to every symbol query. */
const STATE_PATH_LIMIT = 100;

/** The index status block: the graph and lsp paths share one implementation, avoiding two status algorithms. */
export function buildIndexBlock(
  cg: CodeGraph,
  options: { checkFiles: boolean; includeStats: boolean },
): IndexBlock {
  const pending = cg.getPendingFiles();
  const changes = options.checkFiles ? cg.getChangedFiles() : null;
  return {
    lastIndexedAt: cg.getLastIndexedAt(), watching: cg.isWatching(),
    degraded: cg.isWatcherDegraded(), degradedReason: cg.getWatcherDegradedReason(),
    pendingFiles: sortPendingFiles(pending).slice(0, STATE_PATH_LIMIT), pendingFileCount: pending.length,
    pendingReferences: cg.getPendingReferenceCount(),
    changes: changes ? {
      added: changes.added.slice(0, STATE_PATH_LIMIT), modified: changes.modified.slice(0, STATE_PATH_LIMIT),
      removed: changes.removed.slice(0, STATE_PATH_LIMIT),
    } : null,
    changeCounts: changes ? { added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length } : null,
    stats: options.includeStats ? cg.getStats() : null,
  };
}

export function indexWarnings(index: IndexBlock): string[] {
  const warnings: string[] = [];
  if (index.degraded) warnings.push('Auto-sync is disabled; indexed results may be stale.');
  if (index.pendingReferences) warnings.push('Reference resolution is incomplete; results may omit edges.');
  return warnings;
}

function compareNodes(a: Node, b: Node): number {
  return a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine
    || a.startColumn - b.startColumn || a.id.localeCompare(b.id);
}

/** The answerable node scope shared by structured queries: excludes file/import/export/config-leaf nodes and out-of-root paths. */
export function isQueryEligibleNode(root: string, node: Node): boolean {
  return node.kind !== 'file' && node.kind !== 'import' && node.kind !== 'export'
    && !isConfigLeafNode(node) && Boolean(validatePathWithinRoot(root, node.filePath));
}

export { compareNodes };

/**
 * `file` input resolution: an exact project-relative path; an out-of-root path or an empty value is an
 * outright error. Shared by the graph and LSP paths, so the same parameter cannot be judged differently.
 */
export function resolveFileInput(root: string, request: CodeQueryRequest): string | null {
  const raw = request.mode === 'symbols' ? request.file ?? request.query : request.file;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) throw new Error('file must be a non-empty path');
  const normalized = raw.replace(/\\/g, '/');
  if (!validatePathWithinRoot(root, normalized)) throw new Error('file must stay within the project root');
  return path.relative(root, path.resolve(root, normalized)).replace(/\\/g, '/');
}

/** Project-relative path normalization (consistent with the existing CLI/MCP convention: forward slashes, no leading ./). */
export function normalizeToProjectRelative(root: string, raw: string): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  const abs = path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/** The changed-file list for `mode:"tests"`: files takes precedence, otherwise query is split on whitespace/commas. */
export function changedFilesFromRequest(root: string, request: CodeQueryRequest): { files: string[]; invalid: string[] } {
  const raw = request.files !== undefined && request.files.length > 0
    ? [...request.files]
    : request.query.split(/[\s,;]+/).filter(Boolean);
  const files: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rel = normalizeToProjectRelative(root, entry);
    if (rel === null) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return { files, invalid };
}

/** Symbol builder: caches freshness per file, so the same file is not re-checked against disk repeatedly. */
export function makeSymbolBuilder(cg: CodeGraph, root: string): (node: Node) => CodeSymbol {
  const freshness = new Map<string, FileFreshness>();
  return (node: Node): CodeSymbol => {
    let state = freshness.get(node.filePath);
    if (!state) {
      state = indexedFileFreshness(root, cg.getFile(node.filePath));
      freshness.set(node.filePath, state);
    }
    return {
      id: node.id, name: node.name, qualifiedName: node.qualifiedName, kind: node.kind,
      language: node.language, filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
      startColumn: node.startColumn, endColumn: node.endColumn,
      parentId: cg.getIncomingEdges(node.id).find(e => e.kind === 'contains')?.source ?? null,
      freshness: state,
    };
  };
}

/** The graph query shared by CLI/MCP; it only reads the existing index — it neither starts an LSP nor modifies the index. */
export function queryCode(cg: CodeGraph, request: CodeQueryRequest): CodeQueryResult {
  const { offset, limit } = validateCodeQueryRequest(request);
  assertBackendFields(request, 'graph');
  const result = emptyCodeQueryResult(request.mode, request.query.trim(), 'graph');
  const root = cg.getProjectRoot();
  result.projectRoot = root;
  result.page = { offset, limit, total: 0, nextOffset: null };
  result.index = buildIndexBlock(cg, { checkFiles: Boolean(request.checkFiles), includeStats: request.mode === 'status' });
  result.warnings.push(...indexWarnings(result.index));
  if (request.mode === 'status') return result;

  const symbol = makeSymbolBuilder(cg, root);
  const freshnessOf = (items: CodeQueryItem[]): FileFreshness[] =>
    items.map((item) => (item as CodeSymbol).freshness).filter((f): f is FileFreshness => typeof f === 'string');

  if (request.mode === 'tests') {
    const { files, invalid } = changedFilesFromRequest(root, request);
    if (request.files !== undefined && request.files.length > 0 && request.query.trim()) {
      result.warnings.push('files was given, so the query string was ignored as a changed-file list.');
    }
    if (invalid.length > 0) {
      result.warnings.push(`${invalid.length} changed path(s) are outside the project root and were ignored: ${invalid.slice(0, 5).join(', ')}`);
    }
    if (files.length === 0) throw new Error('tests mode needs at least one project-relative changed file');
    const analysis = findAffectedTests(cg, files, {
      depth: request.depth ?? DEFAULT_TESTS_DEPTH,
      includeIndirect: request.includeIndirect === true,
    });
    const unknown = files.filter((f) => !cg.getFile(f));
    if (unknown.length > 0) {
      result.warnings.push(`${unknown.length} changed file(s) are not in the index, so their dependents cannot be known: ${unknown.slice(0, 5).join(', ')}`);
    }
    result.page.total = analysis.tests.length;
    result.items = analysis.tests.slice(offset, offset + limit).map((test) => ({
      filePath: test.filePath,
      language: cg.getFile(test.filePath)?.language ?? null,
      distance: test.distance,
      reason: test.reason,
      confidence: test.confidence,
      via: test.via,
    } satisfies AffectedTestItem));
    if (analysis.tests.length === 0) result.status = 'not_found';
    result.warnings.push('Related tests come from the graph\'s file dependency edges: a missing edge (dynamic require, reflection, unindexed file) means a missed test.');
    if (!request.includeIndirect && analysis.indirectCandidates.length > 0) {
      result.warnings.push(
        `${analysis.indirectCandidates.length} indirect test candidate(s) reached through broad/shared dependency chains were hidden; pass includeIndirect=true to inspect them.`,
      );
    }
    result.routing.sources.graph = analysis.tests.length;
    result.page.nextOffset = offset + result.items.length < result.page.total ? offset + result.items.length : null;
    return result;
  }

  // resolveFileInput uses null for "no file qualifier", while the predicate below tests for undefined:
  // passing null straight through would make every query without a file filter out all nodes.
  const file = resolveFileInput(root, request) ?? undefined;
  const nodes = (request.mode === 'symbols'
    ? cg.getNodesInFile(file!)
    : lookupSymbolNodes(cg, result.query).nodes.filter(n => file === undefined || n.filePath === file))
    .filter((node) => isQueryEligibleNode(root, node)).sort(compareNodes);
  result.ambiguous = request.mode !== 'symbols' && nodes.length > 1;
  if (!nodes.length && request.mode !== 'impact') result.status = 'not_found';

  if (request.mode === 'impact') {
    const depth = request.depth ?? DEFAULT_IMPACT_DEPTH;
    const analysis = nodes.length === 0 ? { entries: new Map(), unattributed: 0 } : analyzeImpact(cg, nodes, depth);
    const ordered = [...analysis.entries.values()]
      .sort((a, b) => compareNodes(a.node, b.node) || a.distance - b.distance || a.rootId.localeCompare(b.rootId));
    result.page.total = ordered.length;
    result.items = ordered.slice(offset, offset + limit).map((entry) => ({
      ...symbol(entry.node), distance: entry.distance, via: entry.via, rootId: entry.rootId,
    } satisfies ImpactItem));
    if (!nodes.length) result.status = 'not_found';
    if (ordered.length > 0) {
      result.warnings.push(`Impact distance is the graph's propagation depth within ${depth} hops, not a guarantee that the symbol breaks; dynamic calls with no resolved edge are invisible.`);
    }
    if (analysis.unattributed > 0) {
      result.warnings.push(`${analysis.unattributed} affected node(s) could not be attributed to a distance from the changed symbol and were left out rather than guessed.`);
    }
    result.routing.sources.graph = ordered.length;
  } else if (request.mode === 'references') {
    const references = collectIncomingRelations(cg, nodes)
      .filter(({ edge, source }) => edge.kind !== 'contains'
        && !isConfigLeafNode(source)
        && Boolean(validatePathWithinRoot(root, source.filePath)));
    result.page.total = references.length;
    result.items = references.slice(offset, offset + limit).map(({ edge, source, target }) => ({
      source: symbol(source), target: symbol(target),
      kind: edge.kind, provenance: edge.provenance ?? 'unknown',
      site: { filePath: source.filePath, line: edge.line ?? null, column: edge.column ?? null },
    }));
    result.warnings.push('Graph edges are best-effort relationships, not a complete list of LSP reference occurrences.');
    result.routing.sources.graph = references.length;
  } else {
    result.page.total = nodes.length;
    result.items = nodes.slice(offset, offset + limit).map(symbol);
    result.routing.sources.graph = nodes.length;
  }
  result.page.nextOffset = offset + result.items.length < result.page.total ? offset + result.items.length : null;
  if (freshnessOf(result.items).some(s => s !== 'current')) {
    result.warnings.push('Some indexed locations differ from disk or could not be verified.');
  }
  return result;
}
