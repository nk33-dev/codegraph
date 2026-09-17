/**
 * `codegraph sync --upgrade-index`（个人版）。
 *
 * 契约：升级前必须能算清范围、文件数、预计耗时与预计峰值磁盘，并在非交互运行时要求
 * 显式 --yes；提取规则兼容时走按语言的增量迁移，否则按完整重建处理，且两种情况都不能
 * 在没有真正完成时把索引标成“当前版本”。
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

/** 模拟一个由旧引擎建立的索引（与 upgrade.test.ts 相同的做法）。 */
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
    expect(extractionUpgradeScope(EXTRACTION_VERSION - 1)).toMatchObject({
      scope: 'all', unrecordedHistory: true,
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
      unrecordedHistory: true,
      affectedFiles: 2,
      totalFiles: 2,
      // 没有基线时用每文件启发式，并如实标注依据。
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
    // 迁移完成前不能盖戳：这里先确认“还没盖”时的状态仍然是 stale。
    expect(cg.isIndexStale()).toBe(true);

    cg.stampExtractionVersion();

    expect(cg.isIndexStale()).toBe(false);
    expect(cg.queryCode({ mode: 'definitions', query: 'hello' }).status).toBe('ok');
  });
});
