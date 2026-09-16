/**
 * Query pool — runs CPU-heavy read-tool calls on a pool of worker threads so
 * the shared daemon's main event loop stays free for the MCP transport.
 *
 * Why this exists: see {@link ./query-worker}. One daemon, one event loop, one
 * synchronous SQLite connection serializes every concurrent `codegraph_explore`
 * AND starves the transport (a 10-way wave delivered 0 transport heartbeats in
 * 25s — responses can't flush until the whole batch drains, so clients time
 * out). Spreading the dispatch across worker threads (each its own WAL read
 * connection) restores true multi-core parallelism and an idle main loop.
 *
 * Properties:
 *   - lazy growth: one warm worker on construct, grows to `size` on demand, so a
 *     single-agent session pays for one connection and a 10-subagent burst grows
 *     to the core budget.
 *   - crash recovery: a dead worker is respawned and its in-flight call retried
 *     once; a poison call that keeps crashing fails gracefully (never wedges the
 *     pool). A crash budget trips a circuit breaker (`healthy` → false) so the
 *     caller falls back to in-process dispatch instead of thrashing respawns.
 *   - graceful backstop: a call that can't be served within `softTimeoutMs`
 *     resolves with SUCCESS-shaped "busy, retry" guidance — never `isError`, so
 *     a momentary overload can't teach the agent to abandon codegraph — instead
 *     of hanging past the client's hard timeout.
 *   - idle shrink (阶段一): a burst grows the pool to `size`, and once the burst
 *     drains the pool shrinks back to `minSize` after `idleShrinkMs`. Shrinking
 *     only ever reclaims IDLE workers (never one with an in-flight call, never
 *     one the queue is about to use), so no request is lost. This is the fix for
 *     "增长后不会自动缩容，直到 daemon 销毁", which kept a 16-thread machine
 *     busy long after the sub-agents that caused the burst had finished.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import type { ToolResult } from './tools';
import { MAX_QUERY_WORKERS, resolveResourceProfile } from '../resource-profile';
import { resourceMetrics } from '../resource-metrics';

/** Compiled sibling — `query-worker.js` lives next to this file in `dist/mcp/`. */
const WORKER_FILE = path.join(__dirname, 'query-worker.js');

/**
 * Minimal worker surface the pool drives — satisfied by a real `worker_threads`
 * Worker. Abstracted so tests can inject a fake worker and exercise the pool's
 * queue / growth / crash-recovery / backstop logic without spawning threads or
 * needing a built `dist/`.
 */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', cb: (m: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
}

/** Default linger before a queued call is answered with busy-guidance. */
const DEFAULT_BUSY_TIMEOUT_MS = 45_000; // < the ~60s MCP client request timeout

/** Hard ceiling on pool size regardless of core count / env. */
const MAX_POOL_SIZE = MAX_QUERY_WORKERS;

/**
 * Total worker deaths before the pool declares itself unhealthy and the caller
 * reverts to in-process dispatch. High enough to ride out a few transient
 * crashes, low enough that a systematically-broken worker (e.g. a platform that
 * can't spawn threads) degrades quickly instead of respawning forever.
 */
const CRASH_BUDGET = 12;

/**
 * Max workers cold-starting at once. A worker's cold start is heavy — full
 * module load (tree-sitter etc.) + opening a large WAL DB — and starting the
 * whole pool simultaneously thrashes CPU/I-O so badly it can stall the daemon's
 * main loop for tens of seconds. Warming a couple at a time keeps each start
 * fast; as one reports ready the next begins, so the pool still reaches full
 * size within a few calls of a burst, just without the thundering herd.
 */
const MAX_CONCURRENT_SPAWN = 2;

/** Shape of a message a worker posts back (ready handshake or a tool result). */
interface WorkerMessage {
  type?: string;
  ok?: boolean;
  id?: number;
  result?: ToolResult;
}

interface Job {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (r: ToolResult) => void;
  retries: number;
  settled: boolean;
  enqueuedAt: number;
  dispatchedAt?: number;
  softTimer?: NodeJS.Timeout;
}

export interface QueryPoolOptions {
  /** Default project root each worker opens at spawn. */
  root: string;
  /** Max worker threads. Defaults to the resource profile's cap (bounded by cores). */
  size?: number;
  /** Workers warmed at construction. Default 1. */
  initialSize?: number;
  /** Floor the idle shrink reclaims down to. Default 1. */
  minSize?: number;
  /** Idle time before shrinking back to `minSize`; 0 disables shrinking. Default 0. */
  idleShrinkMs?: number;
  /** Linger before a queued call gets busy-guidance. Default 45s. */
  softTimeoutMs?: number;
  /** Retries for an in-flight call whose worker crashed. Default 1. */
  maxRetries?: number;
  /** Worker factory (tests inject a fake). Defaults to a real `worker_threads` Worker. */
  createWorker?: () => PoolWorker;
}

