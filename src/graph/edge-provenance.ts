import type { Edge } from '../types.js';

/**
 * Provenance tier for a relation edge: from explicit source syntax to runtime candidates.
 * Higher tiers (earlier in the list) have stronger evidence.
 */
export type ProvenanceTier =
  | 'explicit'       // Extraction-time syntax edges (contains/imports/extends), no resolvedBy
  | 'resolved'       // Resolver明确解析 (import/qualified-name/instance-method/function-ref/framework)
  | 'name-inferred'  // 名称匹配 (exact-match/fuzzy/file-path), 可能误判
  | 'structural'     // 结构推断 (provenance:heuristic + synthesizedBy)
  | 'candidate'      // 运行时候选 (inferred/confidence:candidate)
  | 'lsp';           // LSP查询时验证 (不持久化)

export interface RelationEvidence {
  tier: ProvenanceTier;
  classification: 'resolved-static' | 'inferred' | 'runtime-candidate';
  source: string;
  confidence: 'direct' | 'inferred' | 'unknown';
  resolverConfidence: number | null;
}

export function describeEdgeEvidence(edge: Edge): RelationEvidence {
  const classified = classifyEdgeProvenance(edge);
  const direct = ['explicit', 'resolved', 'lsp'].includes(classified.tier);
  const unknown = classified.detail === 'unknown provenance';
  return {
    tier: classified.tier,
    classification: direct ? 'resolved-static' : classified.tier === 'candidate' ? 'runtime-candidate' : 'inferred',
    source: classified.detail ?? edge.provenance ?? 'unknown',
    confidence: unknown ? 'unknown' : direct ? 'direct' : 'inferred',
    resolverConfidence: typeof edge.metadata?.confidence === 'number' ? edge.metadata.confidence : null,
  };
}

/**
 * Classify an edge's provenance tier based on its stored metadata.
 *
 * @param edge The edge to classify
 * @param lspVerified Whether this edge was verified by LSP at query time (only for references mode)
 * @returns Tier and display label
 */
export function classifyEdgeProvenance(
  edge: Edge,
  lspVerified?: boolean,
): { tier: ProvenanceTier; label: string; detail?: string } {
  if (lspVerified) {
    return { tier: 'lsp', label: 'resolved', detail: 'lsp' };
  }

  const meta = (edge.metadata ?? {}) as Record<string, unknown>;
  const synthesizedBy = typeof meta.synthesizedBy === 'string' ? meta.synthesizedBy : null;
  const resolvedBy = typeof meta.resolvedBy === 'string' ? meta.resolvedBy : null;
  const inferred = meta.inferred === true;
  const confidence = meta.confidence;

  // Runtime candidate: explicitly marked as inferred, low confidence, or fuzzy
  if (
    inferred ||
    confidence === 'candidate' ||
    confidence === 'low' ||
    (typeof confidence === 'number' && confidence < 0.6) ||
    resolvedBy === 'fuzzy'
  ) {
    return { tier: 'candidate', label: 'candidate', detail: synthesizedBy ?? resolvedBy ?? undefined };
  }

  // Structural heuristic: synthesized edges or explicit heuristic provenance
  if (synthesizedBy || edge.provenance === 'heuristic') {
    return { tier: 'structural', label: 'inferred', detail: synthesizedBy ?? undefined };
  }

  // Resolved: strong resolution methods
  if (resolvedBy) {
    const strongResolvers = [
      'import',
      'qualified-name',
      'instance-method',
      'function-ref',
      'framework',
    ];
    if (strongResolvers.includes(resolvedBy)) {
      return { tier: 'resolved', label: 'resolved', detail: resolvedBy };
    }
    // Weak resolvers: exact-match, file-path
    return { tier: 'name-inferred', label: 'inferred', detail: resolvedBy };
  }

  // SCIP provenance is resolved
  if (edge.provenance === 'scip') {
    return { tier: 'resolved', label: 'resolved', detail: 'scip' };
  }

  // A parser-origin edge or a stored syntax site proves an explicit relation.
  if (
    edge.provenance === 'tree-sitter' ||
    (edge.provenance === undefined && typeof edge.line === 'number' && edge.line > 0)
  ) {
    return { tier: 'explicit', label: 'resolved', detail: 'syntax' };
  }

  if (edge.provenance === undefined) {
    return { tier: 'candidate', label: 'candidate', detail: 'unknown provenance' };
  }

  // Default: treat as structural inference
  return { tier: 'structural', label: 'inferred' };
}

/**
 * Extract the source location of an edge's call site.
 * Priority: edge.line > registeredAt > source node's declaration line
 */
export function extractEdgeSourceLocation(
  edge: Edge,
  sourceFilePath: string,
  sourceStartLine: number,
): { file: string; line: number } {
  const meta = (edge.metadata ?? {}) as Record<string, unknown>;

  // Priority 1: edge.line (the call site)
  if (edge.line && edge.line > 0) {
    return { file: sourceFilePath, line: edge.line };
  }

  // Priority 2: registeredAt (often used by synthesized edges)
  if (typeof meta.registeredAt === 'string') {
    const match = /^(.+):(\d+)$/.exec(meta.registeredAt);
    if (match && match[1] && match[2]) {
      return { file: match[1], line: Number(match[2]) };
    }
  }

  // Priority 3: source node's declaration line
  return { file: sourceFilePath, line: sourceStartLine };
}
