/**
 * 跨 daemon 的 LSP 文件租约注册表（`src/lsp/lease-registry.ts`）。
 *
 * 每个用例使用 `fs.mkdtempSync` 临时目录，通过 `CODEGRAPH_LSP_LEASE_DIR` 注入，
 * 结束后恢复环境变量并清理目录，绝不碰真实的 `~/.codegraph/lsp-leases`。
 *
 * 覆盖：写入/读回（含文件权限与换行）、多个 (root, family) 计数与排序、
 * pid 已死清理、心跳过期清理、release/releaseAll、损坏 JSON 自愈。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LSP_LEASE_STALE_MS,
  acquireLspLease,
  countLiveLspLeases,
  getLspLeaseDir,
  heartbeatLspLease,
  isProcessAlive,
  listLiveLspLeases,
  releaseAllLspLeases,
  releaseLspLease,
} from '../src/lsp/lease-registry';

let dir: string;
let previousDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lsp-lease-'));
  previousDir = process.env.CODEGRAPH_LSP_LEASE_DIR;
  process.env.CODEGRAPH_LSP_LEASE_DIR = dir;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.CODEGRAPH_LSP_LEASE_DIR;
  else process.env.CODEGRAPH_LSP_LEASE_DIR = previousDir;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 目录里的租约文件（不包含 `.tmp` 半成品）。 */
function leaseFiles(): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * 一个确定已经退出的 pid：起一个瞬时 node 子进程并等它结束。
 * 比写死一个「大概不存在」的数字可靠（PID 复用窗口只有几毫秒）。
 */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
  const pid = result.pid;
  if (typeof pid !== 'number' || pid <= 0) throw new Error('failed to spawn a short-lived process for a dead pid');
  return pid;
}