/**
 * Resolve the pool size from the `CODEGRAPH_QUERY_POOL_SIZE` override and the
 * machine's core count. `0` (or a negative) explicitly disables the pool (the
 * caller serves in-process — today's behavior). Unset → the resource profile's
 * cap, further bounded by `cores-1`: the profile decides the budget, the core
 * count keeps a 2-core box from being handed a 4-worker pool.
 *
 * 阶段一之前这里默认 `clamp(cores-1, 1, 16)`，在 16 逻辑线程机器上直接给出
 * 15 个 worker 的上限；现在默认值改由档位决定，显式覆盖和硬上限 16 仍然有效。
 */
export function resolvePoolSize(
  envVal: string | undefined,
  cpuCount: number,
  profileMax: number = resolveResourceProfile().queryWorkersMax,
): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), MAX_POOL_SIZE);
    // non-numeric / negative → fall through to the default
  }
  const coreBound = Math.max(1, cpuCount - 1);
  return Math.max(1, Math.min(profileMax, coreBound, MAX_POOL_SIZE));
}

function resolveBusyTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUSY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.floor(n);
}

/** Success-shaped overload guidance (NEVER isError — see the abandonment rule). */
function busyGuidance(waitedMs: number): ToolResult {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  return {
    content: [{
      type: 'text',
      text:
        `CodeGraph is busy serving other concurrent requests right now (this call waited ${secs}s in the queue). ` +
        `This is NOT an error and the index is fine — wait a few seconds and retry this exact call; it will return normally. ` +
        `If you can't wait, use your built-in tools for just this one step.`,
    }],
  };
}

export class QueryPool {
  private idle: PoolWorker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<PoolWorker, Job>();
  private workers = new Set<PoolWorker>();
  // Workers spawned but not yet 'ready'. Growth must count these so a single
  // first call (with the eager worker still starting) doesn't spawn the WHOLE
  // pool at once — N simultaneous cold worker starts (each a full module load +
  // a large DB open) saturate the box and starve the main loop. Grow only when
  // the queue outstrips idle + pending.
  private pendingWorkers = new Set<PoolWorker>();
  private nextId = 1;
  private totalCrashes = 0;
  private destroyed = false;
  private readonly root: string;
  private readonly maxSize: number;
  private readonly minSize: number;
  private readonly idleShrinkMs: number;
  private readonly softTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createWorker: () => PoolWorker;
  /** 最近一次派发/完成的时刻，缩容判定的空窗起点。 */
  private lastActivityAt = Date.now();
  private shrinkTimer: NodeJS.Timeout | null = null;

  constructor(opts: QueryPoolOptions) {
    this.root = opts.root;
    this.maxSize = Math.max(
      1,
      Math.min(opts.size ?? resolvePoolSize(process.env.CODEGRAPH_QUERY_POOL_SIZE, os.cpus().length), MAX_POOL_SIZE),
    );
    this.minSize = Math.max(1, Math.min(opts.minSize ?? 1, this.maxSize));
    this.idleShrinkMs = Math.max(0, opts.idleShrinkMs ?? 0);
    this.softTimeoutMs = opts.softTimeoutMs ?? resolveBusyTimeoutMs();
    this.maxRetries = opts.maxRetries ?? 1;
    this.createWorker = opts.createWorker ?? (() => new Worker(WORKER_FILE, { workerData: { root: this.root } }));
    // 档位里 performance 预热 2 个 worker；其余档位 1 个，让串行会话只付一个连接的代价。
    const initial = Math.max(1, Math.min(opts.initialSize ?? 1, this.maxSize));
    for (let i = 0; i < initial; i++) this.spawnOne();
    this.updateGauges();
  }

  /** Pool size cap (for logging/status). */
  get size(): number { return this.maxSize; }

  /** Live worker count (for tests/status). */
  get liveWorkers(): number { return this.workers.size; }

  /** Idle (ready, not serving) worker count (for tests/status). */
  get idleWorkers(): number { return this.idle.length; }

  /** Queued-but-undispatched call count (for tests/status). */
  get queuedJobs(): number { return this.queue.length; }

