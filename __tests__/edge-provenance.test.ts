import { describe, expect, it } from 'vitest';
import { classifyEdgeProvenance, extractEdgeSourceLocation } from '../src/graph/edge-provenance';

describe('edge provenance display tiers', () => {
  it('maps explicit and resolver-confirmed edges to resolved', () => {
    expect(classifyEdgeProvenance({ source: 'a', target: 'b', kind: 'calls', provenance: 'tree-sitter' }).label)
      .toBe('resolved');
    expect(classifyEdgeProvenance({
      source: 'a', target: 'b', kind: 'calls', metadata: { resolvedBy: 'instance-method' },
    }).label).toBe('resolved');
  });

  it('maps name matches and synthesized relations to inferred', () => {
    expect(classifyEdgeProvenance({
      source: 'a', target: 'b', kind: 'references', metadata: { resolvedBy: 'exact-match' },
    }).label).toBe('inferred');
    expect(classifyEdgeProvenance({
      source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic',
      metadata: { synthesizedBy: 'callback' },
    }).label).toBe('inferred');
  });

  it('keeps explicit runtime candidates distinct', () => {
    expect(classifyEdgeProvenance({
      source: 'a', target: 'b', kind: 'calls', metadata: { inferred: true },
    }).label).toBe('candidate');
    expect(classifyEdgeProvenance({ source: 'a', target: 'b', kind: 'calls' }).label)
      .toBe('candidate');
  });
});

describe('edge source locations', () => {
  it('prefers the actual edge site and uses a synthesized registration site when line is absent', () => {
    expect(extractEdgeSourceLocation(
      { source: 'a', target: 'b', kind: 'calls', line: 12 },
      'src/caller.ts',
      4,
    )).toEqual({ file: 'src/caller.ts', line: 12 });
    expect(extractEdgeSourceLocation({
      source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic',
      metadata: { registeredAt: 'src/registrar.ts:41' },
    }, 'src/dispatcher.ts', 8)).toEqual({ file: 'src/registrar.ts', line: 41 });
  });
});