describe('LSP lease registry', () => {
  it('写入的租约可以读回，文件名含 root 哈希与 family，权限 0600 且以换行结尾', () => {
    const root = path.join(dir, 'project-one');
    const now = 1_700_000_000_000;
    const record = acquireLspLease({ root, family: 'typescript', pid: process.pid, now });

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      root: path.resolve(root),
      family: 'typescript',
      startedAt: now,
      updatedAt: now,
      activeQueries: 0,
    });

    const files = leaseFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}-typescript\.json$/);

    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, family: 'typescript' });
    // Windows 上 chmod 只映射只读位，POSIX 位无意义，因此只在类 Unix 平台断言。
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    }

    const live = listLiveLspLeases(now);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ root: path.resolve(root), family: 'typescript' });
  });

  it('多个 (root, family) 各自一条记录，按 startedAt 升序返回', () => {
    const base = 1_700_000_000_000;
    acquireLspLease({ root: 'C:/proj/alpha', family: 'typescript', pid: process.pid, now: base + 300 });
    acquireLspLease({ root: 'C:/proj/alpha', family: 'python', pid: process.pid, now: base + 100 });
    acquireLspLease({ root: 'C:/proj/beta', family: 'typescript', pid: process.pid, now: base + 200 });

    expect(leaseFiles()).toHaveLength(3);
    expect(countLiveLspLeases(base + 500)).toBe(3);

    const live = listLiveLspLeases(base + 500);
    expect(live.map((entry) => entry.startedAt)).toEqual([base + 100, base + 200, base + 300]);
    expect(live.map((entry) => `${entry.root}#${entry.family}`)).toEqual([
      `${path.resolve('C:/proj/alpha')}#python`,
      `${path.resolve('C:/proj/beta')}#typescript`,
      `${path.resolve('C:/proj/alpha')}#typescript`,
    ]);
  });

  it('pid 已死的记录被清理且不计入', () => {
    const pid = deadPid();
    expect(isProcessAlive(pid)).toBe(false);
    acquireLspLease({ root: path.join(dir, 'dead'), family: 'typescript', pid, now: Date.now() });
    acquireLspLease({ root: path.join(dir, 'alive'), family: 'typescript', pid: process.pid, now: Date.now() });
    expect(leaseFiles()).toHaveLength(2);

    const live = listLiveLspLeases(Date.now());
    expect(live).toHaveLength(1);
    expect(live[0]!.root).toBe(path.resolve(path.join(dir, 'alive')));
    // 死进程的记录文件已被自愈清理
    expect(leaseFiles()).toHaveLength(1);
  });

  it('心跳超过 60 秒的记录被视为陈旧并清理', () => {
    const now = Date.now();
    acquireLspLease({ root: path.join(dir, 'stale'), family: 'rust', pid: process.pid, now: now - LSP_LEASE_STALE_MS - 1_000 });
    acquireLspLease({ root: path.join(dir, 'fresh'), family: 'rust', pid: process.pid, now: now - 1_000 });

    expect(listLiveLspLeases(now)).toHaveLength(1);
    expect(leaseFiles()).toHaveLength(1);
    expect(countLiveLspLeases(now)).toBe(1);
  });

  it('心跳刷新 updatedAt/activeQueries 后记录仍然 live', () => {
    const now = Date.now();
    const root = path.join(dir, 'heartbeat');
    acquireLspLease({ root, family: 'go', pid: process.pid, now: now - LSP_LEASE_STALE_MS - 5_000 });
    expect(listLiveLspLeases(now)).toHaveLength(0); // 早已陈旧，自愈清理
    // 重新登记并心跳一次（模拟 server 还活着、心跳恢复）
    acquireLspLease({ root, family: 'go', pid: process.pid, now: now - 1_000 });
    expect(heartbeatLspLease(root, 'go', 3, now)).toBe(true);

    const live = listLiveLspLeases(now);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ root: path.resolve(root), family: 'go', activeQueries: 3, updatedAt: now });
  });

  it('releaseLspLease 删除单条，releaseAllLspLeases 只删除指定 pid 的记录', () => {
    const root = path.join(dir, 'release');
    acquireLspLease({ root, family: 'typescript', pid: process.pid, now: Date.now() });
    acquireLspLease({ root, family: 'python', pid: process.pid, now: Date.now() });
    acquireLspLease({ root, family: 'rust', pid: process.pid + 1, now: Date.now() });
    expect(leaseFiles()).toHaveLength(3);

    releaseLspLease(root, 'typescript');
    expect(leaseFiles()).toHaveLength(2);

    // 另一个 pid 的兜底清理不动本进程的记录
    expect(releaseAllLspLeases(process.pid + 1)).toBe(1);
    expect(leaseFiles()).toHaveLength(1);

    expect(releaseAllLspLeases(process.pid)).toBe(1);
    expect(leaseFiles()).toHaveLength(0);
    expect(countLiveLspLeases()).toBe(0);
  });

  it('按项目兜底清理时保留同一进程中其它项目的 live 租约', () => {
    const alpha = path.join(dir, 'alpha');
    const beta = path.join(dir, 'beta');
    acquireLspLease({ root: alpha, family: 'typescript', pid: process.pid, now: Date.now() });
    acquireLspLease({ root: alpha, family: 'python', pid: process.pid, now: Date.now() });
    acquireLspLease({ root: beta, family: 'go', pid: process.pid, now: Date.now() });

    expect(releaseAllLspLeases(process.pid, dir, alpha)).toBe(2);
    expect(listLiveLspLeases(Date.now())).toMatchObject([
      { root: path.resolve(beta), family: 'go', pid: process.pid },
    ]);
  });

  it('损坏的 JSON 文件不影响其它记录，并被自愈清理', () => {
    const root = path.join(dir, 'healthy');
    acquireLspLease({ root, family: 'typescript', pid: process.pid, now: Date.now() });
    const broken = path.join(dir, 'ffffffffffffffff-cpp.json');
    fs.writeFileSync(broken, '{ this is not json\n');
    fs.writeFileSync(path.join(dir, 'also-not-a-record.json'), JSON.stringify({ schemaVersion: 99, pid: 1 }));

    const live = listLiveLspLeases(Date.now());
    expect(live).toHaveLength(1);
    expect(live[0]!.root).toBe(path.resolve(root));
    expect(fs.existsSync(broken)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'also-not-a-record.json'))).toBe(false);
    expect(leaseFiles()).toHaveLength(1);
  });

  it('租约目录来自 CODEGRAPH_LSP_LEASE_DIR，未设置时回退到用户级目录', () => {
    expect(getLspLeaseDir({ CODEGRAPH_LSP_LEASE_DIR: 'C:/tmp/leases' })).toBe(path.resolve('C:/tmp/leases'));
    expect(getLspLeaseDir({})).toBe(path.join(os.homedir(), '.codegraph', 'lsp-leases'));
    expect(getLspLeaseDir({ CODEGRAPH_LSP_LEASE_DIR: '   ' })).toBe(path.join(os.homedir(), '.codegraph', 'lsp-leases'));
  });
});