  /** Idle-shrink floor (for tests/status). */
  get floorSize(): number { return this.minSize; }

  /** 当前池状态快照，供 status 与指标使用。 */
  poolState(): { live: number; idle: number; queued: number; inflight: number; max: number; min: number; idleShrinkMs: number } {
    return {
      live: this.workers.size,
      idle: this.idle.length,
      queued: this.queue.length,
      inflight: this.inflight.size,
      max: this.maxSize,
      min: this.minSize,
      idleShrinkMs: this.idleShrinkMs,
    };
  }

  /**
   * False once the crash budget is exhausted (or after destroy). The ToolHandler
   * checks this and falls back to in-process dispatch — a broken worker platform
   * degrades to today's behavior instead of failing tool calls.
   */
  get healthy(): boolean {
    return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
  }

  /**
   * True once at least one worker has completed its cold start (posted the
   * 'ready' handshake). Until then the ToolHandler serves calls IN-PROCESS:
   * a worker cold start is a full module load + DB open — seconds normally,
   * tens of seconds on a loaded machine — and a call queued behind it gets
   * nothing until the 45s busy backstop. The daemon's very first tool call
   * hitting that window was the recurring #662 test flake (and a real
   * first-call stall for agents). The pool exists for CONCURRENT load, which
   * by definition arrives after warm-up; the pre-pool in-process path is
   * strictly better while nothing is warm. Stays true for the pool's
   * lifetime — later crash-respawn gaps are covered by retry + backstop.
   */
  get ready(): boolean {
    return this.everReady && !this.destroyed;
  }
  private everReady = false;

  private spawnOne(): void {
    if (this.destroyed || this.workers.size >= this.maxSize) return;
    let w: PoolWorker;
    try {
      w = this.createWorker();
    } catch {
      this.totalCrashes++; // counts toward the circuit breaker
      return;
    }
    this.workers.add(w);
    this.pendingWorkers.add(w);
    w.on('message', (m) => this.onMessage(w, (m ?? {}) as WorkerMessage));
    w.on('error', () => this.onWorkerGone(w));
    w.on('exit', (code) => { if (code !== 0) this.onWorkerGone(w); });
  }

  private onMessage(w: PoolWorker, m: WorkerMessage): void {
    if (!m) return;
    if (m.type === 'ready') {
      this.pendingWorkers.delete(w);
      if (m.ok === false) this.totalCrashes++; // hard open failure
      else this.everReady = true;
      this.idle.push(w);
      this.drain();
      return;
    }
    if (m.type === 'result') {
      const job = this.inflight.get(w);
      this.inflight.delete(w);
      this.idle.push(w);
      if (job) this.settle(job, m.result ?? busyGuidance(0));
      this.lastActivityAt = Date.now();
      this.drain();
    }
  }

  // A worker died (crash hook, OOM, segfault, exit≠0). Respawn a replacement and
  // retry its in-flight job once; a job that keeps crashing workers fails
  // gracefully so it can't loop the pool forever.
  private onWorkerGone(w: PoolWorker): void {
    if (!this.workers.has(w)) return; // already handled (error+exit both fire)
    this.workers.delete(w);
    this.pendingWorkers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.totalCrashes++;
    resourceMetrics().recordWorkerCrash();
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    try { void w.terminate(); } catch { /* already gone */ }
    if (this.healthy) this.spawnOne(); // keep capacity
    if (job) {
      if (job.retries < this.maxRetries && this.healthy) {
        job.retries++;
        this.queue.unshift(job); // head of line — retry promptly
      } else {
        this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph worker crashed; please retry the call.' }] }, 'error');
      }
    }
    this.updateGauges();
    this.drain();
  }

  private drain(): void {
    // Grow toward maxSize while queued work outstrips workers that are idle OR
    // already on their way up (pending) — so we never spawn the whole pool for a
    // single call whose eager worker just hasn't reported ready yet.
    while (
      this.queue.length > this.idle.length + this.pendingWorkers.size &&
      this.workers.size < this.maxSize &&
      this.pendingWorkers.size < MAX_CONCURRENT_SPAWN &&
      this.healthy
    ) {
      this.spawnOne();
    }
    while (this.idle.length && this.queue.length) {
      // Skip jobs the backstop already answered.
      let job: Job | undefined;
      while (this.queue.length && (job = this.queue.shift()) && job.settled) job = undefined;
      if (!job || job.settled) break;
      const w = this.idle.pop()!;
      job.dispatchedAt = Date.now();
      this.inflight.set(w, job);
      w.postMessage({ type: 'call', id: job.id, toolName: job.toolName, args: job.args });
    }
    this.updateGauges();
    this.armIdleShrink();
  }

