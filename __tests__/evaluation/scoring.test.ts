import { describe, expect, it } from 'vitest';
import { PASS_THRESHOLD, scoreFindRelevantContext, scoreSearchNodes } from './scoring';

describe('评测评分契约', () => {
  it('搜索评分大小写不敏感，并按首个命中的真实排名计算 MRR', () => {
    const result = scoreSearchNodes('search', ['Target', 'Missing'], [
      { node: { name: 'decoy' }, score: 1 },
      { node: { name: 'target' }, score: 0.8 },
    ], 12);
    expect(result).toMatchObject({
      pass: true, recall: 0.5, mrr: 0.5,
      foundSymbols: ['Target'], missedSymbols: ['Missing'], latencyMs: 12,
    });
  });

  it('低于阈值的搜索明确失败', () => {
    const result = scoreSearchNodes('search', ['A', 'B', 'C'], [
      { node: { name: 'A' }, score: 1 },
    ], 1);
    expect(result.recall).toBeCloseTo(1 / 3);
    expect(result.recall).toBeLessThan(PASS_THRESHOLD);
    expect(result.pass).toBe(false);
  });

  it('上下文评分记录召回率、节点数、边数和密度', () => {
    const result = scoreFindRelevantContext('context', ['A', 'B'], {
      nodes: new Map([['1', { name: 'a' }], ['2', { name: 'Other' }]]),
      edges: [{}, {}, {}],
      roots: ['1'],
    }, 7);
    expect(result).toMatchObject({
      pass: true, recall: 0.5, nodeCount: 2, edgeCount: 3, edgeDensity: 1.5,
      foundSymbols: ['A'], missedSymbols: ['B'], latencyMs: 7,
    });
  });

  it('空上下文保持有限的零值，不产生 NaN', () => {
    const result = scoreFindRelevantContext('empty', ['A'], {
      nodes: new Map(), edges: [], roots: [],
    }, 0);
    expect(result).toMatchObject({ pass: false, recall: 0, edgeDensity: 0, nodeCount: 0, edgeCount: 0 });
  });
});
