/**
 * Coarse per-item sizes for the object path's byte estimate. The kernel path —
 * the default — measures exactly (see below), so these only bound the fallback.
 */
const ESTIMATED_NODE_BYTES = 512;
const ESTIMATED_EDGE_BYTES = 192;
const ESTIMATED_REF_BYTES = 128;

/**
 * Bytes a bundle adds to the outstanding window.
 *
 * The kernel path is exact and free: its five table buffers already exist, and
 * `byteLength` is what the main thread is holding until the worker acks. The
 * object path (no `dist` store worker) is estimated from array lengths, which is
 * enough to bound it — the point is to notice one file whose extraction produced
 * orders of magnitude more than its source, not to account for every byte.
 */
export function estimateStoreBundleBytes(bundle: StoreBundle | KernelStoreBundle): number {
  if ('kernel' in bundle) {
    const { meta, nodes, edges, refs, arena } = bundle.buffers;
    return meta.byteLength + nodes.byteLength + edges.byteLength + refs.byteLength + arena.byteLength;
  }
  return (
    bundle.nodes.length * ESTIMATED_NODE_BYTES +
    bundle.edges.length * ESTIMATED_EDGE_BYTES +
    bundle.refs.length * ESTIMATED_REF_BYTES
  );
}

/**
 * StoreWriter — main-thread client for the store worker (see store-worker.ts).
 *
 * Used ONLY on the fresh-DB bulk path: bundles are posted in file order and the
 * worker applies them in arrival order, so rowid assignment (and therefore
 * resolution's insertion-order disambiguation) is byte-identical to the
 * main-thread store. Kill switch: CODEGRAPH_NO_STORE_WORKER=1.
 */

import { Worker } from 'worker_threads';
import { ExtractionResult, Language, Node, Edge, UnresolvedReference, FileRecord } from '../types';
import { terminateOnceStarted, workerStarted } from '../worker-teardown';

/** One file's complete store payload (pre-filtered — see storeFileBundle). */
export interface StoreBundle {
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
  file: FileRecord;
}

/**
 * A kernel deferred-decode payload: the file's raw table buffers plus the
 * FileRecord the main thread built from meta counts. The store WORKER decodes
 * and finalizes (same filters as the object path), so per-node objects never
 * exist on the main thread.
 */
export interface KernelStoreBundle {
  kernel: true;
  filePath: string;
  language: Language;
  buffers: NonNullable<ExtractionResult['kernelBuffers']>;
  file: FileRecord;
  /** References read beside the kernel's tables (a CommonJS `require`). */
  extraRefs?: ExtractionResult['unresolvedReferences'];
}

/**
 * The validation/denormalization every bundle gets before storeFileBundle —
 * shared by the orchestrator's object path and the store worker's kernel
 * decode path so the two can never drift:
 *   - nodes missing identity fields are dropped (#42-class safety),
 *   - edges must connect inserted nodes (FK integrity),
 *   - refs must originate from inserted nodes and carry the denormalized
 *     filePath/language the resolver reads.
 */
export function finalizeStoreBundle(
  result: Pick<ExtractionResult, 'nodes' | 'edges' | 'unresolvedReferences'>,
  filePath: string,
  language: Language,
  file: FileRecord
): StoreBundle {
  const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);
  const insertedIds = new Set(validNodes.map((n) => n.id));
  const validEdges = result.edges.filter(
    (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
  );
  const validRefs = result.unresolvedReferences
    .filter((ref) => insertedIds.has(ref.fromNodeId))
    .map((ref) => ({
      ...ref,
      filePath: ref.filePath ?? filePath,
      language: ref.language ?? language,
    }));
  return { nodes: validNodes, edges: validEdges, refs: validRefs, file };
}

/**
 * The un-acked bundle window: a queue-depth bound and a byte bound, both with
 * waiters.
 *
 * Separate from the worker plumbing so the accounting — which is the part that
 * is easy to get subtly wrong — can be tested without a worker thread. The byte
 * entries are FIFO because the store worker acks in arrival order (an `error`
 * reply is the failed bundle's ack), so the oldest entry is always the one that
 * settled.
 */
export class StoreWindow {
  private count = 0;
  private bytes = 0;
  private sizes: number[] = [];
  private waiters: Array<{ ready: () => boolean; resolve: () => void }> = [];

  get outstanding(): number {
    return this.count;
  }

  get outstandingBytes(): number {
    return this.bytes;
  }

  /** Whether any waiter is still pending — the exit handler's protocol check. */
  hasWaiters(): boolean {
    return this.waiters.length > 0;
  }

  /** Record a posted bundle of `byteSize` bytes. */
  add(byteSize: number): void {
    this.count++;
    this.sizes.push(byteSize);
    this.bytes += byteSize;
  }

