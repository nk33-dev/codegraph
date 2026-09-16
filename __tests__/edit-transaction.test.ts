import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  __setEditTransactionDeviceForTests,
  __setEditTransactionFaultForTests,
  __setEditTransactionOperationFaultForTests,
} from '../src/edits/transaction';

const SOURCE = 'export function run() {\n  return 1;\n}\n';
const REPLACEMENT = 'export function run() { return 2; }';

let root: string;
let cg: CodeGraph;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edit-transaction-'));
  fs.writeFileSync(path.join(root, 'service.ts'), SOURCE);
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
});

afterEach(() => {
  __setEditTransactionFaultForTests(null);
  __setEditTransactionOperationFaultForTests(null);
  __setEditTransactionDeviceForTests(null);
  try { cg?.close(); } catch { /* 已关闭。 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('结构化编辑事务', () => {
  it('同一 operationId 重试只返回记录，不重复写入', async () => {
    const request = {
      operation: 'replace-body' as const,
      symbol: 'run',
      file: 'service.ts',
      content: REPLACEMENT,
    };
    const preview = await cg.editCode(request);
    const applied = await cg.editCode({
      ...request, apply: true, operationId: preview.operationId!, expectPreviewHash: preview.previewHash!,
    });
    const modifiedAt = fs.statSync(path.join(root, 'service.ts')).mtimeMs;
    const replayed = await cg.editCode({
      ...request, apply: true, operationId: preview.operationId!, expectPreviewHash: preview.previewHash!,
    });

    expect(applied).toMatchObject({
      status: 'applied', operationId: preview.operationId,
      applied: { replayed: false, transactionState: 'committed' },
    });
    expect(replayed).toMatchObject({
      status: 'applied', operationId: preview.operationId,
      applied: { replayed: true, transactionState: 'committed' },
    });
    expect(fs.statSync(path.join(root, 'service.ts')).mtimeMs).toBe(modifiedAt);
    const recordDir = path.join(root, '.codegraph', 'edit-transactions', preview.operationId!);
    expect(fs.existsSync(path.join(recordDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(recordDir, 'staged'))).toBe(false);
    expect(fs.existsSync(path.join(recordDir, 'backups'))).toBe(false);

    const wrongPreview = await cg.editCode({
      ...request, apply: true, operationId: preview.operationId!, expectPreviewHash: 'deadbeef',
    });
    expect(wrongPreview.status).toBe('conflict');
    expect(wrongPreview.warnings.join(' ')).toContain('recorded preview');

    const conflict = await cg.editCode({
      ...request, content: 'export function run() { return 3; }', apply: true, operationId: preview.operationId!,
    });
    expect(conflict.status).toBe('conflict');
    expect(conflict.warnings.join(' ')).toContain('belongs to a different edit request');
  });

  it.each(['after-prepare', 'after-commit:0'])('下一次异步打开会恢复中断点 %s', async (point) => {
    __setEditTransactionFaultForTests((current) => {
      if (current === point) throw new Error(`interrupt ${point}`);
    });
    const result = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'service.ts', content: REPLACEMENT,
      apply: true, operationId: `interrupt-${point.replace(':', '-')}`,
    });
    expect(result.status).toBe('error');
    __setEditTransactionFaultForTests(null);
    cg.close();

    cg = await CodeGraph.open(root);
    expect(fs.readFileSync(path.join(root, 'service.ts'), 'utf-8')).toBe(SOURCE);

    const recorded = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'service.ts', content: REPLACEMENT,
      apply: true, operationId: `interrupt-${point.replace(':', '-')}`,
    });
    expect(recorded).toMatchObject({
      status: 'error',
      applied: { replayed: true, transactionState: 'rolled_back' },
    });
  });

  it('拒绝符号链接目标，不改写链接或真实文件', async (context) => {
    const real = path.join(root, 'real.ts');
    const linked = path.join(root, 'linked.ts');
    fs.writeFileSync(real, SOURCE);
    try {
      fs.symlinkSync(real, linked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }
    await cg.indexFiles(['linked.ts']);

    const result = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'linked.ts', content: REPLACEMENT, apply: true,
    });
    expect(result.status).toBe('rejected');
    expect(result.warnings.join(' ')).toContain('symbolic link');
    expect(fs.readFileSync(real, 'utf-8')).toBe(SOURCE);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it('提交前拒绝跨卷目标，不创建事务结果或改写源码', async () => {
    const mounted = path.join(root, 'mounted');
    fs.mkdirSync(mounted);
    fs.writeFileSync(path.join(mounted, 'service.ts'), SOURCE);
    await cg.indexFiles(['mounted/service.ts']);
    __setEditTransactionDeviceForTests((_target, device, label) => (
      label === 'mounted/service.ts' ? device + 1 : device
    ));

    const result = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'mounted/service.ts', content: REPLACEMENT, apply: true,
    });
    expect(result.status).toBe('rejected');
    expect(result.warnings.join(' ')).toContain('cross-volume structured edits are refused');
    expect(fs.readFileSync(path.join(mounted, 'service.ts'), 'utf-8')).toBe(SOURCE);
  });

  it('活跃事务锁不阻塞只读同步打开，异步打开也不误判为崩溃', async () => {
    const transactions = path.join(root, '.codegraph', 'edit-transactions');
    const lock = path.join(root, '.codegraph', 'edit-transactions.lock');
    fs.mkdirSync(transactions, { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    cg.close();

    const sync = CodeGraph.openSync(root);
    sync.close();
    const asyncGraph = await CodeGraph.open(root);
    asyncGraph.close();
    fs.rmSync(lock, { force: true });
    cg = CodeGraph.openSync(root);
  });

  it('启动恢复清理 manifest 落盘前遗留的孤立暂存目录', async () => {
    const orphan = path.join(root, '.codegraph', 'edit-transactions', 'orphan-before-manifest');
    fs.mkdirSync(path.join(orphan, 'staged'), { recursive: true });
    fs.writeFileSync(path.join(orphan, 'staged', '0.new'), 'temporary');
    cg.close();

    cg = await CodeGraph.open(root);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'service.ts'), 'utf-8')).toBe(SOURCE);
  });
});
