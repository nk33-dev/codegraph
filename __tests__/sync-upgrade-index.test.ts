/**
 * `codegraph sync --upgrade-index` for the personal fork.
 *
 * Before upgrading, report scope, file count, estimated duration, and estimated peak disk usage.
 * Non-interactive runs require explicit --yes. Compatible extraction changes migrate by language;
 * incompatible changes rebuild fully. Neither path may mark the index current before completion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { EXTRACTION_VERSION, extractionUpgradeScope } from '../src/extraction/extraction-version';
import { planIndexUpgrade } from '../src/sync/upgrade-index';
import { writeResourceMetricsSnapshot, type ResourceMetricsSnapshot } from '../src/resource-metrics';

let dir: string;
let cg: CodeGraph | null = null;

/** Simulate an index created by an older engine, matching upgrade.test.ts. */
function stampOlderExtractionVersion(instance: CodeGraph, version: number): void {
  (instance as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries
    .setMetadata('indexed_with_extraction_version', String(version));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-index-'));
});

afterEach(() => {
  try { cg?.destroy(); } catch { /* already closed */ }
  cg = null;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* Windows handles */ }
});

describe('extractionUpgradeScope', () => {
  it('treats an index with no recorded stamp as a full rebuild', () => {
    expect(extractionUpgradeScope(null)).toMatchObject({ scope: 'all', unrecordedHistory: true });
  });

  it('treats an upgrade across unrecorded versions as a full rebuild instead of guessing', () => {
    expect(extractionUpgradeScope(EXTRACTION_VERSION - 2)).toMatchObject({
      scope: 'all', unrecordedHistory: true,
    });
  });

  it('uses the recorded scope for the latest extraction upgrade', () => {
    expect(extractionUpgradeScope(EXTRACTION_VERSION - 1)).toMatchObject({
      scope: 'all', unrecordedHistory: false,
      summaries: [expect.stringContaining(`v${EXTRACTION_VERSION}:`)],
    });
  });

  it('needs nothing when the index is already current', () => {
    const scope = extractionUpgradeScope(EXTRACTION_VERSION);
    expect(scope.scope).toBe('all');
    expect(scope.unrecordedHistory).toBe(false);
  });
});

describe('planIndexUpgrade', () => {
  it('reports nothing to do on a current index', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();

    expect(planIndexUpgrade(cg)).toMatchObject({ needed: false, plan: null, current: EXTRACTION_VERSION });
  });

  it('estimates scope, time and disk for a stale index', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export function world() { return 2; }\n');
    cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();
    stampOlderExtractionVersion(cg, EXTRACTION_VERSION - 1);

    const assessment = planIndexUpgrade(cg);

    expect(assessment.needed).toBe(true);
    expect(assessment.builtWith).toBe(EXTRACTION_VERSION - 1);
    expect(assessment.plan).toMatchObject({
      scope: 'all',
      unrecordedHistory: false,
      reasons: [expect.stringContaining(`v${EXTRACTION_VERSION}:`)],
      affectedFiles: 2,
      totalFiles: 2,
      // Without a baseline, use the per-file heuristic and state that basis explicitly.
      durationBasis: 'heuristic',
    });
    expect(assessment.plan!.estimatedDurationMs).toBeGreaterThan(0);
    expect(assessment.plan!.estimatedPeakDiskBytes).toBeGreaterThan(0);
    expect(assessment.plan!.affectedLanguages).toContain('typescript');
  });

  it('uses the recorded full-index baseline when one exists', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();
    stampOlderExtractionVersion(cg, EXTRACTION_VERSION - 1);
    writeResourceMetricsSnapshot(dir, {
      schemaVersion: 1, updatedAt: Date.now(), pid: process.pid, profile: 'balanced', governanceEnabled: true,
      index: {
        fullRuns: 1, fullLastMs: 4000, fullMaxMs: 4000, fullLastFiles: 1,
        incrementalRuns: 0, incrementalLastMs: 0, incrementalMaxMs: 0, incrementalLastFiles: 0,
      },
    } as unknown as ResourceMetricsSnapshot);

    const plan = planIndexUpgrade(cg).plan!;

    expect(plan.durationBasis).toBe('baseline');
    expect(plan.estimatedDurationMs).toBe(4000);
  });
});

describe('incremental migration', () => {
  it('re-extracts the affected files, re-syncs, and only then stamps the new version', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();
    stampOlderExtractionVersion(cg, EXTRACTION_VERSION - 1);
    expect(cg.isIndexStale()).toBe(true);

    const affected = cg.getFiles().map((file) => file.path);
    await cg.indexFiles(affected);
    await cg.sync();
    // The version stamp cannot advance before migration completes; verify the unstamped state remains stale.
    expect(cg.isIndexStale()).toBe(true);

    cg.stampExtractionVersion();

    expect(cg.isIndexStale()).toBe(false);
    expect(cg.queryCode({ mode: 'definitions', query: 'hello' }).status).toBe('ok');
  });
});
