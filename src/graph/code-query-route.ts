/**
 * Unified routing and merging (phase 3).
 *
 * Two kinds of "multi-source" request:
 *   - `backend: "auto"` — **pick one** source. The choice is decided by the mode and language-server
 *     availability; when none fits it falls back honestly to the graph index and writes the "why" into
 *     `routing`. auto never merges: one answer can have only one coordinate system, and merging is
 *     `both`'s job.
 *   - `backend: "both"` — **run both, then merge**. Each row is labeled with its origin (`origin`), and
 *     the same location hit by both sources at once is marked `corroborated`. The merged result is
 *     reported uniformly in UTF-16 code-unit columns: the graph index stores UTF-8 byte columns, which
 *     are converted here from the line text on disk; an item that cannot be converted keeps its byte
 *     columns and declares `columnEncoding: "utf-8"` **on the item**, rather than letting the caller
 *     assume it is UTF-16.
 *
 * Two boundaries are labeled honestly:
 *   1. `diagnostics` can be answered only by the language server; auto picks lsp directly and returns
 *      unavailable when none fits;
 *   2. `tests` can be answered only by the graph (the language server has no notion of "test
 *      association"), so auto/both go through the graph.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { Language } from '../types';
import { EXTENSION_MAP } from '../extraction/grammars';
import { loadExtensionOverrides } from '../project-config';
import { byteColumnToUtf16Column } from '../lsp/code-query-lsp';
import { type LspFamily } from '../lsp/servers';
import {
  assertBackendFields,
  sourcePathPriority,
  buildIndexBlock,
  emptyCodeQueryResult,
  isQueryEligibleNode,
  normalizeToProjectRelative,
  validateCodeQueryRequest,
  type CodeQueryItem,
  type CodeQueryRequest,
  type CodeQueryResult,
  type CodeQuerySource,
  type MergedCodeQueryItem,
} from './code-query';
import { lookupSymbolNodes } from './symbol-lookup';

/** Whether a language server can currently be used for a language (without starting any process). */
export interface LspAvailability {
  family: LspFamily | null;
  available: boolean;
  /** The unavailable reason (not configured / not installed / disabled). */
  reason: string | null;
  command: string[];
}

export interface RouteDecision {
  /** The source combination to actually execute. */
  resolved: 'graph' | 'lsp' | 'both';
  reason: string;
  /** The original reason when the language server is unavailable, used for the fallback explanation. */
  unavailable: string | null;
  family: LspFamily | null;
}

export interface CodeQueryRouteDeps {
  /** The explicit graph query (synchronous, no process). */
  queryGraph(request: CodeQueryRequest): CodeQueryResult;
  /** The explicit LSP query (may start a language server). */
  queryLsp(request: CodeQueryRequest): Promise<CodeQueryResult>;
  /** Availability probe for a language's server, without starting a process. */
  lspAvailability(language: Language | null): LspAvailability;
}

const MERGE_SOURCE_PAGE_SIZE = 200;

/** 合并前取全两侧结果，避免把调用方的 offset 在单侧和合并结果上重复应用。 */
async function collectSourceResult(
  query: (request: CodeQueryRequest) => CodeQueryResult | Promise<CodeQueryResult>,
  request: CodeQueryRequest,
): Promise<CodeQueryResult> {
  const first = await query({ ...request, offset: 0, limit: MERGE_SOURCE_PAGE_SIZE });
  if (first.items.length >= first.page.total) return first;

  const items = [...first.items];
  let expectedTotal = first.page.total;
  let changedWhileReading = false;
  while (items.length < expectedTotal) {
    const page = await query({ ...request, offset: items.length, limit: MERGE_SOURCE_PAGE_SIZE });
    if (page.page.total !== expectedTotal) {
      expectedTotal = page.page.total;
      changedWhileReading = true;
    }
    if (page.items.length === 0) break;
    items.push(...page.items);
  }

  const complete = items.length >= expectedTotal;
  return {
    ...first,
    items,
    page: { offset: 0, limit: MERGE_SOURCE_PAGE_SIZE, total: items.length, nextOffset: null },
    warnings: changedWhileReading || !complete
      ? [
          ...first.warnings,
          'The source result changed while backend "both" was collecting its pages; the merged result contains the stable pages that were returned.',
        ]
      : first.warnings,
  };
}

const NO_PHASE_LANGUAGE_REASON = 'no language server is mapped to that language in this phase (C, C++, JavaScript, TypeScript, Rust, Go, Java)';

