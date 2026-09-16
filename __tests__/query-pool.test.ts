/**
 * QueryPool — the off-loop worker pool that keeps the shared daemon's main
 * event loop free for the MCP transport under concurrent read load (the
 * "10 subagents time out" report). These tests drive the pool's queue / growth /
 * crash-recovery / backstop logic with INJECTED fake workers, so they exercise
 * the real scheduling code without spawning threads or needing a built dist.
 *
 * End-to-end behavior with real worker threads (a worker opens its own WAL read
 * connection and runs codegraph_explore) is validated separately against a real
 * index; here we pin the orchestration that makes that safe and fair.
 */
import { describe, it, expect } from 'vitest';
import { QueryPool, resolvePoolSize, type PoolWorker } from '../src/mcp/query-pool';
import type { ToolResult } from '../src/mcp/tools';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallMsg { type: 'call'; id: number; toolName: string; args: Record<string, unknown> }
type Action = { result: ToolResult } | { crash: true } | { hang: true } | { wait: Promise<ToolResult> };

/**
 * Fake worker speaking the same {type:'ready'|'result'} protocol as the real
 * one. `behavior` decides per call whether to return a result, crash (exit≠0),
 * hang (never reply — exercises the backstop), or wait on a promise (lets a test
 * hold a call in-flight to observe concurrency). Emits 'ready' on a macrotask so
 * the pool has wired its listeners first.
 */
class FakeWorker implements PoolWorker {
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  alive = true;
  constructor(private behavior: (m: CallMsg) => Action, readyOk = true) {
    setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'ready', ok: readyOk }); }, 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
    // 'error' unused by the fakes
  }
  private reply(id: number, result: ToolResult): void {
    if (this.alive) this.msgCb?.({ type: 'result', id, result });
  }
  postMessage(msg: unknown): void {
    const m = msg as CallMsg;
    if (!m || m.type !== 'call') return;
    const action = this.behavior(m);
    if ('crash' in action) {
      this.alive = false;
      setTimeout(() => this.exitCb?.(13), 0); // simulate a crash exit
      return;
    }
    if ('hang' in action) return; // never reply
    if ('wait' in action) { void action.wait.then((r) => this.reply(m.id, r)); return; }
    setTimeout(() => this.reply(m.id, action.result), 0);
  }
  terminate(): Promise<number> { this.alive = false; return Promise.resolve(0); }
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

describe('resolvePoolSize', () => {
  it('honors a numeric override and disables on 0', () => {
    expect(resolvePoolSize('0', 8)).toBe(0);
    expect(resolvePoolSize('3', 8)).toBe(3);
  });
  it('caps the override at the hard ceiling', () => {
    expect(resolvePoolSize('999', 8)).toBe(16);
  });
  it('defaults to the resource profile cap, bounded by the machine (§阶段一)', () => {
    // balanced 档位上限 4；不再按 cores-1 直接给到 15。
    expect(resolvePoolSize(undefined, 8)).toBe(4);
    expect(resolvePoolSize('', 8)).toBe(4);
    expect(resolvePoolSize('abc', 8)).toBe(4);
    expect(resolvePoolSize(undefined, 1)).toBe(1);   // never zero
    expect(resolvePoolSize(undefined, 64)).toBe(4);  // 档位上限优先于核心数
    expect(resolvePoolSize(undefined, 8, 2)).toBe(2);   // battery
    expect(resolvePoolSize(undefined, 64, 8)).toBe(8);  // performance
    expect(resolvePoolSize('0', 8, 8)).toBe(0);      // 显式关闭仍优先于档位
  });
});

