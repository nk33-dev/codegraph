/**
 * 资源指标与基线记录（阶段一）。
 *
 * 覆盖：分位数与有界样本、查询/索引/LSP 计数、快照形状、以及 `.codegraph/`
 * 下的原子写入与降级读取。这些数字是后续阶段「相对阶段一基线增长」的比较基准，
 * 所以断言要锁住语义而不是具体耗时。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DurationSeries,
  RESOURCE_METRICS_FILENAME,
  ResourceMetrics,
  SERIES_CAPACITY,
  getResourceMetricsPath,
  readResourceMetricsSnapshot,
  resetResourceMetrics,
  resourceMetrics,
  writeResourceMetricsSnapshot,
} from '../src/resource-metrics';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-metrics-'));
  resetResourceMetrics();
});

afterEach(() => {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DurationSeries', () => {
  it('空序列返回零，不抛错', () => {
    const stats = new DurationSeries().stats();
    expect(stats).toEqual({ count: 0, totalMs: 0, lastMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 });
  });

  it('给出 total/max/last 与 p50/p95', () => {
    const series = new DurationSeries();
    for (let i = 1; i <= 100; i++) series.record(i);
    const stats = series.stats();
    expect(stats.count).toBe(100);
    expect(stats.totalMs).toBe(5050);
    expect(stats.lastMs).toBe(100);
    expect(stats.maxMs).toBe(100);
    expect(stats.p50Ms).toBe(50);
    expect(stats.p95Ms).toBe(95);
  });

  it('样本有界：记录远超容量的样本不会无限增长，计数仍然准确', () => {
    const series = new DurationSeries();
    for (let i = 0; i < SERIES_CAPACITY * 5; i++) series.record(i % 10);
    const stats = series.stats();
    expect(stats.count).toBe(SERIES_CAPACITY * 5);
    // 保留窗口里的样本都是 0..9，分位数不会出现窗口外的值。
    expect(stats.p95Ms).toBeLessThanOrEqual(10);
  });

  it('忽略非有限值和负数', () => {
    const series = new DurationSeries();
    series.record(Number.NaN);
    series.record(-1);
    series.record(Number.POSITIVE_INFINITY);
    expect(series.stats().count).toBe(0);
  });
});

describe('ResourceMetrics 计数', () => {
  it('查询计数区分 ok/busy/error，并分别记录等待与执行耗时', () => {
    const m = new ResourceMetrics();
    m.recordQueryStart();
    m.recordQueryEnd(10, 90, 'ok');
    m.recordQueryStart();
    m.recordQueryEnd(5, 5, 'busy');
    m.recordQueryStart();
    m.recordQueryEnd(1, 1, 'error');
    const q = m.snapshot().query;
    expect(q.started).toBe(3);
    expect(q.completed).toBe(3);
    expect(q.busy).toBe(1);
    expect(q.failed).toBe(1);
    expect(q.wait.count).toBe(3);
    expect(q.run.maxMs).toBe(90);
  });

  it('池状态与缓存命中写入快照', () => {
    const m = new ResourceMetrics();
    m.setPoolGauges({ liveWorkers: 3, idleWorkers: 2, queueDepth: 1, poolMax: 4 });
    m.recordCache(true);
    m.recordCache(true);
    m.recordCache(false);
    const snap = m.snapshot();
    expect(snap.query).toMatchObject({ liveWorkers: 3, idleWorkers: 2, queueDepth: 1, poolMax: 4 });
    expect(snap.query.cacheHits).toBe(2);
    expect(snap.query.cacheMisses).toBe(1);
  });

  it('索引基线区分全量与增量，并保留最大值', () => {
    const m = new ResourceMetrics();
    m.recordIndexRun('full', 1000, 500);
    m.recordIndexRun('full', 400, 500);
    m.recordIndexRun('incremental', 30, 2);
    const idx = m.snapshot().index;
    expect(idx.fullRuns).toBe(2);
    expect(idx.fullLastMs).toBe(400);
    expect(idx.fullMaxMs).toBe(1000);
    expect(idx.fullLastFiles).toBe(500);
    expect(idx.incrementalRuns).toBe(1);
    expect(idx.incrementalLastMs).toBe(30);
    expect(idx.incrementalLastFiles).toBe(2);
  });

  it('LSP 生命周期按原因计数，start 耗时进分位数', () => {
    const m = new ResourceMetrics();
    m.recordLspStart(120);
    m.recordLspStart(80);
    m.recordLspStop('idle');
    m.recordLspStop('budget');
    m.recordLspStop('shutdown');
    m.setLspGauges(2, 3);
    const lsp = m.snapshot().lsp;
    expect(lsp.starts).toBe(2);
    expect(lsp.stops).toBe(3);
    expect(lsp.idleStops).toBe(1);
    expect(lsp.budgetStops).toBe(1);
    expect(lsp.startDuration.count).toBe(2);
    expect(lsp.liveServers).toBe(2);
    expect(lsp.globalLeases).toBe(3);
  });

  it('setProfile 把档位写进快照', () => {
    const m = new ResourceMetrics();
    m.setProfile('battery', false);
    expect(m.snapshot()).toMatchObject({ profile: 'battery', governanceEnabled: false, schemaVersion: 1 });
  });
});

describe('resourceMetrics 单例', () => {
  it('同一进程返回同一实例，reset 后重新开始', () => {
    const a = resourceMetrics();
    a.recordQueryStart();
    expect(resourceMetrics()).toBe(a);
    expect(resourceMetrics().snapshot().query.started).toBe(1);
    resetResourceMetrics();
    expect(resourceMetrics()).not.toBe(a);
    expect(resourceMetrics().snapshot().query.started).toBe(0);
  });
});

/**
 * catch-up 门等待（P2 问题 10）。
 *
 * 只断言语义：门等待单独计数、单独计量，并且**不混进** `query.run`
 * （检索耗时）。两个数字混在一起就没法判断首调用时延该优化哪一段。
 */