/**
 * The decision rules for `auto` (a pure function, easy to unit test): mode → language → server
 * availability, narrowing at each layer. Every branch gives a human-readable reason, so "why did this
 * one use the graph" never has to be guessed.
 */
export function decideRoute(
  request: CodeQueryRequest,
  language: Language | null,
  availability: LspAvailability,
): RouteDecision {
  const requested = request.backend ?? 'graph';
  const family = availability.family;

  if (request.mode === 'diagnostics') {
    return {
      resolved: 'lsp',
      reason: 'diagnostics exist only in language servers; the graph index has none',
      unavailable: availability.available ? null : availability.reason,
      family,
    };
  }
  if (request.mode === 'tests') {
    return {
      resolved: 'graph',
      reason: 'related tests come from the file dependency graph; a language server reports references, not test associations',
      unavailable: null,
      family: null,
    };
  }
  if (request.mode === 'status') {
    // status starts no process: it returns the graph status and the status table for every language family at once.
    return {
      resolved: 'both',
      reason: 'status reports the index and every language-server family without starting any server',
      unavailable: null,
      family: null,
    };
  }
  if (request.line !== undefined || request.column !== undefined) {
    // A position query (file + line + column) has no graph version: the index can only answer
    // by NAME. So the choice is lsp or nothing — never a name match dressed up as "the
    // definition at this position". `both` is refused here for the same reason.
    return {
      resolved: 'lsp',
      reason: `the query names a position (file + line + column), which only a ${family ?? 'language'} server resolves; the graph index cannot answer it and no fallback is attempted`,
      unavailable: availability.available ? null : availability.reason,
      family,
    };
  }
  if (requested === 'both') {
    return {
      resolved: 'both',
      reason: 'both backends were requested; the graph result and the language-server result are merged and deduplicated by location',
      unavailable: availability.available ? null : availability.reason,
      family,
    };
  }
  if (!language) {
    return {
      resolved: 'graph',
      reason: 'the query names no indexed symbol and no file, so no language (and therefore no language server) could be chosen',
      unavailable: null,
      family: null,
    };
  }
  if (!family) {
    return { resolved: 'graph', reason: `"${language}" has no language server in this phase; the graph index answered`, unavailable: NO_PHASE_LANGUAGE_REASON, family: null };
  }
  if (!availability.available) {
    return {
      resolved: 'graph',
      reason: `the ${family} language server is not available (${availability.reason ?? 'unknown reason'}); the graph index answered instead`,
      unavailable: availability.reason,
      family,
    };
  }
  if (request.mode === 'impact') {
    return {
      resolved: 'graph',
      reason: `impact needs transitive propagation depth, which the graph computes directly; ask backend "both" to add the ${family} server's usage sites`,
      unavailable: null,
      family,
    };
  }
  return {
    resolved: 'lsp',
    reason: `the ${family} language server is configured and its executable was found, so the semantic answer comes from it; the graph index is used if it fails or returns nothing`,
    unavailable: null,
    family,
  };
}

/** The language the query points at: a file qualifier takes precedence, otherwise the first node found in the index by name. */
export function languageForQuery(cg: CodeGraph, request: CodeQueryRequest): Language | null {
  const root = cg.getProjectRoot();
  const hint = (request.mode === 'symbols' || request.mode === 'diagnostics') ? request.file ?? request.query : request.file;
  if (hint) {
    const rel = normalizeToProjectRelative(root, hint);
    if (rel) {
      const record = cg.getFile(rel);
      if (record?.language) return record.language;
      const extension = path.extname(rel).toLowerCase();
      const language = loadExtensionOverrides(root)[extension] ?? EXTENSION_MAP[extension] ?? null;
      if (language) return language;
    }
  }
  if (request.mode === 'tests' || request.mode === 'status') return null;
  try {
    const nodes = lookupSymbolNodes(cg, request.query).nodes.filter((node) => isQueryEligibleNode(root, node));
    return nodes.find((node) => node.language)?.language ?? null;
  } catch {
    return null;
  }
}

/** Per-query line cache: byte-column conversion for graph items reads each file from disk only once. */
class LineCache {
  private readonly lines = new Map<string, string[] | null>();

  line(root: string, filePath: string, line: number): string | null {
    let cached = this.lines.get(filePath);
    if (cached === undefined) {
      try {
        cached = fs.readFileSync(path.resolve(root, filePath), 'utf-8').split(/\r?\n/);
      } catch {
        cached = null;
      }
      this.lines.set(filePath, cached);
    }
    return cached?.[line - 1] ?? null;
  }
}