  /** Record one bundle's ack, then release every waiter whose bound now holds. */
  settle(): void {
    const settled = this.sizes.shift();
    this.bytes = settled === undefined ? 0 : this.bytes - settled;
    if (this.count > 0) this.count--;
    if (this.bytes < 0) this.bytes = 0; // sizes and count can only drift together
    if (this.waiters.length === 0) return;
    const still: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (waiter.ready()) waiter.resolve();
      else still.push(waiter);
    }
    this.waiters = still;
  }

  /**
   * Drop all accounting and release waiters — the writer failed or exited, and
   * the caller's next `send()` surfaces the reason.
   */
  reset(): void {
    this.count = 0;
    this.bytes = 0;
    this.sizes = [];
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /** Resolves once fewer than `limit` bundles are un-acked. */
  waitBelow(limit: number): Promise<void> {
    return this.waitUntil(() => this.count < limit);
  }

  /**
   * Resolves once the un-acked bundles hold fewer than `limitBytes` bytes.
   *
   * A single bundle larger than the whole budget does not deadlock: once its
   * ack arrives the total drops to 0 and the waiter resolves.
   */
  waitBelowBytes(limitBytes: number): Promise<void> {
    return this.waitUntil(() => this.bytes < limitBytes);
  }

  private waitUntil(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ ready, resolve });
    });
  }
}

export class StoreWriter {
  private worker: Worker;
  /** Settles on the worker's first message or its end — see worker-teardown.ts. */
  private started: Promise<void>;
  private readyPromise: Promise<void>;
  private firstError: Error | null = null;
  private drainWaiters = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private nextDrainId = 0;
  private exited = false;
  /** Bundles posted but not yet acked, by count and by bytes — see StoreWindow. */
  private window = new StoreWindow();

  constructor(workerScriptPath: string, dbPath: string, fastInit: boolean) {
    this.worker = new Worker(workerScriptPath);
    this.started = workerStarted(this.worker);
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    this.worker.on('message', (msg: { type: string; id?: number; message?: string }) => {
      if (msg.type === 'ready') {
        readyResolve();
      } else if (msg.type === 'ack') {
        this.settleOne();
      } else if (msg.type === 'drained' && msg.id !== undefined) {
        const waiter = this.drainWaiters.get(msg.id);
        this.drainWaiters.delete(msg.id);
        if (!waiter) return;
        if (this.firstError) waiter.reject(this.firstError);
        else waiter.resolve();
      } else if (msg.type === 'error') {
        if (!this.firstError) this.firstError = new Error(`store worker: ${msg.message}`);
        this.settleOne(); // the error reply is also the failed bundle's ack
      }
    });
    this.worker.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      readyReject(this.firstError!);
    });
    this.worker.on('exit', (code) => {
      this.exited = true;
      if (code !== 0) {
        this.failAll(new Error(`store worker exited with code ${code}`));
        readyReject(this.firstError!);
      } else if (this.drainWaiters.size > 0 || this.window.hasWaiters()) {
        // A clean exit with waiters pending is a protocol violation (only
        // close() should end the worker) — settle the waiters instead of
        // hanging the index forever.
        this.failAll(new Error('store worker exited before drain completed'));
      }
    });

    this.worker.postMessage({ type: 'open', dbPath, fastInit });
    // The worker holds the event loop open only until close(); don't unref —
    // bundles must never be dropped because main ran out of work.
  }

  private failAll(err: Error): void {
    if (!this.firstError) this.firstError = err;
    for (const [, waiter] of this.drainWaiters) waiter.reject(this.firstError);
    this.drainWaiters.clear();
    this.window.reset(); // send() will surface firstError
  }

  private settleOne(): void {
    this.window.settle();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Post one file's bundle. Throws immediately if the writer already failed. */
  send(bundle: StoreBundle | KernelStoreBundle): void {
    if (this.firstError) throw this.firstError;
    if (this.exited) throw new Error('store worker already exited');
    this.window.add(estimateStoreBundleBytes(bundle));
    this.worker.postMessage({ type: 'bundle', bundle });
  }

  /** Backpressure: resolves once fewer than `limit` bundles are un-acked. */
  waitBelow(limit: number): Promise<void> {
    if (this.firstError || this.exited) return Promise.resolve();
    return this.window.waitBelow(limit);
  }

  /**
   * Backpressure on volume rather than count: resolves once the un-acked
   * bundles hold fewer than `limitBytes` bytes. A single bundle larger than the
   * whole budget does not deadlock — its ack drops the total to 0.
   */
  waitBelowBytes(limitBytes: number): Promise<void> {
    if (this.firstError || this.exited) return Promise.resolve();
    return this.window.waitBelowBytes(limitBytes);
  }

  /** Resolves when every bundle posted before this call has been applied. */
  drain(): Promise<void> {
    if (this.firstError) return Promise.reject(this.firstError);
    if (this.exited) return Promise.reject(new Error('store worker already exited'));
    const id = this.nextDrainId++;
    const p = new Promise<void>((resolve, reject) => {
      this.drainWaiters.set(id, { resolve, reject });
    });
    this.worker.postMessage({ type: 'drain', id });
    return p;
  }

  /**
   * Close the worker's DB connection and join the thread; the worker collects
   * garbage and exits by itself (worker-teardown.ts). One that hasn't by
   * `timeoutMs` is terminated — but never while it is still starting up.
   */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.exited) return;
    this.worker.postMessage({ type: 'close' });
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        void terminateOnceStarted(this.worker, this.started).then(() => resolve());
      }, timeoutMs);
      this.worker.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
