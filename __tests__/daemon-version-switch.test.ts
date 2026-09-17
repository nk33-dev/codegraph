/**
 * 升级后的 daemon 版本切换（个人版）。
 *
 * 真实报告：安装 personal.4 后旧的 personal.3 daemon 仍在运行，第一条编辑预览失败；
 * 只有手工 `codegraph daemon` 停掉旧进程才恢复。契约：
 *   1. 锁文件里的进程无法证明是本项目 daemon 时，绝不发信号（返回 unverified）；
 *   2. CLI 发现版本不一致时，不再按“未确认”拒绝写操作——那条路径可证明 tools/call
 *      从未送达，因此可以安全地在本进程执行，同时把旧进程换成当前版本。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { getDaemonPidPath, getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import { retireStaleDaemon } from '../src/mcp/daemon-registry';

const restartMock = vi.hoisted(() => ({ restartSharedDaemon: vi.fn() }));
vi.mock('../src/mcp/daemon-spawn', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/mcp/daemon-spawn')>(),
  restartSharedDaemon: restartMock.restartSharedDaemon,
}));

const { callViaSharedDaemonAtMostOnce, callViaSharedDaemon } = await import('../src/mcp/daemon-client');

let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

function writeLock(pid: number, version: string, socketPath: string): void {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(
    getDaemonPidPath(root),
    JSON.stringify({ pid, version, socketPath, startedAt: Date.now() }),
  );
}

/** 一个只会回答 hello 的假 daemon：用来构造“有 daemon，但版本不同”。 */
async function startHelloServer(socketPath: string, hello: Record<string, unknown>): Promise<void> {
  const server = net.createServer((sock) => {
    sock.write(JSON.stringify(hello) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-switch-')));
  restartMock.restartSharedDaemon.mockReset();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* Windows handles */ }
});

describe('retireStaleDaemon', () => {
  it('says there is nothing to retire without a lockfile', async () => {
    expect(await retireStaleDaemon(root)).toMatchObject({ outcome: 'no-daemon', pid: null });
  });

  it('refuses to signal a pid it cannot prove is this project\'s daemon', async () => {
    // 记录本进程的 pid：任何一次误判都会直接杀掉测试进程，所以这里同时证明了“没有发信号”。
    writeLock(process.pid, '0.0.0-old', getDaemonSocketCandidates(root)[0]!);

    const result = await retireStaleDaemon(root);

    expect(result).toMatchObject({ outcome: 'unverified', pid: process.pid, version: '0.0.0-old' });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  }, 20_000);
});

describe('shared daemon version mismatch', () => {
  it('reports the mismatch instead of "unconfirmed" and switches the daemon', async () => {
    const socketPath = getDaemonSocketCandidates(root)[0]!;
    await startHelloServer(socketPath, { codegraph: '0.0.0-old', pid: process.pid, socketPath, protocol: 1 });
    writeLock(process.pid, '0.0.0-old', socketPath);
    const replacementSocket = new net.Socket();
    cleanups.push(() => { replacementSocket.destroy(); });
    restartMock.restartSharedDaemon.mockResolvedValue({
      outcome: 'switched', previousPid: process.pid, previousVersion: '0.0.0-old', pid: 4242, socket: replacementSocket,
    });

    const result = await callViaSharedDaemonAtMostOnce(root, 'codegraph_edit', { operation: 'rename' });

    expect(result).toMatchObject({
      state: 'version-mismatch', daemonPid: process.pid, daemonVersion: '0.0.0-old', switched: true,
    });
    expect(restartMock.restartSharedDaemon).toHaveBeenCalledTimes(1);
    expect(replacementSocket.destroyed).toBe(true);
  }, 30_000);

  it('keeps reporting the mismatch when the daemon could not be replaced', async () => {
    const socketPath = getDaemonSocketCandidates(root)[0]!;
    await startHelloServer(socketPath, { codegraph: '0.0.0-old', pid: process.pid, socketPath, protocol: 1 });
    writeLock(process.pid, '0.0.0-old', socketPath);
    restartMock.restartSharedDaemon.mockResolvedValue({
      outcome: 'unverified', previousPid: process.pid, previousVersion: '0.0.0-old', pid: null, socket: null,
    });

    await expect(callViaSharedDaemonAtMostOnce(root, 'codegraph_edit', { operation: 'rename' }))
      .resolves.toMatchObject({ state: 'version-mismatch', switched: false });
  }, 30_000);

  it('a read call falls back to null when the stale daemon is not replaced', async () => {
    const socketPath = getDaemonSocketCandidates(root)[0]!;
    await startHelloServer(socketPath, { codegraph: '0.0.0-old', pid: process.pid, socketPath, protocol: 1 });
    writeLock(process.pid, '0.0.0-old', socketPath);
    restartMock.restartSharedDaemon.mockResolvedValue({
      outcome: 'unavailable', previousPid: process.pid, previousVersion: '0.0.0-old', pid: null, socket: null,
    });

    await expect(callViaSharedDaemon(root, 'codegraph_explore', { query: 'x', mode: 'definitions' }))
      .resolves.toBeNull();
  }, 30_000);
});
