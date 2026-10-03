/**
 * The risk-hotspot report as a caller sees it (`codegraph hotspots`, `codegraph_hotspots`).
 *
 * `hotspots.test.ts` pins the decision counting and the scoring arithmetic. This file is about the
 * assembly: which symbols become candidates, how `maxItems` and `threshold` interact, and — the
 * reason the gate is trustworthy — that `gated` is counted over EVERY scored symbol rather than over
 * the listed ones, so a symbol cut from the output still fails `--strict`.
 *
 * Complexity is re-derived from the files on disk, so the fixtures write real source: one branchy
 * callee called from several places, and one straight-line function nothing calls.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { clearProjectConfigCache, loadHotspotsConfig } from '../src/project-config';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspots-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

async function index(root: string): Promise<CodeGraph> {
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  await graph.indexAll();
  await graph.resolveReferences();
  return graph;
}

/** Four callers for `classify`, and a body with five decisions. */
const FIXTURE = {
  'src/classify.ts': `export function classify(n: number, flag: boolean): string {
  if (n > 0 && flag) return 'a';
  if (n < 0 || flag) return 'b';
  for (let i = 0; i < n; i++) {
    if (i > 2) return 'c';
  }
  return n === 0 ? 'd' : 'e';
}
`,
  'src/plain.ts': `export function plain(): number {
  return 1;
}
`,
  'src/a.ts': `import { classify } from './classify';\nexport function a(): string { return classify(1, true); }\n`,
  'src/b.ts': `import { classify } from './classify';\nexport function b(): string { return classify(2, false); }\n`,
  'src/c.ts': `import { classify } from './classify';\nexport function c(): string { return classify(3, true); }\n`,
  // Indexed, but no language in `hotspots.ts` has decision rules for it.
  'config/app.yaml': 'key: value\nlist:\n  - 1\n',
};

afterEach(() => {
  for (const graph of graphs.splice(0)) {
    try { graph.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  }
  clearProjectConfigCache();
});

describe('risk hotspot report over a real index', () => {
  it('ranks the branchy, widely called function above the straight-line one', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    const report = await cg.getRiskHotspots({ includeTests: false, threshold: 0 });
    const classify = report.hotspots.find((hotspot) => hotspot.name === 'classify');
    const plain = report.hotspots.find((hotspot) => hotspot.name === 'plain');
    expect(classify).toBeDefined();
    expect(plain).toBeDefined();

    // if+&& (2), if+|| (2), for (1), if (1), ternary (1) => complexity 1 + 7.
    expect(classify!.complexity).toBe(8);
    expect(classify!.callerCount).toBe(3);
    expect(plain!.complexity).toBe(1);
    expect(plain!.callerCount).toBe(0);
    expect(report.hotspots[0]!.name).toBe('classify');
    expect(report.scoredSymbols).toBeGreaterThanOrEqual(5);
  });

  it('reports files it could not score instead of counting them as complexity 1', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    // YAML has no decision rules; asking for it explicitly is a skip the caller can act on.
    const report = await cg.getRiskHotspots({ files: ['config/app.yaml'], includeTests: false });
    expect(report.hotspots).toHaveLength(0);
    expect(report.scannedFiles).toBe(0);
    expect(report.skipped).toBe(1);

    // A whole-index scan does not count every unsupported file as "skipped" — that number would be noise.
    const whole = await cg.getRiskHotspots({ includeTests: false });
    expect(whole.skipped).toBe(0);
  });

  it('counts the gate over every scored symbol, not over the listed ones', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    const report = await cg.getRiskHotspots({ includeTests: false, threshold: 0, maxItems: 1 });
    expect(report.hotspots).toHaveLength(1);
    // Every scored symbol is at or above 0, so the gate sees the whole population.
    expect(report.gated).toBe(report.scoredSymbols);
  });

  it('gates nothing when no threshold is asked for', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    const report = await cg.getRiskHotspots({ includeTests: false, threshold: null });
    expect(report.threshold).toBeNull();
    expect(report.gated).toBe(0);
  });

  it('boosts a symbol the caller reports as changed', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    const base = await cg.getRiskHotspots({ includeTests: false, files: ['src/plain.ts'] });
    const boosted = await cg.getRiskHotspots({
      includeTests: false,
      files: ['src/plain.ts'],
      changed: [{
        change: 'modified',
        name: 'plain',
        qualifiedName: 'plain',
        kind: 'function',
        filePath: 'src/plain.ts',
        line: 1,
        previousFilePath: null,
        previousLine: null,
      }],
    });

    expect(boosted.hotspots[0]!.changed).toBe(true);
    expect(boosted.hotspots[0]!.score).toBeGreaterThan(base.hotspots[0]!.score);
    expect(base.hotspots[0]!.changed).toBe(false);
  });

  it('caps the scan at maxFiles and says so', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const cg = await index(root);

    const report = await cg.getRiskHotspots({ includeTests: false, maxFiles: 1 });
    expect(report.truncatedFiles).toBe(true);
    expect(report.scannedFiles).toBe(1);
  });
});

describe('hotspots config loading', () => {
  it('a project with no hotspots block gets every field unset, so the built-in defaults apply', () => {
    const root = makeRoot();
    write(root, { 'src/a.ts': 'export const a = 1;\n' });
    expect(loadHotspotsConfig(root)).toEqual({
      threshold: null,
      changedBoost: null,
      testPenalty: null,
      maxItems: null,
      maxFiles: null,
    });
  });

  it('merges field by field across the shared and local layers', () => {
    const root = makeRoot();
    write(root, {
      'codegraph.json': JSON.stringify({ hotspots: { threshold: 80, maxItems: 5 } }),
      '.codegraph/codegraph.json': JSON.stringify({ hotspots: { threshold: 120 } }),
    });
    const config = loadHotspotsConfig(root);
    expect(config.threshold).toBe(120);
    // The local file says nothing about maxItems, so the shared value survives.
    expect(config.maxItems).toBe(5);
  });

  it('drops a malformed field without discarding the rest of the block', () => {
    const root = makeRoot();
    write(root, {
      'codegraph.json': JSON.stringify({
        hotspots: { threshold: 'high', changedBoost: 2, maxItems: 0, maxFiles: 3.5 },
      }),
    });
    const config = loadHotspotsConfig(root);
    expect(config.threshold).toBeNull();
    expect(config.maxItems).toBeNull();
    expect(config.maxFiles).toBeNull();
    expect(config.changedBoost).toBe(2);
  });
});
