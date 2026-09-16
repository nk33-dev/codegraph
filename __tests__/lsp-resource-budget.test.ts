/**
 * LSP 资源治理（阶段一）：每项目软上限 + 跨 daemon 全局预算租约。
 *
 * 全部走真实的子进程路径（`__tests__/fixtures/fake-lsp-server.js`），因为
 * 「启动前驱逐」「有活跃请求不回收」这两条正好发生在子进程生命周期里，
 * mock 掉子进程就验证不了。租约目录用 `CODEGRAPH_LSP_LEASE_DIR` 指向临时目录，
 * 不污染真实的 `~/.codegraph/lsp-leases`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspManager, liveLspChildCount } from '../src/lsp/manager';
import { resourceMetrics } from '../src/resource-metrics';
import { resolveResourceProfile, type ResourceProfileSettings } from '../src/resource-profile';
import {
  LSP_LEASE_STALE_MS,
  acquireLspLease,
  countLiveLspLeases,
  heartbeatLspLease,
  listLiveLspLeases,
} from '../src/lsp/lease-registry';
import { FAKE_SERVER, createFakeProject, waitFor, type FakeProject } from './lsp-test-utils';

const TS_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';
const PY_CONTENT = 'def helper():\n    return 1\n';

const managers: LspManager[] = [];
const projects: FakeProject[] = [];
let leaseDir: string;
let previousLeaseDir: string | undefined;
const envBackup = new Map<string, string | undefined>();

/** 以 balanced 档位为底，覆盖单个字段；governanceEnabled 保持解析结果。 */
function profileWith(overrides: Partial<ResourceProfileSettings>): ResourceProfileSettings {
  return { ...resolveResourceProfile({}), ...overrides };
}

/**
 * 一个同时配置了 typescript 与 python 两个语言家族的假项目：
 * 两个家族各自会启动一个真实子进程，但都指向同一个 fake server 与日志。
 */
function makeTwoFamilyProject(options: Parameters<typeof createFakeProject>[1] = {}): FakeProject {
  const project = createFakeProject({ 'a.ts': TS_CONTENT, 'b.py': PY_CONTENT }, options);
  // 第二个家族也指向 fake server（保持 log path，便于断言 initialize 次数）。
  project.writeConfig({
    serverArgs: options.serverArgs,
    server: options.server,
    config: {
      ...(options.config ?? {}),
      servers: {
        python: { command: process.execPath, args: [FAKE_SERVER, '--log', project.logPath, ...(options.serverArgs ?? [])] },
      },
    },
  });
  projects.push(project);
  return project;
}

function makeManager(project: FakeProject, profile: ResourceProfileSettings): LspManager {
  const manager = new LspManager(project.root, { idleSweep: false, profile, leaseDir });
  managers.push(manager);
  return manager;
}

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function stateOf(manager: LspManager, family: 'typescript' | 'python'): string {
  return manager.status().find((entry) => entry.family === family)!.state;
}

const tsFile = (project: FakeProject): string => path.join(project.root, 'a.ts');
const pyFile = (project: FakeProject): string => path.join(project.root, 'b.py');

