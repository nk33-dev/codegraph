/**
 * Runtime resource metrics and baselines (development plan section 5, phase 1).
 *
 * Records query queue depth, live/idle workers, query latency, cache hits, LSP lifecycle,
 * and full/incremental indexing duration. These are local operational baselines, not telemetry.
 *
 * Constraints:
 *   - in-process counters use cheap synchronous updates with no I/O;
 *   - percentiles use bounded ring buffers capped by {@link SERIES_CAPACITY};
 *   - snapshot persistence is best-effort and never affects queries or indexing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from './directory';
import { isLiveDaemonFor } from './mcp/daemon-registry';
import type { ResourceProfileName } from './resource-profile';

/** Samples retained per duration series: enough for p50/p95 without unbounded growth. */
export const SERIES_CAPACITY = 256;

/** Snapshot filename under the project's `.codegraph/` directory. */
export const RESOURCE_METRICS_FILENAME = 'resource-metrics.json';

export interface DurationStats {
  count: number;
  /** Accumulated value across all samples, not only the retained window. */
  totalMs: number;
  lastMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** Bounded duration sample series. */
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

/** Nearest-rank percentile over a sorted copy; empty samples return zero. */
function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export interface QueryMetrics {
  started: number;
  completed: number;
  /** Calls that timed out waiting and returned busy/retry guidance. */
  busy: number;
  failed: number;
  crashedWorkers: number;
  /** Calls currently queued but not dispatched. */
  queueDepth: number;
  liveWorkers: number;
  idleWorkers: number;
  poolMax: number;
  /** Time from enqueue to result. */
  wait: DurationStats;
  /** Actual execution time, including main-thread fallback. */
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
  /** Exits caused by per-project soft limits or the global budget. */
  budgetStops: number;
  startDuration: DurationStats;
  /** Live language servers in this process at report time. */
  liveServers: number;
  /** Global lease count across daemons at report time. */
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
 * In-process metric collector. A daemon uses the `resourceMetrics()` singleton;
 * tests may construct isolated instances or call {@link resetResourceMetrics}.
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

  /** `waitMs` is enqueue-to-dispatch; `runMs` is dispatch-to-result. */
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

/** Process singleton shared by the daemon, query pool, LSP, and indexer. */
export function resourceMetrics(): ResourceMetrics {
  if (!globalMetrics) globalMetrics = new ResourceMetrics();
  return globalMetrics;
}

/** Test hook: discard the singleton so the next `resourceMetrics()` starts empty. */
export function resetResourceMetrics(): void {
  globalMetrics = null;
}

/**
 * Hot-path cache-hit recording, such as QueryBuilder's node LRU.
 *
 * Unlike `resourceMetrics().recordCache()`, this returns immediately when the singleton
 * does not exist and never creates the collector merely to record a metric.
 */
export function recordQueryCache(hit: boolean): void {
  globalMetrics?.recordCache(hit);
}

/** Snapshot file path. */
export function getResourceMetricsPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), RESOURCE_METRICS_FILENAME);
}

/**
 * Best-effort atomic snapshot write using a temporary file and rename.
 * Returns success for callers that need diagnostics.
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
    try { fs.unlinkSync(tmp); } catch { /* Already absent. */ }
    return false;
  }
}

/** Read a snapshot; missing, corrupt, or incompatible files return null. */
export function readResourceMetricsSnapshot(projectRoot: string): ResourceMetricsSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getResourceMetricsPath(projectRoot), 'utf-8')) as ResourceMetricsSnapshot;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.updatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Daemons report every 10 seconds; older snapshots are historical rather than current state. */
export const REPORTED_SNAPSHOT_STALE_MS = 60_000;

export type ReportedSnapshotState = 'live' | 'exited' | 'stale';

/** Classify whether a persisted snapshot still represents the current project daemon. */
export function reportedSnapshotState(
  projectRoot: string,
  snapshot: ResourceMetricsSnapshot | null,
  now: number = Date.now(),
): { state: ReportedSnapshotState | null; ageMs: number | null } {
  if (!snapshot) return { state: null, ageMs: null };
  const ageMs = Math.max(0, now - snapshot.updatedAt);
  if (!isLiveDaemonFor(projectRoot, snapshot.pid)) return { state: 'exited', ageMs };
  return { state: ageMs > REPORTED_SNAPSHOT_STALE_MS ? 'stale' : 'live', ageMs };
}
