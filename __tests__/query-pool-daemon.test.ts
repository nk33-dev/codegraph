/**
 * 阶段一验收（集成）：daemon 查询池在并发突发后自动缩容。
 *
 * 单元测试用注入的假 worker 锁定了扩缩容状态机；这里用**真实构建产物 + 真实
 * worker 线程 + 真实 socket** 走一遍开发计划 §5 的验收标准：
 *   - 8 个并发只读调用全部成功返回（缩容不丢请求）；
 *   - 空闲窗口过后缩回档位最小值 1；
 *   - 缩容后再来一次调用仍然成功（新 worker 自己开 WAL 读连接）；
 *   - 整个过程不启动语言服务器（Graph 查询不需要 LSP）。
 *
 * 断言读的是 daemon 自己写入的 `.codegraph/resource-metrics.json`，不猜测内部状态。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stopProcess } from './process-cleanup';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/** 缩容窗口：档位 balanced 是 120 秒，这里压到 3 秒让集成测试能在秒级观察。 */
const SHRINK_MS = 3_000;
const POOL_MAX = 4;

interface Server {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function spawnServer(cwd: string, env: NodeJS.ProcessEnv): Server {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { CODEGRAPH_MCP_LOG_ATTACH: '1', ...process.env, ...env },
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => { /* ignore */ });
  child.stdin.on('error', () => { /* ignore */ });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let outBuf = '';
  let errBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    outBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = outBuf.indexOf('\n')) !== -1) { stdout.push(outBuf.slice(0, idx)); outBuf = outBuf.slice(idx + 1); }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = errBuf.indexOf('\n')) !== -1) { stderr.push(errBuf.slice(0, idx)); errBuf = errBuf.slice(idx + 1); }
  });
  return { child, stdout, stderr };
}

function send(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child may be gone */ }
}

function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs: number, label: string, pollMs = 100): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value: T | undefined | null | false;
      try { value = predicate(); } catch (err) { return reject(err); }
      if (value) return resolve(value as T);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function readMetrics(root: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'resource-metrics.json'), 'utf8'));
  } catch { return null; }
}

function readLockPid(root: string): number | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8'));
    return typeof info.pid === 'number' ? info.pid : null;
  } catch { return null; }
}

/** daemon 是 detached 进程，它自己的 stderr 写在 `.codegraph/daemon.log`。 */
function readDaemonLog(root: string): string {
  try { return fs.readFileSync(path.join(root, '.codegraph', 'daemon.log'), 'utf8'); }
  catch { return ''; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('查询池在真实 daemon 中的扩容与自动缩容（阶段一）', () => {
  let tempDir: string;
  let realRoot: string;
  let server: Server | null = null;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pool-shrink-'));
    // 足够多的小文件，让 8 个并发查询有真实工作可做。
    for (let i = 0; i < 24; i++) {
      fs.writeFileSync(
        path.join(tempDir, `mod${i}.ts`),
        `export function fn${i}(x: number): number { return x + ${i}; }\n` +
        `export function caller${i}(): number { return fn${i}(${i}); }\n`
      );
    }
    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll();
    cg.close();
    realRoot = fs.realpathSync(tempDir);
  });

  afterEach(async () => {
    if (server) await stopProcess(server.child);
    server = null;
    const daemonPid = readLockPid(realRoot);
    if (daemonPid && daemonPid !== process.pid && isAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* race */ }
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it(
    '8 个并发调用全部成功，随后缩回 1 个 worker，且没有启动 LSP',
    async () => {
      server = spawnServer(tempDir, {
        CODEGRAPH_QUERY_POOL_SIZE: String(POOL_MAX),
        CODEGRAPH_QUERY_IDLE_SHRINK_MS: String(SHRINK_MS),
        CODEGRAPH_RESOURCE_PROFILE: 'balanced',
        CODEGRAPH_LSP_DISABLED: 'typescript,javascript',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '60000',
      });
      const child = server.child;
      send(child, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, rootUri: `file://${tempDir}` },
      });
      await waitFor(() => findResponse(server!.stdout, 1), 15_000, 'initialize response');

      // 池按档位/覆盖值建立，快照里能看到上限。
      const initial = await waitFor(() => {
        const snap = readMetrics(realRoot);
        return snap && snap.query?.poolMax === POOL_MAX ? snap : null;
      }, 20_000, `first metrics snapshot with poolMax=${POOL_MAX}`);
      expect(initial.profile).toBe('balanced');

      // 启动日志如实说明生效的 worker 区间。daemon 是 detach 的进程，它自己的
      // stderr 落在 `.codegraph/daemon.log`（代理进程的 stderr 里没有这行）。
      await waitFor(
        () => readDaemonLog(realRoot).split('\n').some((l) => l.includes('Query pool') && l.includes(`1..${POOL_MAX}`)),
        15_000,
        'pool startup log line in daemon.log',
      );

      // 8 个并发只读调用（每个 id 唯一），全部要拿到成功结果。
      const callIds = Array.from({ length: 8 }, (_, i) => 100 + i);
      for (const [i, id] of callIds.entries()) {
        send(child, {
          jsonrpc: '2.0', id, method: 'tools/call',
          params: { name: 'codegraph_node', arguments: { symbol: `fn${i}`, projectPath: tempDir } },
        });
      }
      for (const id of callIds) {
        const resp = await waitFor(() => findResponse(server!.stdout, id), 60_000, `tools/call response ${id}`);
        expect(resp.error, `调用 ${id} 不应返回 JSON-RPC 错误`).toBeUndefined();
        expect(resp.result?.isError).toBeFalsy();
      }

      // 空闲窗口过后，daemon 自己把快照写成 liveWorkers=1（不丢请求、不关活跃 worker）。
      // 必须先等到「爆发已被记录」的快照，否则会命中启动时那份 started=0、
      // liveWorkers=1 的初始快照，等于什么都没等到。
      const burst = await waitFor(() => {
        const snap = readMetrics(realRoot);
        return snap && snap.query?.started >= 8 ? snap : null;
      }, 40_000, 'metrics snapshot recording the 8 concurrent calls');
      expect(burst.query.poolMax).toBe(POOL_MAX);

      const shrunk = await waitFor(() => {
        const snap = readMetrics(realRoot);
        return snap && snap.query?.started >= 8 && snap.query?.liveWorkers === 1 ? snap : null;
      }, 60_000, `metrics snapshot reporting liveWorkers=1 after the ${SHRINK_MS}ms idle window`);
      expect(shrunk.query.queueDepth).toBe(0);
      expect(shrunk.lsp.starts).toBe(0);
      expect(shrunk.lsp.liveServers).toBe(0);

      // 缩容之后再查一次：新 worker 打开自己的 WAL 读连接并正常返回。
      send(child, {
        jsonrpc: '2.0', id: 200, method: 'tools/call',
        params: { name: 'codegraph_node', arguments: { symbol: 'fn7', projectPath: tempDir } },
      });
      const afterShrink = await waitFor(() => findResponse(server!.stdout, 200), 60_000, 'post-shrink tools/call response');
      expect(afterShrink.result?.isError).toBeFalsy();
      expect(JSON.stringify(afterShrink.result)).toContain('fn7');
    },
    180_000,
  );
});