describe('QueryPool', () => {
  it('dispatches a call and returns the worker result', async () => {
    const pool = new QueryPool({ root: '/x', size: 1, createWorker: () => new FakeWorker((m) => ({ result: ok(`r:${m.toolName}`) })) });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.content[0].text).toBe('r:codegraph_explore');
    await pool.destroy();
  });

  it('runs N concurrent calls in parallel (not serialized)', async () => {
    let active = 0, maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Each call holds in-flight until the gate opens, so max concurrency across
    // the pool is observable: with size=5 and 5 calls, all 5 should run at once.
    const behavior = (m: CallMsg): Action => ({
      wait: (async () => {
        active++; maxActive = Math.max(maxActive, active);
        await gate;
        active--;
        return ok(`r${m.id}`);
      })(),
    });
    const pool = new QueryPool({ root: '/x', size: 5, createWorker: () => new FakeWorker(behavior) });
    const calls = Promise.all(Array.from({ length: 5 }, (_, i) => pool.run('codegraph_search', { i })));
    await sleep(40); // let all workers spawn (cold-start cap → a few generations) + dispatch
    expect(maxActive).toBe(5);
    release();
    const results = await calls;
    expect(results.every((r) => /^r\d+$/.test(r.content[0].text))).toBe(true);
    await pool.destroy();
  });

  it('does not spawn the whole pool for a single call (pending-aware growth)', async () => {
    let created = 0;
    const pool = new QueryPool({ root: '/x', size: 8, createWorker: () => { created++; return new FakeWorker((m) => ({ result: ok(`r${m.id}`) })); } });
    await pool.run('codegraph_node', { symbol: 's' });
    // One eager worker + at most the cold-start cap — never all 8.
    expect(created).toBeLessThanOrEqual(2);
    await pool.destroy();
  });

  it('recovers from a worker crash: retries the in-flight call and respawns', async () => {
    let calls = 0;
    const pool = new QueryPool({
      root: '/x', size: 2, maxRetries: 1,
      // First dispatch crashes its worker; the retry (on a respawn/other worker) succeeds.
      createWorker: () => new FakeWorker((m) => (++calls === 1 ? { crash: true } : { result: ok(`recovered:${m.id}`) })),
    });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('recovered:1');
    await sleep(10);
    // The pool grows lazily, so one call keeps one worker — but the crash must
    // have been replaced (not dropped to zero) and the pool stays healthy and
    // keeps serving.
    expect(pool.liveWorkers).toBeGreaterThanOrEqual(1);
    expect(pool.healthy).toBe(true);
    const again = await pool.run('codegraph_node', { symbol: 's' });
    expect(again.isError).toBeFalsy();
    await pool.destroy();
  });

  it('fails a poison call gracefully without wedging the pool', async () => {
    // This specific call always crashes its worker; a normal call still works.
    const poison = (m: CallMsg) => m.toolName === 'codegraph_explore';
    const pool = new QueryPool({
      root: '/x', size: 3, maxRetries: 1,
      createWorker: () => new FakeWorker((m) => (poison(m) ? { crash: true } : { result: ok(`ok:${m.id}`) })),
    });
    const bad = await pool.run('codegraph_explore', { query: 'boom' });
    expect(bad.isError).toBe(true); // graceful, after retries
    const good = await pool.run('codegraph_search', { query: 'fine' });
    expect(good.isError).toBeFalsy();
    expect(good.content[0].text).toMatch(/^ok:/);
    await pool.destroy();
  });

  it('graceful backstop: a call that can\'t be served in time gets success-shaped busy guidance', async () => {
    // 1 worker, every call hangs; soft-timeout small → the caller gets guidance,
    // never a hard error, never a hang.
    const pool = new QueryPool({ root: '/x', size: 1, softTimeoutMs: 60, createWorker: () => new FakeWorker(() => ({ hang: true })) });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.isError).toBeFalsy();            // NOT an error (abandonment rule)
    expect(res.content[0].text).toMatch(/busy|retry/i);
    await pool.destroy();
  });

  it('destroy settles outstanding calls instead of hanging', async () => {
    const pool = new QueryPool({ root: '/x', size: 1, softTimeoutMs: 10_000, createWorker: () => new FakeWorker(() => ({ hang: true })) });
    const pending = pool.run('codegraph_explore', { query: 'q' });
    await sleep(5);
    await pool.destroy();
    const res = await pending; // must resolve, not hang
    expect(res.isError).toBe(true);
    expect(pool.healthy).toBe(false);
  });

  it('is not `ready` until a worker completes its cold start (#662 first-call stall)', async () => {
    // A worker cold start is seconds (tens under load); a call queued behind it
    // waits for the 45s busy backstop with nothing served. The ToolHandler must
    // be able to see "no warm worker yet" and dispatch in-process instead — so
    // `ready` is false before the first 'ready' handshake and true after.
    // (FakeWorker posts 'ready' on a macrotask — the synchronous check below
    // observes the cold-start window.)
    const pool = new QueryPool({ root: '/x', size: 1, createWorker: () => new FakeWorker((m) => ({ result: ok(`r:${m.toolName}`) })) });
    expect(pool.ready).toBe(false); // eager worker spawned but not yet warm
    await sleep(5);                 // let the ready handshake land
    expect(pool.ready).toBe(true);
    const res = await pool.run('codegraph_status', {});
    expect(res.content[0].text).toBe('r:codegraph_status');
    await pool.destroy();
    expect(pool.ready).toBe(false); // destroyed pool must not be selected
  });

  it('a failed cold start (ready ok:false) does not mark the pool ready', async () => {
    const pool = new QueryPool({ root: '/x', size: 1, createWorker: () => new FakeWorker(() => ({ hang: true }), /* readyOk */ false) });
    await sleep(5);
    expect(pool.ready).toBe(false); // hard open failure — keep serving in-process
    await pool.destroy();
  });
});

