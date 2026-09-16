/**
 * 运行期资源指标与基线记录（开发计划 §5 阶段一）。
 *
 * 记录内容：查询队列长度、live/idle worker、单次查询耗时、缓存命中、LSP 生命周期、
 * 全量与增量索引耗时。目的不是做遥测，而是让「阶段一之后每个功能的 CPU/内存/磁盘
 * 增长」有可比对的基线，并能通过 `codegraph status` 看到实际资源状态。
 *
 * 设计约束：
 *   - 全部为进程内计数，写入是廉价的同步操作，不引入 I/O 或异步；
 *   - 分位数用有界环形缓冲（每个序列最多 {@link SERIES_CAPACITY} 个样本），
 *     保证长时间运行不会无限增长内存；
 *   - 快照落盘是 best-effort：失败只影响 status 的展示，绝不影响查询与索引。
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from './directory';
import type { ResourceProfileName } from './resource-profile';

/** 每个耗时序列保留的样本数；足够算稳定的 p50/p95，又不会长期增长。 */
export const SERIES_CAPACITY = 256;

/** 快照文件名，位于项目的 `.codegraph/` 下。 */
export const RESOURCE_METRICS_FILENAME = 'resource-metrics.json';

export interface DurationStats {
  count: number;
  /** 累加值（所有样本，不只保留的窗口）。 */
  totalMs: number;
  lastMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** 有界耗时样本序列。 */
export class DurationSeries {
  private readonly samples: number[] = [];
  private next = 0;
  private count = 0;
  private total = 0;
  private max = 0;
  private last = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count += 1;
    this.total += ms;
    this.last = ms;
    if (ms > this.max) this.max = ms;
    if (this.samples.length < SERIES_CAPACITY) {
      this.samples.push(ms);
      this.next = this.samples.length % SERIES_CAPACITY;
      return;
    }
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % SERIES_CAPACITY;
  }

  stats(): DurationStats {
    return {
      count: this.count,
      totalMs: Math.round(this.total),
      lastMs: Math.round(this.last),
      maxMs: Math.round(this.max),
      p50Ms: Math.round(percentile(this.samples, 0.5)),
      p95Ms: Math.round(percentile(this.samples, 0.95)),
    };
  }

  reset(): void {
    this.samples.length = 0;
    this.next = 0;
    this.count = 0;
    this.total = 0;
    this.max = 0;
    this.last = 0;
  }
}

/** 已排序副本上的最近秩分位数；空样本返回 0。 */
function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export interface QueryMetrics {
  started: number;
  completed: number;
  /** 因等待超时返回「busy, retry」引导的次数。 */
  busy: number;
  failed: number;
  crashedWorkers: number;
  /** 当前排队中（尚未派发）的调用数。 */
  queueDepth: number;
  liveWorkers: number;
  idleWorkers: number;
  poolMax: number;
  /** 从入队到拿到结果的等待时间。 */
  wait: DurationStats;
  /** worker 内实际执行时间（含回退到主线程的路径）。 */
  run: DurationStats;
  cacheHits: number;
  cacheMisses: number;
}

export interface IndexMetrics {
  fullRuns: number;
  fullLastMs: number;
  fullMaxMs: number;
  fullLastFiles: number;
  incrementalRuns: number;
  incrementalLastMs: number;
  incrementalMaxMs: number;
  incrementalLastFiles: number;
}

export interface LspMetrics {
  starts: number;
  stops: number;
  idleStops: number;
  /** 因每项目软上限或全局预算而退出。 */
  budgetStops: number;
  startDuration: DurationStats;
  /** 上报时刻本进程内的活跃语言服务器数量。 */
  liveServers: number;
  /** 上报时刻全局租约数量（跨 daemon，来自租约注册表）。 */
  globalLeases: number;
}

export interface ResourceMetricsSnapshot {
  schemaVersion: 1;
  updatedAt: number;
  pid: number;
  profile: ResourceProfileName;
  governanceEnabled: boolean;
  query: QueryMetrics;
  index: IndexMetrics;
  lsp: LspMetrics;
}

export interface PoolGauges {
  liveWorkers: number;
  idleWorkers: number;
  queueDepth: number;
  poolMax: number;
}

/**
 * 进程内指标收集器。daemon 只有一个实例（`resourceMetrics()` 单例），
 * 测试可以 new 出自己的实例或调用 {@link resetResourceMetrics} 复位。
 */
export class ResourceMetrics {
  private readonly wait = new DurationSeries();
  private readonly run = new DurationSeries();
  private readonly lspStart = new DurationSeries();
  private queryStarted = 0;
  private queryCompleted = 0;
  private queryBusy = 0;
  private queryFailed = 0;
  private crashedWorkers = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private gauges: PoolGauges = { liveWorkers: 0, idleWorkers: 0, queueDepth: 0, poolMax: 0 };
  private index: IndexMetrics = {
    fullRuns: 0, fullLastMs: 0, fullMaxMs: 0, fullLastFiles: 0,
    incrementalRuns: 0, incrementalLastMs: 0, incrementalMaxMs: 0, incrementalLastFiles: 0,
  };
  private lspStarts = 0;
  private lspStops = 0;
  private lspIdleStops = 0;
  private lspBudgetStops = 0;
  private lspLiveServers = 0;
  private lspGlobalLeases = 0;
  private profile: ResourceProfileName = 'balanced';
  private governanceEnabled = true;

  setProfile(profile: ResourceProfileName, governanceEnabled: boolean): void {
    this.profile = profile;
    this.governanceEnabled = governanceEnabled;
  }

  recordQueryStart(): void {
    this.queryStarted += 1;
  }