beforeEach(() => {
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lsp-lease-budget-'));
  previousLeaseDir = process.env.CODEGRAPH_LSP_LEASE_DIR;
  process.env.CODEGRAPH_LSP_LEASE_DIR = leaseDir;
  envBackup.clear();
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  for (const project of projects.splice(0)) project.cleanup();
  await waitFor(() => liveLspChildCount() === 0, 5000);

  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  if (previousLeaseDir === undefined) delete process.env.CODEGRAPH_LSP_LEASE_DIR;
  else process.env.CODEGRAPH_LSP_LEASE_DIR = previousLeaseDir;
  fs.rmSync(leaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('LSP 每项目软上限', () => {
  it('软上限为 1 时，启动第二个家族前关闭最久未使用的空闲 server，查询不被阻塞', async () => {
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 1, lspGlobalMax: 8 }));

    const first = await manager.documentSymbols(tsFile(project), 'typescript');
    expect(first.items.length).toBeGreaterThan(0);
    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(liveLspChildCount()).toBe(1);

    const second = await manager.documentSymbols(pyFile(project), 'python');
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.map((item) => item.name)).toContain('Widget'); // fake server 对任何家族回答同一批符号

    // 第一个空闲 server 已被软上限回收，第二个正常服务
    expect(stateOf(manager, 'typescript')).toBe('stopped');
    expect(stateOf(manager, 'python')).toBe('ready');
    expect(liveLspChildCount()).toBe(1);
    expect(project.events('initialize')).toHaveLength(2);
  }, 30_000);

  it('没有可关闭的空闲 server 时允许临时超出软上限，不阻塞查询', async () => {
    const project = makeTwoFamilyProject({ serverArgs: ['--slow-definition', '1200'], config: { requestTimeoutMs: 20_000 } });
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 1, lspGlobalMax: 8 }));

    // 让 typescript 处于「有活跃请求」状态：请求已到达 server，但响应要 1.2 秒
    const pending = manager.definition(tsFile(project), { line: 0, character: 13 }, 'typescript');
    await project.waitForLog((entries) => entries.some((entry) => entry.method === 'textDocument/definition'));

    const python = await manager.documentSymbols(pyFile(project), 'python');
    expect(python.items.length).toBeGreaterThan(0);

    // 软上限是软目标：busy 的 typescript 不被杀，两个 server 临时并存
    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(stateOf(manager, 'python')).toBe('ready');
    expect(liveLspChildCount()).toBe(2);

    expect((await pending).items.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('LSP 全局预算（跨 daemon 租约）', () => {
  it('全局 lease 超预算时，回收最旧租约命中的本 manager 空闲 server', async () => {
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 1 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(1);

    // 模拟另一个 daemon：同一 pid（本测试进程）但不同 root 的 live 租约。
    // startedAt 显式设为「比本 manager 更新」，所以最旧的 1 条租约仍是本 manager 的。
    const otherRoot = path.join(path.dirname(project.root), 'cg-other-daemon');
    acquireLspLease({ root: otherRoot, family: 'python', pid: process.pid, now: Date.now() + 5_000, dir: leaseDir });
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(2);

    const closed = await manager.sweepGlobalBudget();
    expect(closed).toEqual(['typescript']);
    expect(stateOf(manager, 'typescript')).toBe('stopped');
    expect(liveLspChildCount()).toBe(0);

    // 关闭后本 manager 的租约已释放，只剩「另一个 daemon」那条
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(1);
  }, 30_000);

  it('最旧的租约属于另一个 daemon 时，本 manager 不被回收（全局 LRU 反例）', async () => {
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 1 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    expect(stateOf(manager, 'typescript')).toBe('ready');

    // 另一个 daemon 的租约显式构造为「更旧但心跳新鲜」：
    // acquire 用旧时间戳写 startedAt，再用 heartbeat 把 updatedAt 刷成当前时间
    // （否则会被 60 秒陈旧窗口清掉，就不是「live 的最旧租约」了）。
    const otherRoot = path.join(path.dirname(project.root), 'cg-other-daemon-older');
    acquireLspLease({ root: otherRoot, family: 'python', pid: process.pid, now: Date.now() - 120_000, dir: leaseDir });
    expect(heartbeatLspLease(otherRoot, 'python', 0, Date.now(), leaseDir)).toBe(true);

    const leases = listLiveLspLeases(Date.now(), LSP_LEASE_STALE_MS, leaseDir);
    expect(leases).toHaveLength(2);
    expect(leases[0]!.root).toBe(path.resolve(otherRoot)); // 最旧的是另一个 daemon

    // excess = 1，最旧的 1 条不属于本 manager → 什么都不做，绝不关闭自己的 server 凑数
    expect(await manager.sweepGlobalBudget()).toEqual([]);
    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(2);
  }, 30_000);

  it('预算内不回收，且已有活跃请求的 server 绝不回收', async () => {
    const project = makeTwoFamilyProject({ serverArgs: ['--slow-definition', '1200'], config: { requestTimeoutMs: 20_000 } });
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 1 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    // 只有自己一条 lease → 预算内
    expect(await manager.sweepGlobalBudget()).toEqual([]);
    expect(stateOf(manager, 'typescript')).toBe('ready');

    // 制造超预算：再加一条别的 daemon 的 live 租约，显式设为比本 manager 更新，
    // 于是「最旧的 excess 条」正好是本 manager 正在忙的那条。
    acquireLspLease({ root: path.join(path.dirname(project.root), 'cg-other-daemon'), family: 'python', pid: process.pid, now: Date.now() + 5_000, dir: leaseDir });
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(2);

    // 此时 typescript 正在处理一个慢请求 → 不可回收
    const pending = manager.definition(tsFile(project), { line: 0, character: 13 }, 'typescript');
    await project.waitForLog((entries) => entries.some((entry) => entry.method === 'textDocument/definition'));

    expect(await manager.sweepGlobalBudget()).toEqual([]);
    expect(stateOf(manager, 'typescript')).toBe('ready');

    // 请求结束后重新变成可回收候选 → 协作回收生效
    expect((await pending).items.length).toBeGreaterThan(0);
    await manager.sweepGlobalBudget();
    await waitFor(() => stateOf(manager, 'typescript') === 'stopped');
    expect(stateOf(manager, 'typescript')).toBe('stopped');
  }, 30_000);
});

describe('LSP 租约心跳与资源指标', () => {
  it('心跳刷新租约 updatedAt/activeQueries，并写入本进程 LSP 指标（now 可注入）', async () => {
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 8 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    const fakeNow = Date.now() + 1_000;
    manager.heartbeatLeases(fakeNow);

    const leases = listLiveLspLeases(fakeNow, LSP_LEASE_STALE_MS, leaseDir);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      root: path.resolve(project.root),
      family: 'typescript',
      updatedAt: fakeNow,
      activeQueries: 0,
    });

    const gauges = resourceMetrics().snapshot().lsp;
    expect(gauges.liveServers).toBe(1);
    expect(gauges.globalLeases).toBe(1);
    expect(gauges.starts).toBeGreaterThan(0);
  }, 30_000);
});

