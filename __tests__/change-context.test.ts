import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { analyzeChangeContext } from '../src/graph/change-context';
import { ToolHandler, type ExploreStructuredContent } from '../src/mcp/tools';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function write(root: string, filePath: string, content: string): void {
  const absolute = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

describe('阶段四改动上下文', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-change-context-'));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'CodeGraph Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    write(root, 'src/service.ts', [
      'export function oldTarget(): number { return 1; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return oldTarget(); }',
      '',
    ].join('\n'));
    write(root, 'src/entry.ts', [
      "import { calculate } from './service';",
      'export function runApp(): number { return calculate(); }',
      '',
    ].join('\n'));
    write(root, 'src/service.test.ts', [
      "import { calculate } from './service';",
      'export function verifiesService(): number { return calculate(); }',
      '',
    ].join('\n'));
    write(root, 'src/unrelated.ts', 'export function untouchedArea(): string { return "ok"; }\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    cg = await CodeGraph.init(root, { index: true });
  });

  afterEach(() => {
    try { cg?.destroy(); } catch { /* 测试清理 */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('组合改动符号、语义边、影响入口和关联测试', async () => {
    write(root, 'src/service.ts', [
      'export function newTarget(): number { return 3; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return newTarget(); }',
      '',
    ].join('\n'));
    await cg.sync();

    const context = await analyzeChangeContext(cg);
    expect(context).not.toBeNull();
    expect(context!.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'deleted', name: 'oldTarget' }),
      expect.objectContaining({ change: 'added', name: 'newTarget' }),
      expect.objectContaining({ change: 'modified', name: 'calculate' }),
    ]));
    expect(context!.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'deleted', kind: 'calls', target: 'oldTarget' }),
      expect.objectContaining({ change: 'added', kind: 'calls', target: 'newTarget' }),
    ]));
    expect(context!.affectedEntries.some((entry) => entry.name === 'runApp')).toBe(true);
    expect(context!.affectedTests.map((test) => test.filePath)).toContain('src/service.test.ts');
  });

  it('一次 explore 自动返回 review 上下文和稳定 structured content', async () => {
    write(root, 'src/service.ts', [
      'export function oldTarget(): number { return 2; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return oldTarget(); }',
      '',
    ].join('\n'));
    await cg.sync();

    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'review current changes',
    });
    const structured = result.structuredContent as ExploreStructuredContent;
    expect(result.content[0]!.text).toContain('**Change context**');
    expect(structured.changes).toMatchObject({ schemaVersion: 1, kind: 'change-context', baseRef: 'HEAD' });
    expect(structured.changes!.symbols.some((symbol) => symbol.name === 'oldTarget')).toBe(true);
  });

  it('普通且不重叠的 explore 不附加改动噪声', async () => {
    write(root, 'src/service.ts', [
      'export function oldTarget(): number { return 2; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return oldTarget(); }',
      '',
    ].join('\n'));
    await cg.sync();

    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'untouchedArea' });
    const structured = result.structuredContent as ExploreStructuredContent;
    expect(result.content[0]!.text).not.toContain('**Change context**');
    expect(structured.changes).toBeNull();
  });

  it('覆盖重命名、删除和未跟踪文件', async () => {
    fs.renameSync(path.join(root, 'src/entry.ts'), path.join(root, 'src/main.ts'));
    fs.rmSync(path.join(root, 'src/service.test.ts'));
    write(root, 'src/untracked.ts', 'export function pendingFeature(): boolean { return true; }\n');
    await cg.sync();

    const context = await analyzeChangeContext(cg);
    expect(context!.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'renamed', path: 'src/main.ts', previousPath: 'src/entry.ts' }),
      expect.objectContaining({ change: 'deleted', path: 'src/service.test.ts' }),
      expect.objectContaining({ change: 'added', path: 'src/untracked.ts' }),
    ]));
    expect(context!.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'modified', name: 'runApp', filePath: 'src/main.ts' }),
      expect.objectContaining({ change: 'deleted', name: 'verifiesService' }),
      expect.objectContaining({ change: 'added', name: 'pendingFeature' }),
    ]));
  });

  it('分支切换后按显式 baseRef 双向分析语义改动', async () => {
    git(root, 'switch', '-c', 'feature');
    write(root, 'src/service.ts', [
      'export function oldTarget(): number { return 9; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return oldTarget(); }',
      '',
    ].join('\n'));
    git(root, 'add', 'src/service.ts');
    git(root, 'commit', '-m', 'feature change');
    await cg.sync();

    const feature = await analyzeChangeContext(cg, { baseRef: 'main' });
    expect(feature!.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'modified', path: 'src/service.ts' }),
    ]));
    expect(feature!.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'modified', name: 'oldTarget' }),
    ]));

    git(root, 'switch', 'main');
    await cg.sync();
    const main = await analyzeChangeContext(cg, { baseRef: 'feature' });
    expect(main!.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'modified', path: 'src/service.ts' }),
    ]));
    expect(main!.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: 'modified', name: 'oldTarget' }),
    ]));
  });

  it('深度比较使用临时基准索引并在完成后清理', async () => {
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codegraph-change-baseline-')),
    );
    write(root, 'src/service.ts', [
      'export function oldTarget(): number { return 1; }',
      'export function stableTarget(): number { return 2; }',
      'export function calculate(): number { return stableTarget(); }',
      '',
    ].join('\n'));
    await cg.sync();

    const context = await analyzeChangeContext(cg, { deep: true });
    expect(context!.deep).toBe(true);
    expect(context!.edges.some((edge) => edge.evidence === 'resolved')).toBe(true);
    const after = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('codegraph-change-baseline-')),
    );
    expect(after).toEqual(before);
  }, 60_000);
});