function isLspItem(item: CodeQueryItem): boolean {
  return (item as { source?: unknown }).source === 'lsp' || (item as { source?: unknown }).source === 'index';
}

/**
 * The cross-source deduplication key: **location (file + line) + name**, excluding the column.
 *
 * Excluding the column is deliberate: the graph index stores the declaration start (`export function
 * run` at column 0) while the language server returns the name range (column 7); using the column as
 * part of the key would treat one location as two, and deduplication and "corroboration" would never
 * hold. Treating the same name on the same line as the same location is the only equivalence relation
 * that stands up in this contract.
 */
function mergeKey(item: CodeQueryItem): string {
  const position = (filePath: string | null, line: number | null, name: string | null): string =>
    `${filePath ?? '?'}|${line ?? '?'}|${name ?? ''}`;
  if (isLspItem(item)) {
    const reference = item as { site?: { filePath?: string; startLine?: number }; target?: { name?: string | null } };
    if (reference.site && reference.target) {
      return position(reference.site.filePath ?? null, reference.site.startLine ?? null, reference.target.name ?? null);
    }
    const location = item as { filePath?: string; startLine?: number; name?: string | null; message?: string; code?: string | number | null };
    if (location.message !== undefined) {
      return position(location.filePath ?? null, location.startLine ?? null, String(location.code ?? location.message));
    }
    return position(location.filePath ?? null, location.startLine ?? null, location.name ?? null);
  }
  const reference = item as { site?: { filePath?: string; line?: number | null }; target?: { name?: string } };
  if (reference.site && reference.target) {
    return position(reference.site.filePath ?? null, reference.site.line ?? null, reference.target.name ?? null);
  }
  const test = item as { reason?: string; filePath?: string };
  if (test.reason !== undefined) return position(test.filePath ?? null, null, null);
  const symbol = item as { filePath?: string; startLine?: number; name?: string };
  return position(symbol.filePath ?? null, symbol.startLine ?? null, symbol.name ?? null);
}

/** Graph item UTF-8 byte column → UTF-16 code-unit column; when the file cannot be read, the original value is kept and labeled honestly. */
function toUtf16Item(
  root: string,
  item: CodeQueryItem,
  lines: LineCache,
): MergedCodeQueryItem {
  const convert = (filePath: string, line: number | null, column: number | null): number | null => {
    if (column === null || line === null) return column;
    const text = lines.line(root, filePath, line);
    return text === null ? column : byteColumnToUtf16Column(text, column);
  };

  const reference = item as { site?: { filePath: string; line: number | null; column: number | null }; source?: { filePath: string; startLine: number; startColumn: number; endLine: number; endColumn: number }; target?: { filePath: string; startLine: number; startColumn: number; endLine: number; endColumn: number } };
  if (reference.site && reference.target && reference.source) {
    const convertSide = <T extends { filePath: string; startLine: number; startColumn: number; endLine: number; endColumn: number }>(side: T): T => ({
      ...side,
      startColumn: convert(side.filePath, side.startLine, side.startColumn) ?? side.startColumn,
      endColumn: convert(side.filePath, side.endLine, side.endColumn) ?? side.endColumn,
    });
    return {
      ...(item as object),
      source: reference.source ? convertSide(reference.source) : reference.source,
      target: convertSide(reference.target),
      site: { ...reference.site, column: convert(reference.site.filePath, reference.site.line, reference.site.column) },
      origin: 'graph',
      corroborated: false,
    } as MergedCodeQueryItem;
  }

  const symbol = item as { filePath?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number; name?: string };
  if (symbol.filePath === undefined || symbol.startColumn === undefined) {
    return { ...(item as object), origin: 'graph', corroborated: false } as MergedCodeQueryItem;
  }
  const startColumn = convert(symbol.filePath, symbol.startLine ?? null, symbol.startColumn);
  const endColumn = convert(symbol.filePath, symbol.endLine ?? null, symbol.endColumn ?? null);
  // A column is present but the line text cannot be read = conversion failed: keep the byte column and declare on the item that it is UTF-8.
  const unreadable = symbol.startColumn > 0 && lines.line(root, symbol.filePath, symbol.startLine ?? 1) === null;
  return {
    ...(item as object),
    startColumn: startColumn ?? symbol.startColumn,
    endColumn: endColumn ?? symbol.endColumn ?? null,
    origin: 'graph',
    corroborated: false,
    ...(unreadable ? { columnEncoding: 'utf-8' as const } : {}),
  } as MergedCodeQueryItem;
}