describe('catch-up 门等待指标', () => {
  it('按时长与结果分开记录，不混入 query.run', () => {
    const m = new ResourceMetrics();
    m.recordQueryEnd(0, 40, 'ok');
    m.recordCatchUpWait(120, 'ready');
    m.recordCatchUpWait(3000, 'timeout');

    const snap = m.snapshot();
    expect(snap.catchUp.count).toBe(2);
    expect(snap.catchUp.ready).toBe(1);
    expect(snap.catchUp.timeout).toBe(1);
    expect(snap.catchUp.failed).toBe(0);
    expect(snap.catchUp.wait).toEqual({
      count: 2, totalMs: 3120, lastMs: 3000, maxMs: 3000, p50Ms: 120, p95Ms: 3000,
    });
    // 检索序列只看到那次查询的 40ms，没有被门等待污染。
    expect(snap.query.run.lastMs).toBe(40);
  });

  it('空指标是零值，reset 之后回到零值', () => {
    const m = new ResourceMetrics();
    expect(m.snapshot().catchUp).toEqual({
      count: 0, ready: 0, timeout: 0, failed: 0,
      wait: { count: 0, totalMs: 0, lastMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 },
    });
    m.recordCatchUpWait(50, 'timeout');
    m.reset();
    expect(m.snapshot().catchUp.count).toBe(0);
    expect(m.snapshot().catchUp.wait.lastMs).toBe(0);
  });

  it('旧版 daemon 写的快照（没有 catchUp 字段）仍可读回', () => {
    // status 只有在字段存在时才显示这一行，所以旧文件不能读成 null。
    const file = getResourceMetricsPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, updatedAt: Date.now(), pid: 1,
      query: { run: { p95Ms: 5 } }, index: {}, lsp: {},
    }));
    const read = readResourceMetricsSnapshot(dir);
    expect(read?.schemaVersion).toBe(1);
    expect(read?.catchUp).toBeUndefined();
  });
});

describe('快照落盘与降级读取', () => {
  it('写入后可原样读回，且不留下临时文件', () => {
    const m = new ResourceMetrics();
    m.recordIndexRun('incremental', 42, 3);
    const snap = m.snapshot();
    expect(writeResourceMetricsSnapshot(dir, snap)).toBe(true);
    const file = getResourceMetricsPath(dir);
    expect(path.basename(file)).toBe(RESOURCE_METRICS_FILENAME);
    const read = readResourceMetricsSnapshot(dir);
    expect(read?.index.incrementalLastMs).toBe(42);
    expect(read?.pid).toBe(process.pid);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('未初始化项目（目录不存在）写入时自动创建 .codegraph', () => {
    const nested = path.join(dir, 'proj');
    fs.mkdirSync(nested, { recursive: true });
    expect(writeResourceMetricsSnapshot(nested, new ResourceMetrics().snapshot())).toBe(true);
    expect(fs.existsSync(getResourceMetricsPath(nested))).toBe(true);
  });

  it('文件缺失 / JSON 损坏 / 版本不符都返回 null，不抛错', () => {
    expect(readResourceMetricsSnapshot(dir)).toBeNull();
    const file = getResourceMetricsPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    expect(readResourceMetricsSnapshot(dir)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, updatedAt: 1 }));
    expect(readResourceMetricsSnapshot(dir)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    expect(readResourceMetricsSnapshot(dir)).toBeNull();
  });

  it('重复写入覆盖旧快照（最后一次运行即当前状态）', () => {
    const first = new ResourceMetrics();
    first.recordIndexRun('full', 10, 1);
    writeResourceMetricsSnapshot(dir, first.snapshot());
    const second = new ResourceMetrics();
    second.recordIndexRun('full', 20, 2);
    writeResourceMetricsSnapshot(dir, second.snapshot());
    expect(readResourceMetricsSnapshot(dir)?.index.fullLastMs).toBe(20);
  });
});
