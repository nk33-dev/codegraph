/**
 * Symbol Lookup — the single "what did the user mean by this name?" path.
 *
 * Every verb that takes a symbol NAME from a human (or an agent) has to turn
 * that string into node(s). `codegraph_node` and `codegraph_explore` went
 * through the matcher below; the `callers` / `callees` / `impact` CLI verbs
 * carried their own ad-hoc filter instead:
 *
 *     node.name === symbol || node.name.endsWith('.' + symbol)
 *
 * which compares the query against the BARE name only. That produced two
 * opposite failures in the same repository:
 *
 *   - a bare name over-reported: `callers group` silently merged the callers of
 *     every distinct symbol named `group` — in any language — into one list
 *     headed "Callers of group", with nothing saying they were different
 *     symbols;
 *   - a qualified name under-reported: `Foo.Bar.baz` can never equal a bare
 *     `baz`, so every candidate failed the filter and the code fell through to
 *     an arbitrary top-of-FTS hit — or reported "not found" for a symbol that
 *     plainly exists.
 *
 * Both are fixed by routing all of them through one resolver, which this module
 * owns so the CLI and the MCP tools cannot drift apart again.
 */

import type { Edge, Node } from '../types';
import { splitIdentifierSegments } from '../search/identifier-segments';
import { isTestFile } from '../search/query-utils';

