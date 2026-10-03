/**
 * The store writer's backpressure window, by count and by bytes.
 *
 * The bulk index path bounds un-acked bundles by item count (STORE_WRITER_WINDOW),
 * which bounds the queue but not its size: every bundle comes from a file the
 * read cap already limited to 1 MiB, but the node/edge arrays a dense source
 * extracts can be far larger than the source. The byte bound is additive, and
 * `StoreWindow` is the accounting behind it — tested here without a worker
 * thread, because the live writer only exists after a build.
 */

import { describe, it, expect } from 'vitest';
import { StoreWindow, estimateStoreBundleBytes, type StoreBundle, type KernelStoreBundle } from '../src/extraction/store-writer';
import type { FileRecord } from '../src/types';

/** Let queued promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const FILE = { path: 'a.ts', language: 'typescript' } as unknown as FileRecord;

function objectBundle(nodes: number, edges: number, refs: number): StoreBundle {
  return {
    nodes: Array.from({ length: nodes }, () => ({}) as never),
    edges: Array.from({ length: edges }, () => ({}) as never),
    refs: Array.from({ length: refs }, () => ({}) as never),
    file: FILE,
  };
}

function kernelBundle(...sizes: number[]): KernelStoreBundle {
  const buffer = (bytes: number) => new Uint8Array(bytes);
  return {
    kernel: true,
    filePath: 'a.ts',
    language: 'typescript',
    buffers: { meta: buffer(sizes[0] ?? 0), nodes: buffer(sizes[1] ?? 0), edges: buffer(sizes[2] ?? 0), refs: buffer(sizes[3] ?? 0), arena: buffer(sizes[4] ?? 0) },
    file: FILE,
  };
}

describe('estimateStoreBundleBytes', () => {
  it('sums the kernel table buffers exactly', () => {
    expect(estimateStoreBundleBytes(kernelBundle(100, 200, 300, 40, 5_000))).toBe(5_640);
  });

  it('estimates the object fallback from the array lengths', () => {
    const small = estimateStoreBundleBytes(objectBundle(1, 1, 1));
    const large = estimateStoreBundleBytes(objectBundle(1_000, 2_000, 500));
    expect(large).toBeGreaterThan(small);
    // A dense extraction of a file well under the 1 MiB read cap is exactly the
    // case the count-only window missed: this estimate is already over 1 MiB.
    expect(estimateStoreBundleBytes(objectBundle(2_000, 4_000, 1_000))).toBeGreaterThan(1024 * 1024);
  });
});

describe('StoreWindow', () => {
  it('tracks outstanding bundles and their bytes, settling oldest first', () => {
    const w = new StoreWindow();
    w.add(1_000);
    w.add(30);
    expect(w.outstanding).toBe(2);
    expect(w.outstandingBytes).toBe(1_030);
    w.settle();
    expect(w.outstanding).toBe(1);
    expect(w.outstandingBytes).toBe(30); // the 1_000-byte bundle went first
    w.settle();
    expect(w.outstanding).toBe(0);
    expect(w.outstandingBytes).toBe(0);
  });

  it('resolves a byte waiter only once enough has been settled', async () => {
    const w = new StoreWindow();
    w.add(1_000);
    w.add(1_000);
    let resolved = false;
    const waiting = w.waitBelowBytes(1_500).then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    w.settle();
    await waiting;
    expect(resolved).toBe(true);
    expect(w.outstandingBytes).toBe(1_000);
  });

  it('resolves immediately when the bound already holds', async () => {
    const w = new StoreWindow();
    w.add(10);
    await expect(w.waitBelowBytes(1_000)).resolves.toBeUndefined();
    await expect(w.waitBelow(5)).resolves.toBeUndefined();
  });

  it('does not deadlock on a bundle larger than the whole budget', async () => {
    const w = new StoreWindow();
    w.add(10_000_000);
    let resolved = false;
    const waiting = w.waitBelowBytes(1_000).then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    w.settle(); // the oversize bundle's own ack empties the window
    await waiting;
    expect(resolved).toBe(true);
  });

  it('keeps a count waiter and a byte waiter independent', async () => {
    const w = new StoreWindow();
    for (let i = 0; i < 4; i++) w.add(1_000_000);
    let byCount = false;
    let byBytes = false;
    const countWait = w.waitBelow(2).then(() => { byCount = true; });
    const byteWait = w.waitBelowBytes(1_500_000).then(() => { byBytes = true; });
    await flush();
    w.settle();
    w.settle();
    await flush();
    expect(byCount).toBe(false); // 2 bundles still outstanding
    expect(byBytes).toBe(false); // and 2 MB still held
    w.settle();
    await Promise.all([countWait, byteWait]);
    expect(byCount).toBe(true);
    expect(byBytes).toBe(true);
    expect(w.outstandingBytes).toBe(1_000_000);
  });

  it('releases every waiter when the writer is reset', async () => {
    const w = new StoreWindow();
    w.add(5_000);
    let byBytes = false;
    let byCount = false;
    const bytes = w.waitBelowBytes(1).then(() => { byBytes = true; });
    const count = w.waitBelow(0).then(() => { byCount = true; });
    await flush();
    w.reset();
    await Promise.all([bytes, count]);
    expect(byBytes).toBe(true);
    expect(byCount).toBe(true);
    expect(w.outstanding).toBe(0);
    expect(w.outstandingBytes).toBe(0);
  });
});