function compareItems(a: MergedCodeQueryItem, b: MergedCodeQueryItem): number {
  const position = (item: MergedCodeQueryItem): { filePath: string; line: number; column: number; name: string } => {
    const anyItem = item as Record<string, any>;
    const site = anyItem.site as { filePath?: string; line?: number; startLine?: number; startColumn?: number } | undefined;
    if (site) {
      return {
        filePath: site.filePath ?? '',
        line: site.line ?? site.startLine ?? 0,
        column: site.startColumn ?? 0,
        name: anyItem.target?.name ?? '',
      };
    }
    return {
      filePath: anyItem.filePath ?? '',
      line: anyItem.startLine ?? anyItem.line ?? 0,
      column: anyItem.startColumn ?? 0,
      name: anyItem.name ?? '',
    };
  };
  const left = position(a);
  const right = position(b);
  return (('distance' in a && 'distance' in b && typeof a.distance === 'number' && typeof b.distance === 'number') ? a.distance - b.distance : 0)
    || sourcePathPriority(left.filePath) - sourcePathPriority(right.filePath) || left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column
    || left.name.localeCompare(right.name) || a.origin.localeCompare(b.origin);
}

export interface MergeOutcome {
  items: MergedCodeQueryItem[];
  /** The number of items the two sources corroborate at the same location. */
  corroborated: number;
}

/** Merge items from two sources: deduplicate by location, prefer the language server, and mark corroboration when the same location is hit. */
export function mergeItems(
  root: string,
  graphItems: CodeQueryItem[],
  lspItems: CodeQueryItem[],
  lines = new LineCache(),
): MergeOutcome {
  const graph = graphItems.map((item) => toUtf16Item(root, item, lines));
  const lsp = lspItems.map((item) => ({ ...(item as object), origin: 'lsp', corroborated: false } as MergedCodeQueryItem));

  const graphKeys = new Set(graph.map(mergeKey));
  const lspKeys = new Set(lsp.map(mergeKey));
  let corroborated = 0;

  const merged: MergedCodeQueryItem[] = [];
  for (const item of lsp) {
    const corroborates = graphKeys.has(mergeKey(item));
    if (corroborates) corroborated += 1;
    merged.push(corroborates ? { ...item, corroborated: true } : item);
  }
  for (const item of graph) {
    if (lspKeys.has(mergeKey(item))) continue;
    merged.push(item);
  }
  merged.sort(compareItems);
  return { items: merged, corroborated };
}

function mergeWarnings(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const warning of list) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      out.push(warning);
    }
  }
  return out;
}

/**
 * Project the same request onto one source: keep only the fields that source accepts.
 *
 * Without this, `backend:"both"` would fail outright on the other path because of a source-specific
 * field (`includeDeclaration` for the graph, `checkFiles` for LSP) — while the caller asked to "try
 * both". The dropped fields are **concepts that source does not have at all** (the graph's reference
 * edges never include the declaration itself, and LSP has no whole-working-tree change detection), not
 * meaningful parameters silently ignored.
 */