  /** `waitMs` = 入队到派发，`runMs` = 派发到结果；回退到主线程时两者相同。 */
  recordQueryEnd(waitMs: number, runMs: number, outcome: 'ok' | 'busy' | 'error'): void {
    this.queryCompleted += 1;
    if (outcome === 'busy') this.queryBusy += 1;
    else if (outcome === 'error') this.queryFailed += 1;
    this.wait.record(waitMs);
    this.run.record(runMs);
  }

  recordWorkerCrash(): void {
    this.crashedWorkers += 1;
  }

  setPoolGauges(gauges: PoolGauges): void {
    this.gauges = { ...gauges };
  }

  recordCache(hit: boolean): void {
    if (hit) this.cacheHits += 1;
    else this.cacheMisses += 1;
  }

  recordIndexRun(kind: 'full' | 'incremental', durationMs: number, filesChanged: number): void {
    const ms = Math.max(0, Math.round(durationMs));
    const files = Math.max(0, Math.round(filesChanged));
    if (kind === 'full') {
      this.index.fullRuns += 1;
      this.index.fullLastMs = ms;
      this.index.fullMaxMs = Math.max(this.index.fullMaxMs, ms);
      this.index.fullLastFiles = files;
      return;
    }
    this.index.incrementalRuns += 1;
    this.index.incrementalLastMs = ms;
    this.index.incrementalMaxMs = Math.max(this.index.incrementalMaxMs, ms);
    this.index.incrementalLastFiles = files;
  }

  recordLspStart(durationMs: number): void {
    this.lspStarts += 1;
    this.lspStart.record(durationMs);
  }

  recordLspStop(reason: 'idle' | 'budget' | 'shutdown' | 'crash' | 'other'): void {
    this.lspStops += 1;
    if (reason === 'idle') this.lspIdleStops += 1;
    if (reason === 'budget') this.lspBudgetStops += 1;
  }

  setLspGauges(liveServers: number, globalLeases: number): void {
    this.lspLiveServers = Math.max(0, liveServers);
    this.lspGlobalLeases = Math.max(0, globalLeases);
  }

  snapshot(): ResourceMetricsSnapshot {
    return {
      schemaVersion: 1,
      updatedAt: Date.now(),
      pid: process.pid,
      profile: this.profile,
      governanceEnabled: this.governanceEnabled,
      query: {
        started: this.queryStarted,
        completed: this.queryCompleted,
        busy: this.queryBusy,
        failed: this.queryFailed,
        crashedWorkers: this.crashedWorkers,
        queueDepth: this.gauges.queueDepth,
        liveWorkers: this.gauges.liveWorkers,
        idleWorkers: this.gauges.idleWorkers,
        poolMax: this.gauges.poolMax,
        wait: this.wait.stats(),
        run: this.run.stats(),
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
      },
      index: { ...this.index },
      lsp: {
        starts: this.lspStarts,
        stops: this.lspStops,
        idleStops: this.lspIdleStops,
        budgetStops: this.lspBudgetStops,
        startDuration: this.lspStart.stats(),
        liveServers: this.lspLiveServers,
        globalLeases: this.lspGlobalLeases,
      },
    };
  }

  reset(): void {
    this.wait.reset();
    this.run.reset();
    this.lspStart.reset();
    this.queryStarted = 0;
    this.queryCompleted = 0;
    this.queryBusy = 0;
    this.queryFailed = 0;
    this.crashedWorkers = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.gauges = { liveWorkers: 0, idleWorkers: 0, queueDepth: 0, poolMax: 0 };
    this.index = {
      fullRuns: 0, fullLastMs: 0, fullMaxMs: 0, fullLastFiles: 0,
      incrementalRuns: 0, incrementalLastMs: 0, incrementalMaxMs: 0, incrementalLastFiles: 0,
    };
    this.lspStarts = 0;
    this.lspStops = 0;
    this.lspIdleStops = 0;
    this.lspBudgetStops = 0;
    this.lspLiveServers = 0;
    this.lspGlobalLeases = 0;
  }
}

let globalMetrics: ResourceMetrics | null = null;

/** 进程内单例；daemon、查询池、LSP 与索引都写入同一份。 */
export function resourceMetrics(): ResourceMetrics {
  if (!globalMetrics) globalMetrics = new ResourceMetrics();
  return globalMetrics;
}

/** 测试钩子：丢弃当前单例，下一次 `resourceMetrics()` 从零开始。 */
export function resetResourceMetrics(): void {
  globalMetrics = null;
}

/**
 * 热路径友好的缓存命中记录（例如 QueryBuilder 的节点 LRU）。
 *
 * 与 `resourceMetrics().recordCache()` 的区别：单例还没建立时（库调用方、CLI
 * 单次命令）只做一次空判断就返回，不会为了指标先创建收集器，也不会在每次节点
 * 查询上付出对象查找的代价。
 */
export function recordQueryCache(hit: boolean): void {
  globalMetrics?.recordCache(hit);
}

/** 快照文件路径。 */
export function getResourceMetricsPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), RESOURCE_METRICS_FILENAME);
}

/**
 * best-effort 写入快照（临时文件 + rename，避免 status 读到半个 JSON）。
 * 返回是否写入成功——调用方只在需要诊断时关心。
 */
export function writeResourceMetricsSnapshot(projectRoot: string, snapshot: ResourceMetricsSnapshot): boolean {
  const file = getResourceMetricsPath(projectRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 已不存在 */ }
    return false;
  }
}

/** 读取快照；文件缺失、损坏或版本不符时返回 null（status 只降级展示）。 */
export function readResourceMetricsSnapshot(projectRoot: string): ResourceMetricsSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getResourceMetricsPath(projectRoot), 'utf-8')) as ResourceMetricsSnapshot;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.updatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