/**
 * 阶段一：空闲自动缩容（开发计划 §5 验收标准）。
 * —— 8 个并发只读调用完成后，balanced 档位应在空闲窗口后缩回 1 个；
 * —— 缩容不丢请求、不关闭活跃 worker。
 */
describe('QueryPool idle shrink', () => {
  it('warms the configured initial worker count (performance 档位预热 2 个)', async () => {
    let created = 0;
    const pool = new QueryPool({
      root: '/x', size: 4, initialSize: 2,
      createWorker: () => { created++; return new FakeWorker(() => ({ hang: true })); },
    });
    expect(created).toBe(2);
    expect(pool.liveWorkers).toBe(2);
    await pool.destroy();
  });

  it('shrinks idle workers back to the floor after a burst drains', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const behavior = (m: CallMsg): Action => ({
      wait: (async () => { await gate; return ok(`r${m.id}`); })(),
    });
    const pool = new QueryPool({
      root: '/x', size: 4, minSize: 1, idleShrinkMs: 25,
      createWorker: () => new FakeWorker(behavior),
    });
    const calls = Promise.all(Array.from({ length: 4 }, (_, i) => pool.run('codegraph_explore', { i })));
    await sleep(30);
    expect(pool.liveWorkers).toBe(4); // burst grown to the profile cap
    release();
    const results = await calls;
    expect(results.every((r) => !r.isError)).toBe(true);
    await sleep(80); // 空闲窗口 + 终止
    expect(pool.liveWorkers).toBe(1);
    expect(pool.floorSize).toBe(1);
    await pool.destroy();
  });

  it('never terminates an in-flight worker, and the in-flight call still resolves', async () => {
    let releaseSlow!: (r: ToolResult) => void;
    const slow = new Promise<ToolResult>((r) => { releaseSlow = r; });
    let seen = 0;
    const pool = new QueryPool({
      root: '/x', size: 3, minSize: 1, idleShrinkMs: 20,
      createWorker: () => new FakeWorker((m) => {
        seen++;
        // 第 1 个调用一直挂在 worker 里，其余立即返回。
        return m.id === 1 ? { wait: slow } : { result: ok(`fast:${m.id}`) };
      }),
    });
    const hanging = pool.run('codegraph_explore', { id: 1 });
    const fast = [pool.run('codegraph_node', { id: 2 }), pool.run('codegraph_node', { id: 3 })];
    await Promise.all(fast);
    await sleep(60); // 空闲窗口过去，只有 idle worker 会被回收
    expect(pool.liveWorkers).toBe(1);
    expect(seen).toBe(3);
    releaseSlow(ok('slow-done'));
    const res = await hanging; // 缩容不能丢请求
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('slow-done');
    await pool.destroy();
  });

  it('does not shrink while calls are queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const pool = new QueryPool({
      root: '/x', size: 2, minSize: 1, idleShrinkMs: 15,
      createWorker: () => new FakeWorker((m) => ({ wait: (async () => { await gate; return ok(`r${m.id}`); })() })),
    });
    const calls = Promise.all(Array.from({ length: 2 }, (_, i) => pool.run('codegraph_explore', { i })));
    await sleep(40); // 缩容窗口已过，但两个 worker 都在途
    expect(pool.liveWorkers).toBe(2);
    release();
    await calls;
    await sleep(60);
    expect(pool.liveWorkers).toBe(1);
    await pool.destroy();
  });

  it('idleShrinkMs = 0 disables shrinking entirely', async () => {
    const pool = new QueryPool({
      root: '/x', size: 3, minSize: 1, idleShrinkMs: 0,
      createWorker: () => new FakeWorker((m) => ({ result: ok(`r${m.id}`) })),
    });
    await Promise.all([1, 2, 3].map((i) => pool.run('codegraph_node', { i })));
    await sleep(40);
    expect(pool.liveWorkers).toBe(3);
    await pool.destroy();
  });

  it('a new call after shrinking still works (fresh worker on demand)', async () => {
    const pool = new QueryPool({
      root: '/x', size: 2, minSize: 1, idleShrinkMs: 20,
      createWorker: () => new FakeWorker((m) => ({ result: ok(`r${m.id}`) })),
    });
    await Promise.all([1, 2].map((i) => pool.run('codegraph_node', { i })));
    await sleep(60);
    expect(pool.liveWorkers).toBe(1);
    const res = await pool.run('codegraph_explore', { query: 'after-shrink' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/^r\d+$/);
    await pool.destroy();
  });
});