export function projectRequest(request: CodeQueryRequest, source: CodeQuerySource): CodeQueryRequest {
  return {
    mode: request.mode,
    query: request.query,
    backend: source,
    ...(request.file !== undefined ? { file: request.file } : {}),
    ...(request.offset !== undefined ? { offset: request.offset } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(source === 'graph' && request.files !== undefined ? { files: request.files } : {}),
    ...(source === 'graph' && request.includeIndirect !== undefined ? { includeIndirect: request.includeIndirect } : {}),
    ...(source === 'graph' && request.checkFiles ? { checkFiles: true } : {}),
    ...(source === 'lsp' && request.line !== undefined ? { line: request.line } : {}),
    ...(source === 'lsp' && request.column !== undefined ? { column: request.column } : {}),
    ...(source === 'lsp' && request.severity !== undefined ? { severity: request.severity } : {}),
    ...(source === 'lsp' && request.includeDeclaration !== undefined ? { includeDeclaration: request.includeDeclaration } : {}),
  };
}

/**
 * The unified entry point: structured queries from CLI/MCP are dispatched here. When `backend` is
 * omitted or explicitly graph/lsp, the behavior is exactly as in phases 1/2; only `auto`/`both` reach
 * routing and merging.
 */
export async function queryCodeRouted(
  cg: CodeGraph,
  request: CodeQueryRequest,
  deps: CodeQueryRouteDeps,
): Promise<CodeQueryResult> {
  const requested = request.backend ?? 'graph';
  const { offset, limit } = validateCodeQueryRequest(request);
  if (requested === 'graph') return deps.queryGraph(projectRequest(request, 'graph'));
  if (requested === 'lsp') return deps.queryLsp(projectRequest(request, 'lsp'));

  const language = languageForQuery(cg, request);
  const availability = deps.lspAvailability(language);
  const decision = decideRoute(request, language, availability);
  const families: LspFamily[] = decision.family && decision.resolved !== 'graph' ? [decision.family] : [];

  if (decision.resolved === 'graph') {
    const graph = deps.queryGraph(projectRequest(request, 'graph'));
    graph.routing = {
      ...graph.routing, requested, resolved: 'graph', reason: decision.reason,
      fallback: decision.unavailable ?? null, families, sources: { graph: graph.page.total, lsp: 0 },
    };
    return graph;
  }

  if (decision.resolved === 'lsp') {
    let lsp: CodeQueryResult;
    try {
      lsp = await deps.queryLsp(projectRequest(request, 'lsp'));
    } catch (error) {
      lsp = emptyCodeQueryResult(request.mode, request.query.trim(), 'lsp');
      lsp.projectRoot = cg.getProjectRoot();
      lsp.index = buildIndexBlock(cg, { checkFiles: false, includeStats: false });
      lsp.status = 'error';
      lsp.warnings.push(error instanceof Error ? error.message : String(error));
    }
    // Only the language server can answer diagnostics: there is no graph version to fall back to, so return unavailable honestly.
    if (request.mode === 'diagnostics') {
      lsp.routing = { ...lsp.routing, requested, resolved: 'lsp', reason: decision.reason, fallback: null, families, sources: { graph: 0, lsp: lsp.page.total } };
      return lsp;
    }
    if (lsp.status === 'unavailable' || lsp.status === 'error') {
      const failure = lsp.warnings[lsp.warnings.length - 1] ?? `the language server reported ${lsp.status}`;
      if (request.line !== undefined) {
        // A position query has no graph version: the index would have to answer by NAME, and
        // presenting a name match as "the definition at this position" is a fabrication. Fail
        // honestly instead of substituting a different question's answer.
        lsp.routing = {
          ...lsp.routing, requested, resolved: 'lsp', fallback: failure, families, sources: { graph: 0, lsp: 0 },
          reason: `${decision.reason} — but the language server did not answer (${lsp.status}); a position query has no graph fallback, so none was attempted`,
        };
        return lsp;
      }
      const graph = deps.queryGraph(projectRequest(request, 'graph'));
      const reason = `${decision.reason} — but the language server did not answer (${lsp.status}), so the graph index answered instead`;
      graph.routing = { ...graph.routing, requested, resolved: 'graph', reason, fallback: failure, families, sources: { graph: graph.page.total, lsp: 0 } };
      graph.warnings.unshift(`backend "${requested}" routed this query to the ${decision.family ?? 'language'} server first, but it was ${lsp.status}: ${failure}`);
      graph.status = graph.page.total > 0 ? 'ok' : 'not_found';
      return graph;
    }
    if (lsp.status === 'not_found') {
      if (request.line !== undefined) {
        // Same reasoning as above: "no definition at this position" stays that, rather than
        // becoming "something with this name exists somewhere".
        lsp.routing = {
          ...lsp.routing, requested, resolved: 'lsp', fallback: null, families, sources: { graph: 0, lsp: 0 },
          reason: 'the language server returned no items and a position query has no graph fallback',
        };
        return lsp;
      }
      const graph = deps.queryGraph(projectRequest(request, 'graph'));
      if (graph.page.total > 0) {
        const reason = 'the language server returned no items, so the graph index answered instead (its answer may be less precise)';
        graph.routing = { ...graph.routing, requested, resolved: 'graph', reason, fallback: null, families, sources: { graph: graph.page.total, lsp: 0 } };
        graph.lsp = lsp.lsp ?? graph.lsp;
        graph.warnings = mergeWarnings(
          [`The ${decision.family ?? 'language'} server returned no items for this query; the positions below come from the graph index.`.trim()],
          lsp.warnings,
          graph.warnings,
        );
        graph.status = 'ok';
        return graph;
      }
      lsp.routing = {
        ...lsp.routing, requested, resolved: 'lsp', reason: 'the language server returned no items and the graph index has none either',
        fallback: null, families, sources: { graph: 0, lsp: 0 },
      };
      return lsp;
    }
    lsp.routing = { ...lsp.routing, requested, resolved: 'lsp', reason: decision.reason, fallback: null, families, sources: { graph: 0, lsp: lsp.page.total } };
    return lsp;
  }

  // both: run both sources.
  if (request.mode === 'status') {
    // status has no items to merge: return the index status and the status table for every language family at once.
    const graph = deps.queryGraph(projectRequest(request, 'graph'));
    const lsp = await deps.queryLsp(projectRequest(request, 'lsp'));
    const result = emptyCodeQueryResult('status', request.query.trim(), 'both');
    result.projectRoot = graph.projectRoot ?? lsp.projectRoot;
    result.index = graph.index;
    result.lsp = lsp.lsp;
    result.page = { offset, limit, total: 0, nextOffset: null };
    result.routing = {
      requested, resolved: 'both', reason: decision.reason, fallback: null, families: [],
      sources: { graph: 0, lsp: 0 }, corroborated: 0,
      servedBy: lsp.routing.servedBy, daemonPid: lsp.routing.daemonPid,
    };
    result.warnings = mergeWarnings(graph.warnings, lsp.warnings);
    return result;
  }

  const [graph, lsp] = await Promise.all([
    collectSourceResult(deps.queryGraph, projectRequest(request, 'graph')),
    collectSourceResult(deps.queryLsp, projectRequest(request, 'lsp')),
  ]);
  return mergeResults(request, graph, lsp, { offset, limit, decision, families, requested });
}

/** The result envelope for `both`: based on the LSP side (keeping the lsp block and the UTF-16 coordinate system), with items replaced by the merged list. */
export function mergeResults(
  request: CodeQueryRequest,
  graph: CodeQueryResult,
  lsp: CodeQueryResult,
  options: { offset: number; limit: number; decision: RouteDecision; families: LspFamily[]; requested: 'auto' | 'both' },
): CodeQueryResult {
  const root = graph.projectRoot ?? lsp.projectRoot ?? '';
  const merged = mergeItems(root, graph.items, lsp.items);
  const result = emptyCodeQueryResult(request.mode, request.query.trim(), 'both');
  result.projectRoot = graph.projectRoot ?? lsp.projectRoot;
  result.coordinates = { lineBase: 1, columnBase: 0, columnEncoding: 'utf-16' };
  result.index = graph.index ?? lsp.index;
  result.lsp = lsp.lsp ?? graph.lsp;
  result.ambiguous = graph.ambiguous || lsp.ambiguous;
  result.items = merged.items.slice(options.offset, options.offset + options.limit);
  result.page = {
    offset: options.offset,
    limit: options.limit,
    total: merged.items.length,
    nextOffset: options.offset + result.items.length < merged.items.length ? options.offset + result.items.length : null,
  };
  const lspFailed = lsp.status === 'unavailable' || lsp.status === 'error';
  result.status = merged.items.length > 0 ? 'ok' : lsp.status === 'error' ? 'error' : lspFailed ? 'unavailable' : 'not_found';
  result.routing = {
    requested: options.requested,
    resolved: 'both',
    reason: options.decision.reason,
    fallback: lspFailed ? (lsp.warnings[lsp.warnings.length - 1] ?? `the language server reported ${lsp.status}`) : null,
    families: options.families,
    sources: { graph: graph.page.total, lsp: lsp.page.total },
    corroborated: merged.corroborated,
    servedBy: lsp.routing.servedBy,
    daemonPid: lsp.routing.daemonPid,
  };
  result.warnings = mergeWarnings(
    merged.corroborated > 0
      ? [`${merged.corroborated} item(s) are corroborated: the graph index and the language server independently report the same location.`]
      : [],
    lspFailed ? [`The language server did not contribute (${lsp.status}); only graph items are present.`] : [],
    graph.warnings,
    lsp.warnings,
  );
  if (graph.items.some((item) => (item as { startColumn?: number }).startColumn !== undefined)) {
    result.warnings.push('Merged mode reports columns in UTF-16 code units (like the language server): graph positions were converted from the index\'s UTF-8 byte columns by reading the current line. An item whose file could not be read keeps its byte column and says so with columnEncoding:"utf-8".');
  }
  return result;
}

/** A supplement to `assertBackendFields`: tests mode is answered only by the graph. */
export function assertRoutableMode(request: CodeQueryRequest, source: CodeQuerySource): void {
  assertBackendFields(request, source);
  if (request.mode === 'tests' && source === 'lsp') {
    throw new Error('tests mode is graph-only: a language server reports references, not test associations');
  }
}