export function splitSymbolSelector(query: string): { symbol: string; file?: string } {
  const separator = query.indexOf('#');
  if (separator < 0) return { symbol: query };
  return { file: query.slice(0, separator).replace(/\\/g, '/').replace(/^\.\//, ''), symbol: query.slice(separator + 1) };
}

export function symbolSelector(node: Node): string {
  return `${node.filePath}#${node.qualifiedName || node.name}`;
}

/** Rust path prefixes that name no directory (`crate::x`, `super::y`). */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/** Does this query carry any scope qualifier at all? */
export function isQualifiedSymbol(symbol: string): boolean {
  return /[.\/]|::/.test(symbol);
}

/** The bare identifier at the end of a qualified query (arity spelling stripped). */
export function lastQualifierPart(symbol: string): string {
  const noArity = symbol.replace(/\/\d{1,3}$/, '') || symbol;
  const parts = noArity.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Rewrite every scope separator to `.` so a query and a stored qualifiedName
 * written in different conventions can be compared directly. The extractors
 * join hierarchy with `::` while users type the language's own spelling
 * (`Session.request`, `stage_apply::run`, `pkg/mod.Fn`).
 */
function canonicalScope(text: string): string {
  return text.replace(/::/g, '.').replace(/\//g, '.');
}

/**
 * Does `node` satisfy the user's symbol query?
 *
 * Bare queries match the name. Qualified queries are checked against the
 * qualifiedName under both separator conventions, then — for languages whose
 * hierarchy lives in the file path rather than the name (Rust modules, Python
 * packages) — against the path.
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  const selector = splitSymbolSelector(symbol);
  if (selector.file !== undefined) {
    return selector.file === node.filePath && Boolean(selector.symbol) && matchesSymbol(node, selector.symbol);
  }
  // Erlang arity spelling (`fn/3`, `mod:fn/3`): when the node's qualifiedName
  // carries an arity (#1610) the written arity must match exactly, and the rest
  // of the comparison runs on the arity-less spelling. A node with no arity
  // keeps the original symbol (a `/` there means a path-ish name instead).
  const aritySpelling = /^(.+)\/(\d{1,3})$/.exec(symbol);
  if (aritySpelling) {
    const nodeArity = /\/(\d{1,3})$/.exec(node.qualifiedName ?? '')?.[1];
    if (nodeArity !== undefined) {
      if (nodeArity !== aritySpelling[2]) return false;
      symbol = aritySpelling[1]!;
    }
  }

  if (node.name === symbol) return true;
  // File basename match ("product-card" matches "product-card.liquid").
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  if (!isQualifiedSymbol(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Match a whole scope suffix under the extractor's `::` convention.
  if (node.qualifiedName === parts.join('::') || node.qualifiedName.endsWith(`::${parts.join('::')}`)) return true;

  // Stage 1b: boundary-aligned suffix under a canonical separator.
  //
  // Splitting on EVERY separator assumes no scope component contains one —
  // false for any language whose module names are themselves dotted (Elixir
  // `AppWeb.Format`, a Java/C# package, a Python dotted module). There the
  // stored qualifiedName is `AppWeb.Format::group`, so the stage-1 spelling
  // `AppWeb::Format::group` cannot match and a perfectly precise query
  // resolved to nothing. Canonicalising both sides and requiring the match to
  // land on a separator boundary handles both conventions with one rule, and
  // works without splitting the stored module name.
  const canonicalQuery = canonicalScope(symbol);
  const canonicalNode = canonicalScope(node.qualifiedName);
  if (canonicalNode === canonicalQuery || canonicalNode.endsWith(`.${canonicalQuery}`)) {
    return true;
  }

  // Stage 2: file-path containment. Rust modules and Python packages are not in
  // qualifiedName — they are encoded in the path — so `stage_apply::run`
  // matches a `run` in any file with a `stage_apply` path segment.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;
  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  const fileScope = segments.map((seg) => seg.replace(/\.[^.]+$/, '')).join('.');
  const directoryScope = segments.slice(0, -1).join('.');
  const wantedScope = containerHints.join('.');
  return [fileScope, directoryScope].some((scope) => scope === wantedScope || scope.endsWith(`.${wantedScope}`));
}

/** The slice of CodeGraph a symbol lookup needs — keeps this module testable. */
export interface SymbolLookupHost {
  getFieldContractNodes?(name: string): Node[];
  foldGeneratedDefinitions?(nodes: readonly Node[]): Node[];
  getNodesByName(name: string): Node[];
  searchNodes(query: string, options?: { limit?: number }): Array<{ node: Node }>;
  generatedFilePredicate(paths: string[]): (path: string) => boolean;
  getNodesInFile?(file: string): Node[];
  getOutgoingEdgesFrom?(ids: readonly string[], kinds?: Edge['kind'][]): Edge[];
  getNodesByIds?(ids: readonly string[]): Map<string, Node>;
}

export interface SymbolLookupOptions {
  file?: string;
  contextFiles?: string[];
  scope?: string;
  languages?: string[];
}

export function sourcePathPriority(filePath: string): number {
  if (/(?:^|[\\/])(?:fixtures?|testdata|__fixtures__)(?:[\\/]|$)/i.test(filePath)) return 2;
  return isTestFile(filePath) ? 1 : 0;
}

export function rankSymbolNodes(cg: SymbolLookupHost, nodes: Node[], options: SymbolLookupOptions = {}): Node[] {
  const contextFiles = new Set(options.contextFiles ?? []);
  const contextNodes = [...contextFiles].flatMap((file) => cg.getNodesInFile?.(file) ?? []);
  const languages = new Set(options.languages ?? contextNodes.map((node) => node.language));
  const imports = cg.getOutgoingEdgesFrom?.(contextNodes.map((node) => node.id), ['imports']) ?? [];
  const importedFiles = new Set([...(cg.getNodesByIds?.(imports.map((edge) => edge.target)).values() ?? [])].map((node) => node.filePath));
  const isGenerated = cg.generatedFilePredicate(nodes.map((node) => node.filePath));
  const scope = options.scope?.replace(/::/g, '.');
  const scoped = (node: Node) => {
    if (!scope) return 0;
    const qualified = node.qualifiedName.replace(/::/g, '.');
    const owner = qualified.slice(0, qualified.lastIndexOf('.'));
    return owner === scope ? 0 : owner.endsWith(`.${scope}`) ? 1 : 2;
  };
  return [...nodes].sort((a, b) => scoped(a) - scoped(b)
    || Number(!contextFiles.has(a.filePath)) - Number(!contextFiles.has(b.filePath))
    || Number(!importedFiles.has(a.filePath)) - Number(!importedFiles.has(b.filePath))
    || Number(!languages.has(a.language)) - Number(!languages.has(b.language))
    || Number(isGenerated(a.filePath)) - Number(isGenerated(b.filePath))
    || sourcePathPriority(a.filePath) - sourcePathPriority(b.filePath)
    || a.filePath.localeCompare(b.filePath) || a.qualifiedName.localeCompare(b.qualifiedName)
    || a.startLine - b.startLine || a.startColumn - b.startColumn || a.id.localeCompare(b.id));
}

export interface SymbolLookupResult {
  /** Nearby names are suggestions only, never resolved definitions. */
  suggestions?: Node[];
  /** Every definition the query names, keepers before generated stubs. */
  nodes: Node[];
  /**
   * The query named more than one distinct definition. Callers that aggregate
   * across all of them MUST surface this — an aggregate presented as one
   * symbol's answer is the over-reporting failure described at the top.
   */
  ambiguous: boolean;
}

/**
 * One group per (filePath, qualifiedName): same-file overloads stay together,
 * while unrelated definitions keep their own edges. Shared by CLI and MCP.
 * A non-matching file hint keeps all definitions and must be disclosed.
 */
export function groupDefinitions(
  nodes: Node[],
  fileFilter?: string
): { groups: Node[][]; filteredOut: boolean } {
  let pool = nodes;
  let filteredOut = false;
  if (fileFilter) {
    const wanted = fileFilter.replace(/^\.\//, '');
    const narrowed = pool.filter(
      (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
    );
    if (narrowed.length > 0) pool = narrowed;
    else filteredOut = true;
  }
  const byDef = new Map<string, Node[]>();
  for (const n of pool) {
    const key = `${n.filePath}|${n.qualifiedName}`;
    const group = byDef.get(key);
    if (group) group.push(n);
    else byDef.set(key, [n]);
  }
  return { groups: [...byDef.values()], filteredOut };
}

/**
 * Resolve a user-supplied symbol name to the definitions it names.
 *
 * The exact-name index is consulted FIRST and is authoritative: it is complete
 * and uncapped, whereas FTS ranks and truncates, and tokenises away `::` — so
 * a qualified query could miss a symbol that exists, or land on whatever
 * happened to rank first. FTS candidates still have to satisfy the matcher;
 * partial or mistyped names must never select the top fuzzy hit (#1473).
 */
export function lookupSymbolNodes(cg: SymbolLookupHost, symbol: string, options: SymbolLookupOptions = {}): SymbolLookupResult {
  const selector = splitSymbolSelector(symbol);
  if (selector.file !== undefined && options.file !== undefined && selector.file !== options.file) {
    return { nodes: [], ambiguous: false };
  }
  const file = options.file ?? selector.file;
  symbol = selector.symbol;
  if (!symbol || file === '') return { nodes: [], ambiguous: false };
  const qualified = isQualifiedSymbol(symbol);

  // Exact-name index, then filter by the qualifier the user actually wrote.
  const tail = qualified ? lastQualifierPart(symbol) : symbol;
  let nodes = tail ? cg.getNodesByName(tail) : [];
  if (qualified) {
    const aliases = cg.getFieldContractNodes?.(tail) ?? [];
    nodes = nodes.filter((node) => matchesSymbol(node, symbol) || aliases.some(alias => alias.id === node.id
      && matchesSymbol({ ...node, name: tail, qualifiedName: node.qualifiedName.replace(/[^:./]+$/, tail) }, symbol)));
  }

  let suggestions: Node[] = [];
  if (nodes.length === 0) {
    const hits = cg.searchNodes(symbol, { limit: 50 }).map((h) => h.node);
    suggestions = hits;
    if (suggestions.length === 0 && !qualified) {
      const words = splitIdentifierSegments(symbol);
      if (words.length > 1) suggestions = cg.searchNodes(words.join(' '), { limit: 20 }).map((hit) => hit.node);
    }
    const exact = hits.filter((n) => matchesSymbol(n, symbol));
    if (exact.length > 0) {
      nodes = exact;
    }
    // Any query with no exact match resolves to NOTHING rather than a
    // misleading fuzzy hit (#1473; qualified lookups already did this in #173).
  }

  if (file !== undefined) {
    nodes = nodes.filter((node) => node.filePath === file);
    suggestions = suggestions.filter((node) => node.filePath === file);
  }
  if (options.languages?.length) nodes = nodes.filter((node) => options.languages!.includes(node.language));
  if (nodes.length === 0) return { nodes: [], ambiguous: false, ...(suggestions.length ? { suggestions } : {}) };

  // Rank scope and context first, then keepers before generated stubs.
  const canonicalQuery = canonicalScope(symbol);
  const scope = qualified ? canonicalQuery.slice(0, canonicalQuery.lastIndexOf('.')) : undefined;
  const visible = file === undefined ? cg.foldGeneratedDefinitions?.(nodes) ?? nodes : nodes;
  const ranked = rankSymbolNodes(cg, visible, { ...options, scope: options.scope ?? scope });
  return { nodes: ranked, ambiguous: groupDefinitions(ranked).groups.length > 1 };
}

/** One-line "kind at path:line" label used when disclosing an ambiguous query. */
export function describeSymbolNode(node: Node): string {
  return `${node.kind} ${node.qualifiedName || node.name} (${node.language}) — ${node.filePath}:${node.startLine} [${symbolSelector(node)}]`;
}