describe('LSP 治理回退开关', () => {
  it('CODEGRAPH_LSP_GLOBAL_LEASE=0：不写租约、不读取租约、sweepGlobalBudget 为空', async () => {
    setEnv('CODEGRAPH_LSP_GLOBAL_LEASE', '0');
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 1 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(fs.readdirSync(leaseDir).filter((name) => name.endsWith('.json'))).toEqual([]);

    // 即使注册表里已经有超预算记录，关闭时也不读取、不回收
    acquireLspLease({ root: path.join(path.dirname(project.root), 'cg-other-daemon'), family: 'python', pid: process.pid, now: Date.now(), dir: leaseDir });
    expect(await manager.sweepGlobalBudget()).toEqual([]);
    expect(stateOf(manager, 'typescript')).toBe('ready');
  }, 30_000);

  it('CODEGRAPH_LSP_GLOBAL_LEASE=0：关闭后不清理本进程在注册表里的其它记录', async () => {
    const project = makeTwoFamilyProject();
    const otherRoot = path.join(path.dirname(project.root), 'cg-other-daemon');
    const record = acquireLspLease({ root: otherRoot, family: 'python', pid: process.pid, now: Date.now(), dir: leaseDir });
    expect(record).not.toBeNull();

    setEnv('CODEGRAPH_LSP_GLOBAL_LEASE', '0');
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 4, lspGlobalMax: 1 }));
    await manager.documentSymbols(tsFile(project), 'typescript');
    await manager.close();

    // 治理关闭时 shutdownAll 不做兜底清理：那条属于「别的 manager」的记录还在
    expect(fs.readdirSync(leaseDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(countLiveLspLeases(Date.now(), leaseDir)).toBe(1);
  }, 30_000);

  it('CODEGRAPH_RESOURCE_GOVERNANCE=0：软上限不驱逐，正常启动/关闭行为不变', async () => {
    setEnv('CODEGRAPH_RESOURCE_GOVERNANCE', '0');
    const project = makeTwoFamilyProject();
    const manager = makeManager(project, profileWith({ lspPerProjectSoftMax: 1, lspGlobalMax: 1 }));

    await manager.documentSymbols(tsFile(project), 'typescript');
    await manager.documentSymbols(pyFile(project), 'python');

    expect(stateOf(manager, 'typescript')).toBe('ready');
    expect(stateOf(manager, 'python')).toBe('ready');
    expect(liveLspChildCount()).toBe(2);
    expect(fs.readdirSync(leaseDir).filter((name) => name.endsWith('.json'))).toEqual([]);

    // 关闭仍然照常工作
    await manager.shutdownAll();
    expect(stateOf(manager, 'typescript')).toBe('stopped');
    expect(stateOf(manager, 'python')).toBe('stopped');
  }, 30_000);
});
