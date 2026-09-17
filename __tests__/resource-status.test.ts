/**
 * 资源状态契约（阶段一验收标准）：
 *   - `codegraph status` 显示 profile 与实际资源状态；
 *   - status 自身**不启动任何语言服务器**、也不启动 daemon。
 *
 * 库级用例直接调 `CodeGraph.resourceStatus()`；CLI 用例跑构建后的二进制，
 * 保证 JSON 字段名与文本输出对未来重构稳定。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { resetResourceMetrics } from '../src/resource-metrics';
import { IndexedProject } from './indexed-project';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runStatusJson(cwd: string, extraEnv: Record<string, string> = {}): Record<string, any> {
  const stdout = execFileSync(process.execPath, [BIN, 'status', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const line = stdout.trim().split('\n').filter(Boolean).pop()!;
  return JSON.parse(line);
}

function runStatusText(cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BIN, 'status'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

describe('CodeGraph.resourceStatus（库级）', () => {
  let tempDir: string;
  let projectIndex: IndexedProject | undefined;

  beforeEach(() => {
    resetResourceMetrics();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resource-status-'));
  });
  afterEach(async () => {
    await projectIndex?.close();
    projectIndex = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('报告生效档位，且不启动语言服务器', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    projectIndex = new IndexedProject(tempDir);
    const cg = projectIndex.graph;
    await projectIndex.index();

    const status = cg.resourceStatus();
    expect(status.profile.name).toBe('balanced');
    expect(status.profile.governanceEnabled).toBe(true);
    expect(status.description).toContain('profile=balanced');
    // 关键契约：resourceStatus 只读文件与内存，不启动 LSP。
    expect(cg.getLspManager().hasLiveServer()).toBe(false);
    expect(status.reported).toBeNull(); // 没有 daemon 写过快照
  });

  it('索引基线随全量与增量运行更新', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    projectIndex = new IndexedProject(tempDir);
    const cg = projectIndex.graph;
    await projectIndex.index();
    expect(cg.resourceStatus().process.index.fullRuns).toBe(1);

    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 2;\n');
    await projectIndex.sync();
    const idx = cg.resourceStatus().process.index;
    expect(idx.incrementalRuns).toBe(1);
    expect(idx.incrementalLastFiles).toBe(1);
  });

  it('读回 daemon 写入的快照（reported 字段）', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    projectIndex = new IndexedProject(tempDir);
    const cg = projectIndex.graph;
    await projectIndex.index();

    const { writeResourceMetricsSnapshot } = await import('../src/resource-metrics');
    expect(writeResourceMetricsSnapshot(tempDir, cg.resourceStatus().process)).toBe(true);
    expect(cg.resourceStatus().reported?.index.fullRuns).toBe(1);
  });

  it('清理正在索引的项目后可删除数据库，且不会污染下一个项目的指标', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    projectIndex = new IndexedProject(tempDir);
    let reachedParsing!: () => void;
    const parsing = new Promise<void>(resolve => { reachedParsing = resolve; });
    const indexing = projectIndex.index({
      onProgress: progress => { if (progress.phase === 'parsing') reachedParsing(); },
    });
    const cancelled = expect(indexing).rejects.toThrow('索引已取消');
    await parsing;
    await projectIndex.close();
    await cancelled;
    fs.rmSync(path.join(tempDir, '.codegraph'), { recursive: true });

    resetResourceMetrics();
    projectIndex = new IndexedProject(tempDir);
    await projectIndex.index();
    expect(projectIndex.graph.resourceStatus().process.index.fullRuns).toBe(1);
  });
});

describe('MCP codegraph_status 展示资源治理', () => {
  let tempDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  let projectIndex: IndexedProject | undefined;

  beforeEach(async () => {
    resetResourceMetrics();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-mcp-'));
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function alpha(): number { return 1; }\n');
    projectIndex = new IndexedProject(tempDir);
    cg = projectIndex.graph;
    await projectIndex.index();
    handler = new ToolHandler(cg);
  });
  afterEach(async () => {
    await projectIndex?.close();
    projectIndex = undefined;
    handler?.closeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('status 文本包含档位说明，且不因调用而启动 LSP', async () => {
    const res = await handler.execute('codegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('**Resources:**');
    expect(text).toContain('profile=balanced');
    // 直连模式没有查询池：不展示 worker 数字，也不编造一个。
    expect(text).not.toContain('**Query pool:**');
    expect(cg.getLspManager().hasLiveServer()).toBe(false);
  });
});

describe('codegraph status 展示资源治理', () => {
  let tempDir: string;
  let projectIndex: IndexedProject | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-res-'));
    // status 的内容段只在已初始化的项目上输出；先建一个小索引。
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    projectIndex = new IndexedProject(tempDir);
    await projectIndex.index();
    await projectIndex.close();
  });
  afterEach(async () => {
    await projectIndex?.close();
    projectIndex = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('status --json 带 resources 字段（profile、查询池上限、全局租约数）', () => {
    const out = runStatusJson(tempDir);
    expect(out.resources?.profile?.name).toBe('balanced');
    expect(out.resources.profile.lspGlobalMax).toBe(3);
    expect(typeof out.resources.queryPoolMax).toBe('number');
    expect(out.resources.queryPoolMax).toBeGreaterThan(0);
    expect(typeof out.resources.liveLspLeases).toBe('number');
    expect(out.resources.description).toContain('profile=balanced');
    expect(out.resources.reported).toBeNull(); // daemon 未运行 → 降级而不是报错
  });

  it('CODEGRAPH_RESOURCE_PROFILE=battery 时 status 报告 battery 预算', () => {
    const out = runStatusJson(tempDir, { CODEGRAPH_RESOURCE_PROFILE: 'battery' });
    expect(out.resources.profile.name).toBe('battery');
    expect(out.resources.profile.lspGlobalMax).toBe(2);
    expect(out.resources.profile.queryIdleShrinkMs).toBe(45_000);
  });

  it('文本输出包含 Resource Governance 段，并说明 status 不启动 LSP', () => {
    const text = runStatusText(tempDir);
    expect(text).toContain('Resource Governance:');
    expect(text).toContain('Profile:   balanced');
    // 没有 daemon 快照时必须诚实降级，而不是编造数字。
    expect(text).toMatch(/no metrics reported/);
  });
});
