import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { findDynamicBoundaries } from './dynamic-boundary-report';
import { describeEdgeEvidence } from './edge-provenance';
import { indexedFileFreshness } from '../sync/file-freshness';
import { symbolSelector } from './symbol-lookup';

export interface RelationshipCoverage {
  completeness: 'partial';
  basis: 'graph' | 'lsp';
  resolvedStatic: number;
  inferred: number;
  runtimeCandidates: number;
  dynamicSites: Array<{ symbol: string; filePath: string; line: number; form: string; snippet: string; key?: string }>;
  scan: { maxSymbols: 8; maxSites: 4; freshness: 'current-only' };
  limitations: string[];
}

export function buildRelationshipCoverage(cg: CodeGraph, nodes: Node[], edges: Edge[]): RelationshipCoverage {
  const coverage: RelationshipCoverage = {
    completeness: 'partial', basis: 'graph', resolvedStatic: 0, inferred: 0, runtimeCandidates: 0,
    dynamicSites: [], scan: { maxSymbols: 8, maxSites: 4, freshness: 'current-only' },
    limitations: [
      'Static relationships are best-effort evidence. Reflection, dependency injection, string registrations and runtime routes may omit relationships; zero results do not prove absence.',
      'Dynamic-site detection is bounded and scans only current source bodies; no detected site does not prove complete coverage. Check source and runtime wiring before relying on absence or inferred targets.',
    ],
  };
  for (const edge of edges) {
    const evidence = describeEdgeEvidence(edge);
    if (evidence.classification === 'resolved-static') coverage.resolvedStatic++;
    else if (evidence.classification === 'runtime-candidate') coverage.runtimeCandidates++;
    else coverage.inferred++;
  }
  const fresh = new Map<string, boolean>();
  const current = nodes.filter((node) => {
    if (!fresh.has(node.filePath)) fresh.set(node.filePath, indexedFileFreshness(cg.getProjectRoot(), cg.getFile(node.filePath)) === 'current');
    return fresh.get(node.filePath);
  });
  coverage.dynamicSites = findDynamicBoundaries(cg, current).flatMap(({ node, sites }) => sites.map((site) => ({
    symbol: symbolSelector(node), filePath: node.filePath, line: site.line,
    form: site.form, snippet: site.snippet, ...(site.key ? { key: site.key } : {}),
  })));
  return coverage;
}