  private settle(job: Job, result: ToolResult, outcome: 'ok' | 'busy' | 'error' = 'ok'): void {
    if (job.settled) return; // already answered (by backstop or worker)
    job.settled = true;
    if (job.softTimer) clearTimeout(job.softTimer);
    const endedAt = Date.now();
    const dispatchedAt = job.dispatchedAt ?? job.enqueuedAt;
    resourceMetrics().recordQueryEnd(dispatchedAt - job.enqueuedAt, endedAt - dispatchedAt, result.isError ? 'error' : outcome);
    job.resolve(result);
  }

  /**
   * 空闲缩容：只有当「没有排队任务、没有在途任务」且空闲时间超过
   * `idleShrinkMs` 时，才终止多余的 idle worker，且保留 `minSize` 个。
   * 定时器 unref，不会拖住 daemon 退出；缩容前先把 worker 从集合里摘掉，
   * 让 `terminate()` 触发的 exit 不会走崩溃恢复路径。
   */
  private armIdleShrink(): void {
    if (this.destroyed || this.idleShrinkMs <= 0 || this.minSize >= this.maxSize) return;
    if (this.workers.size <= this.minSize) {
      this.clearShrinkTimer();
      return;
    }
    if (this.shrinkTimer) return; // 已在等待下一次判定
    this.shrinkTimer = setTimeout(() => {
      this.shrinkTimer = null;
      this.shrinkIdleWorkers();
    }, this.idleShrinkMs);
    this.shrinkTimer.unref?.();
  }

  private shrinkIdleWorkers(now = Date.now()): void {
    if (this.destroyed) return;
    if (this.queue.length > 0) {
      // 有排队任务说明容量仍在被需要；等下一轮空窗再判定。
      this.armIdleShrink();
      return;
    }
    if (now - this.lastActivityAt < this.idleShrinkMs) {
      this.armIdleShrink();
      return;
    }
    const excess = this.workers.size - this.minSize;
    if (excess <= 0) return;
    // 只回收 idle worker：在途调用（inflight）从不出现在 this.idle 里，
    // 因此「不关闭活跃 worker」由数据结构保证，而不依赖额外判断。
    const doomed = this.idle.splice(Math.max(0, this.idle.length - excess), excess);
    for (const w of doomed) {
      if (this.inflight.has(w)) continue; // 防御：绝不动在途 worker
      this.workers.delete(w);
      this.pendingWorkers.delete(w);
      try { void w.terminate(); } catch { /* 已退出 */ }
    }
    this.updateGauges();
    // 仍未缩到目标（例如空闲数不足）时，下一轮继续。
    if (this.workers.size > this.minSize) this.armIdleShrink();
  }

  private clearShrinkTimer(): void {
    if (!this.shrinkTimer) return;
    clearTimeout(this.shrinkTimer);
    this.shrinkTimer = null;
  }

  private updateGauges(): void {
    resourceMetrics().setPoolGauges({
      liveWorkers: this.workers.size,
      idleWorkers: this.idle.length,
      queueDepth: this.queue.length,
      poolMax: this.maxSize,
    });
  }

  /** Run a read tool on the pool. Always resolves (never rejects). */
  run(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const job: Job = {
        id: this.nextId++, toolName, args, resolve,
        retries: 0, settled: false, enqueuedAt: Date.now(),
      };
      resourceMetrics().recordQueryStart();
      // Don't let the caller wait past softTimeoutMs. The worker may still be
      // busy (we can't cancel synchronous CPU), but the CLIENT gets a prompt,
      // success-shaped "retry" instead of a hard timeout.
      job.softTimer = setTimeout(() => {
        if (!job.settled) this.settle(job, busyGuidance(Date.now() - job.enqueuedAt), 'busy');
      }, this.softTimeoutMs);
      job.softTimer.unref?.();
      this.queue.push(job);
      this.lastActivityAt = Date.now();
      this.drain();
    });
  }

  /** Terminate all workers and answer any outstanding calls gracefully. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearShrinkTimer();
    const ws = [...this.workers];
    this.workers.clear();
    this.pendingWorkers.clear();
    this.idle = [];
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph is shutting down; retry shortly.' }] }, 'error');
    }
    this.inflight.clear();
    this.queue = [];
    this.updateGauges();
    await Promise.all(ws.map((w) => Promise.resolve(w.terminate()).catch(() => { /* already gone */ })));
  }
}
