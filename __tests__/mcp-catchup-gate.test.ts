/**
 * MCP catch-up gate — first tool call blocks on the engine's post-open
 * filesystem reconcile so it never serves rows for files that were
 * deleted (or edited) while no MCP server was running.
 *
 * Background: `MCPEngine.catchUpSync()` fires `cg.sync()` in the background.
 * Before this fix it was fire-and-forget — a tool call could race past it
 * and return rows for files that no longer exist on disk. The per-file
 * staleness banner (`withStalenessNotice`) couldn't help, because
 * `getPendingFiles()` is populated by the watcher, not by catch-up.
 *
 * The fix: `catchUpSync()` pushes its promise into the `ToolHandler` via
 * `setCatchUpGate(p)`; the first `execute()` call awaits the gate and then
 * clears it. These tests exercise the gate directly (deterministic) and
 * the engine-driven path (proves the engine actually pokes the gate).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { resetResourceMetrics, resourceMetrics } from '../src/resource-metrics';
import { expectWithinBudget } from './perf-utils';

describe('MCP catch-up gate', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-catchup-gate-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'survivor.ts'),
      'export function survivor() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'deleted-later.ts'),
      'export function deletedLater() { return 2; }\n',
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    resetResourceMetrics();
  });

  afterEach(() => {
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    resetResourceMetrics();
  });

  it('awaits the gate before serving the first tool call', async () => {
    let gateResolved = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => { gateResolved = true; resolve(); }, 80);
    });
    handler.setCatchUpGate(gate);

    const res = await handler.execute('codegraph_search', { query: 'survivor' });
    expect(gateResolved).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/survivor/);
  });

  it('drops the gate after first await — second call does not re-wait', async () => {
    let awaitCount = 0;
    const gate = new Promise<void>((resolve) => {
      awaitCount++;
      setTimeout(resolve, 20);
    });
    handler.setCatchUpGate(gate);

    await handler.execute('codegraph_search', { query: 'survivor' });
    const before = awaitCount;
    await handler.execute('codegraph_search', { query: 'survivor' });
    // The promise body runs once when constructed; second execute never
    // resubscribes to a fresh promise because the gate field was nulled.
    expect(awaitCount).toBe(before);
  });

  it('catch-up reconciles a deleted file before the first tool call sees it', async () => {
    // Simulate the empty-project / deleted-files startup case: file is in
    // the DB (we indexed it above) but vanishes from disk before the MCP
    // server's first query. The catch-up sync, awaited via the gate,
    // must remove the row so the first tool call returns no hit.
    fs.unlinkSync(path.join(testDir, 'src', 'deleted-later.ts'));

    // Push the actual catch-up sync as the gate — same flow the MCP engine
    // uses (`cg.sync()` returns a Promise<SyncResult>, the wrapper voids it).
    handler.setCatchUpGate(cg.sync().then(() => undefined));

    const res = await handler.execute('codegraph_search', { query: 'deletedLater' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).not.toMatch(/src\/deleted-later\.ts/);
  });

  it('catch-up that converges the project to 0 files clears all rows', async () => {
    // Worst case: every source file is gone between sessions. Without the
    // gate, the first tool call serves whatever was in the DB. With the
    // gate + the orchestrator's filesystem reconcile, the DB drains.
    fs.unlinkSync(path.join(testDir, 'src', 'survivor.ts'));
    fs.unlinkSync(path.join(testDir, 'src', 'deleted-later.ts'));

    handler.setCatchUpGate(cg.sync().then(() => undefined));

    const res = await handler.execute('codegraph_search', { query: 'survivor' });
    expect(res.isError).toBeFalsy();
    expect(cg.getStats().fileCount).toBe(0);
  });

  it('does not hang the first call when catch-up runs past the timeout (#905)', async () => {
    // The issue #905 hang: on a huge repo the post-open reconcile takes minutes,
    // and gating the first tool call on all of it reads as a multi-minute hang.
    // With the time-box, the call is served promptly and the reconcile finishes
    // in the background.
    const prev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '50';
    let timer: NodeJS.Timeout | undefined;
    try {
      let gateResolved = false;
      const gate = new Promise<void>((resolve) => {
        timer = setTimeout(() => { gateResolved = true; resolve(); }, 5000);
      });
      handler.setCatchUpGate(gate);

      const started = Date.now();
      const res = await handler.execute('codegraph_search', { query: 'survivor' });
      const elapsed = Date.now() - started;

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toMatch(/survivor/);
      // Served on the timeout (~50ms), NOT after the 5s reconcile.
      expect(gateResolved).toBe(false);
      expectWithinBudget(elapsed, 2000, 'catch-up 门超时后首个工具调用立即返回（issue #905）');
    } finally {
      if (timer) clearTimeout(timer);
      if (prev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
      else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prev;
    }
  });

  it('CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 restores the unbounded wait', async () => {
    const prev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    try {
      let gateResolved = false;
      const gate = new Promise<void>((resolve) => {
        setTimeout(() => { gateResolved = true; resolve(); }, 80);
      });
      handler.setCatchUpGate(gate);

      const res = await handler.execute('codegraph_search', { query: 'survivor' });
      // With the time-box disabled, the call waits for the full reconcile.
      expect(gateResolved).toBe(true);
      expect(res.isError).toBeFalsy();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
      else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prev;
    }
  });

  it('gate that rejects does not break the tool call', async () => {
    // A catch-up sync failure (lock contention, transient FS error) must
    // not poison tool dispatch — the engine logs it, the handler proceeds.
    handler.setCatchUpGate(Promise.reject(new Error('simulated sync failure')));

    const res = await handler.execute('codegraph_search', { query: 'survivor' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/survivor/);
  });

  /**
   * P2 问题 10：首调用时延必须能拆成「等对账」与「检索」两段。
   *
   * 只断言语义（等待被单独记下、并且只记一次、明确区分 ready/timeout），
   * 不断言具体毫秒，避免在慢机器上变成 flaky；失败也必须与 ready 分开。
   */
  describe('时延分开记录（P2 问题 10）', () => {
    it('等到的门记为 ready，等待时长只算门内时间', async () => {
      let gateResolved = false;
      const gate = new Promise<void>((resolve) => {
        setTimeout(() => { gateResolved = true; resolve(); }, 60);
      });
      handler.setCatchUpGate(gate);

      await handler.execute('codegraph_search', { query: 'survivor' });

      expect(gateResolved).toBe(true);
      const snap = resourceMetrics().snapshot();
      expect(snap.catchUp.count).toBe(1);
      expect(snap.catchUp.ready).toBe(1);
      expect(snap.catchUp.timeout).toBe(0);
      expect(snap.catchUp.failed).toBe(0);
      expect(snap.catchUp.wait.lastMs).toBeGreaterThanOrEqual(50);
      // 检索耗时另记一条：两个序列各自都有样本，说明没有被合并成一个数字。
      expect(snap.query.run.count).toBe(1);
    });

    it('超时降级的门记为 timeout，且等待不超过超时上限', async () => {
      const prev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
      process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '50';
      let timer: NodeJS.Timeout | undefined;
      try {
        const gate = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        });
        handler.setCatchUpGate(gate);

        await handler.execute('codegraph_search', { query: 'survivor' });

        const catchUp = resourceMetrics().snapshot().catchUp;
        expect(catchUp.count).toBe(1);
        expect(catchUp.timeout).toBe(1);
        expect(catchUp.ready).toBe(0);
        expect(catchUp.failed).toBe(0);
        expect(catchUp.wait.lastMs).toBeLessThan(1000);
      } finally {
        if (timer) clearTimeout(timer);
        if (prev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
        else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prev;
      }
    });

    it('只有首个调用付门等待：第二个调用不再记一笔', async () => {
      handler.setCatchUpGate(new Promise<void>((resolve) => setTimeout(resolve, 20)));

      await handler.execute('codegraph_search', { query: 'survivor' });
      await handler.execute('codegraph_search', { query: 'survivor' });

      const snap = resourceMetrics().snapshot();
      expect(snap.catchUp.count).toBe(1);
      expect(snap.query.run.count).toBe(2);
    });

    it('对账失败单独记为 failed，不误报为 ready', async () => {
      handler.setCatchUpGate(Promise.reject(new Error('simulated sync failure')));

      const result = await handler.execute('codegraph_search', { query: 'survivor' });

      expect(result.isError).toBeFalsy();
      const catchUp = resourceMetrics().snapshot().catchUp;
      expect(catchUp.count).toBe(1);
      expect(catchUp.ready).toBe(0);
      expect(catchUp.timeout).toBe(0);
      expect(catchUp.failed).toBe(1);
    });

    it('CODEGRAPH_MCP_TIMINGS=1 时打出一行 catch-up 与检索耗时；默认不打', async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      const prev = process.env.CODEGRAPH_MCP_TIMINGS;
      try {
        handler.setCatchUpGate(new Promise<void>((resolve) => setTimeout(resolve, 30)));
        await handler.execute('codegraph_search', { query: 'survivor' });
        expect(lines.filter((l) => l.includes('[CodeGraph MCP timing]'))).toEqual([]);

        process.env.CODEGRAPH_MCP_TIMINGS = '1';
        await handler.execute('codegraph_search', { query: 'survivor' });

        const timing = lines.filter((l) => l.includes('[CodeGraph MCP timing]'));
        expect(timing).toHaveLength(1);
        expect(timing[0]).toMatch(/tool=codegraph_search catchUp=\d+ms\(none\) retrieval=\d+ms total=\d+ms chars=\d+/);
      } finally {
        spy.mockRestore();
        if (prev === undefined) delete process.env.CODEGRAPH_MCP_TIMINGS;
        else process.env.CODEGRAPH_MCP_TIMINGS = prev;
      }
    });

    it('首调用那一行的 catchUp 是实际结果而不是 none', async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      const prev = process.env.CODEGRAPH_MCP_TIMINGS;
      process.env.CODEGRAPH_MCP_TIMINGS = '1';
      try {
        handler.setCatchUpGate(new Promise<void>((resolve) => setTimeout(resolve, 20)));
        await handler.execute('codegraph_search', { query: 'survivor' });

        const line = lines.find((l) => l.includes('[CodeGraph MCP timing]'))!;
        expect(line).toMatch(/catchUp=\d+ms\((?:ready|timeout)\)/);
      } finally {
        spy.mockRestore();
        if (prev === undefined) delete process.env.CODEGRAPH_MCP_TIMINGS;
        else process.env.CODEGRAPH_MCP_TIMINGS = prev;
      }
    });
  });
});
