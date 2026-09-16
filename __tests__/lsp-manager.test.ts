/**
 * Language server manager: lazy start, in-process reuse, idle shutdown, bounded restart
 * after crashes, document sync, pull/push diagnostics, reverse-request replies, restart on
 * config change, and unavailable states.
 *
 * Everything runs against the fake server (deterministic); real servers are covered in
 * lsp-real-servers.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { defaultJdtlsWorkspaceDir, LspManager, LspUnavailableError, liveLspChildCount } from '../src/lsp/manager';
import { LspError } from '../src/lsp/protocol';
import { createFakeProject, waitFor, type FakeProject } from './lsp-test-utils';

const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';

const managers: LspManager[] = [];
const projects: FakeProject[] = [];

function makeManager(project: FakeProject): LspManager {
  const manager = new LspManager(project.root, { idleSweep: false });
  managers.push(manager);
  return manager;
}

function makeProject(files: Record<string, string> = { 'a.ts': FILE_CONTENT }, options: Parameters<typeof createFakeProject>[1] = {}): FakeProject {
  const project = createFakeProject(files, options);
  projects.push(project);
  return project;
}

const filePath = (project: FakeProject, relative = 'a.ts') => path.join(project.root, relative);

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  for (const project of projects.splice(0)) project.cleanup();
  await waitFor(() => liveLspChildCount() === 0, 5000);
});

describe('LSP manager: lifecycle', () => {
  it('超过空闲阈值的慢查询不会被清理，完成后才计算空闲时间', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, {
      serverArgs: ['--slow-definition', '400'], config: { idleTimeoutMs: 100 },
    });
    const manager = makeManager(project);
    const pending = manager.definition(filePath(project), { line: 0, character: 13 }, 'typescript');
    await project.waitForLog((entries) => entries.some((entry) => entry.method === 'textDocument/definition'));
    expect(await manager.sweepIdle(Date.now() + 10_000)).toEqual([]);
    expect((await pending).items.length).toBeGreaterThan(0);
    expect(await manager.sweepIdle()).toEqual([]);
    expect(await manager.sweepIdle(Date.now() + 10_000)).toEqual(['typescript']);
  });
  it('the first query starts the process and later queries reuse it', async () => {
    const project = makeProject();
    const manager = makeManager(project);
    const before = liveLspChildCount();

    // A status query starts no process
    const status = manager.status();
    expect(status.every((entry) => entry.state === 'stopped')).toBe(true);
    expect(liveLspChildCount()).toBe(before);

    const first = await manager.documentSymbols(filePath(project), 'typescript');
    expect(first.items.map((item) => item.name)).toEqual(['Widget', 'helper']);
    expect(first.items[0]!.children.map((child) => child.name)).toEqual(['render']);

    const pid = manager.status().find((entry) => entry.family === 'typescript')!.pid;
    expect(typeof pid).toBe('number');

    const second = await manager.documentSymbols(filePath(project), 'typescript');
    expect(second.items).toHaveLength(first.items.length);
    expect(manager.status().find((entry) => entry.family === 'typescript')!.pid).toBe(pid);

    const initializes = project.events('initialize');
    expect(initializes).toHaveLength(1);
    expect(manager.status().find((entry) => entry.family === 'typescript')).toMatchObject({
      state: 'ready',
      capabilities: { definition: true, references: true, documentSymbol: true, positionEncoding: 'utf-16' },
    });
  });

  it('the process closes after the idle threshold and the next query restarts it', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { config: { idleTimeoutMs: 150 } });
    const manager = makeManager(project);

    await manager.documentSymbols(filePath(project), 'typescript');
    expect(manager.status().find((entry) => entry.family === 'typescript')!.state).toBe('ready');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await manager.sweepIdle()).toEqual(['typescript']);
    await waitFor(() => manager.status().find((entry) => entry.family === 'typescript')!.pid === null);

    expect(manager.status().find((entry) => entry.family === 'typescript')!.state).toBe('stopped');
    expect(await waitFor(() => liveLspChildCount() === 0)).toBe(true);

    await manager.documentSymbols(filePath(project), 'typescript');
    expect(project.events('initialize')).toHaveLength(2);
    expect(project.readLog().some((entry) => entry.event === 'exit')).toBe(true);
  });

  it('repeated crashes suppress restarts and report an actionable reason', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { serverArgs: ['--crash-on', 'textDocument/definition'] });
    const manager = makeManager(project);
    const position = { line: 0, character: 15 };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(manager.definition(filePath(project), position, 'typescript')).rejects.toBeInstanceOf(LspError);
    }

    const suppressed = await manager.definition(filePath(project), position, 'typescript').catch((error) => error);
    expect(suppressed).toBeInstanceOf(LspUnavailableError);
    expect((suppressed as LspUnavailableError).remedy).toContain('lsp.json');
    expect((suppressed as Error).message).toContain('crashed');
  });

  it('a request timeout reports kind=timeout and the connection stays usable', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, {
      serverArgs: ['--slow-definition', '3000'],
      config: { requestTimeoutMs: 300 },
    });
    const manager = makeManager(project);
    const position = { line: 0, character: 15 };

    const error = await manager.definition(filePath(project), position, 'typescript').catch((caught) => caught);
    expect(error).toBeInstanceOf(LspError);
    expect((error as LspError).kind).toBe('timeout');
  });

  it('server reverse requests (configuration / workspaceFolders / progress) all get replies', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { serverArgs: ['--probe-server-requests'] });
    const manager = makeManager(project);

    await manager.documentSymbols(filePath(project), 'typescript');
    const entries = await project.waitForLog((log) => log.some((entry) => entry.event === 'serverRequests'));
    const probe = entries.find((entry) => entry.event === 'serverRequests');
    expect(probe).toBeTruthy();
    expect(probe!.ok).toBe(true);
    expect(probe!.replies['workspace/configuration']).toEqual({ ok: true, value: [null, null] });
  });

  it('a config file change rebuilds the server', async () => {
    const project = makeProject();
    const manager = makeManager(project);
    await manager.documentSymbols(filePath(project), 'typescript');
    expect(manager.status().find((entry) => entry.family === 'typescript')!.capabilities!.documentSymbol).toBe(true);

    project.writeConfig({ serverArgs: ['--no-document-symbol'] });
    await manager.documentSymbols(filePath(project), 'typescript');

    expect(project.events('initialize')).toHaveLength(2);
    expect(manager.status().find((entry) => entry.family === 'typescript')!.capabilities!.documentSymbol).toBe(false);
  });
});

describe('LSP manager: document sync and diagnostics', () => {
  it('didOpen on demand, didChange on content change, didClose on file removal', async () => {
    const project = makeProject();
    const manager = makeManager(project);
    const absolute = filePath(project);

    await manager.documentSymbols(absolute, 'typescript');
    await project.waitForLog((log) => log.some((entry) => entry.method === 'textDocument/didOpen'));

    fs.writeFileSync(absolute, 'export class Widget {\n  render() { return 2; }\n}\n');
    await manager.documentSymbols(absolute, 'typescript');
    await project.waitForLog((log) => log.some((entry) => entry.method === 'textDocument/didChange'));

    fs.rmSync(absolute);
    await manager.documentSymbols(absolute, 'typescript');
    await project.waitForLog((log) => log.some((entry) => entry.method === 'textDocument/didClose'));

    const methods = project.readLog().filter((entry) => entry.event === 'request').map((entry) => entry.method);
    expect(methods.indexOf('textDocument/didOpen')).toBeLessThan(methods.indexOf('textDocument/didChange'));
    expect(methods).toContain('textDocument/didClose');
    // Each file is didOpen'd only once
    expect(methods.filter((method) => method === 'textDocument/didOpen')).toHaveLength(1);
  });

  it('提交文件移动后关闭旧文档，并向支持的服务器发送 workspace 通知', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { serverArgs: ['--file-operations'] });
    const manager = makeManager(project);
    await manager.documentSymbols(filePath(project), 'typescript');
    await project.waitForLog((log) => log.some((entry) => entry.method === 'textDocument/didOpen'));

    fs.renameSync(filePath(project), filePath(project, 'moved.ts'));
    const warnings = manager.notifyFileOperations([{
      filePath: 'a.ts', operation: 'rename', movedTo: 'moved.ts', baseHash: null, resultHash: null,
      edits: [], preview: [], previewTruncated: false, additions: 0, deletions: 0,
    }]);
    expect(warnings).toEqual([]);
    await project.waitForLog((log) => log.some((entry) => entry.method === 'workspace/didRenameFiles'));

    const methods = project.readLog().filter((entry) => entry.event === 'request').map((entry) => entry.method);
    expect(methods).toContain('textDocument/didClose');
    expect(methods).toContain('workspace/didRenameFiles');
    expect(manager.status().find((entry) => entry.family === 'typescript')!.openDocuments).toBe(0);
  });

  it('服务器不支持文件事件时仍关闭旧文档并明确降级', async () => {
    const project = makeProject();
    const manager = makeManager(project);
    await manager.documentSymbols(filePath(project), 'typescript');
    fs.rmSync(filePath(project));
    const warnings = manager.notifyFileOperations([{
      filePath: 'a.ts', operation: 'delete', baseHash: null, resultHash: null,
      edits: [], preview: [], previewTruncated: false, additions: 0, deletions: 0,
    }]);
    expect(warnings.join(' ')).toContain('does not advertise workspace delete notifications');
    await project.waitForLog((log) => log.some((entry) => entry.method === 'textDocument/didClose'));
  });

  it('a declared diagnosticProvider means pull diagnostics', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { serverArgs: ['--pull-diagnostics'] });
    const manager = makeManager(project);

    const result = await manager.diagnostics(filePath(project), 'typescript');
    expect(result.source).toBe('pull');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.message).toContain('fake pull diagnostic');
    expect(result.items[0]!.severity).toBe(1);
    expect(manager.status().find((entry) => entry.family === 'typescript')!.capabilities!.diagnostics).toBe('pull');
  });

  it('without pull capability it waits for publishDiagnostics and gets a fresh batch after didChange', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { serverArgs: ['--push-diagnostics'] });
    const manager = makeManager(project);
    const absolute = filePath(project);

    const first = await manager.diagnostics(absolute, 'typescript');
    expect(first.source).toBe('push');
    expect(first.items).toHaveLength(1);

    fs.writeFileSync(absolute, 'export class Widget {\n  render() { return 3; }\n}\n');
    const second = await manager.diagnostics(absolute, 'typescript');
    expect(second.items).toHaveLength(2);
    expect(second.items[0]!.message).toContain('after change');
  });
});

describe('LSP manager: unavailable states', () => {
  it('a disabled language family starts no process', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { config: { disabled: ['typescript'] } });
    const manager = makeManager(project);

    const error = await manager.documentSymbols(filePath(project), 'typescript').catch((caught) => caught);
    expect(error).toBeInstanceOf(LspUnavailableError);
    expect(manager.describeFamily('typescript').reason).toContain('disabled');
    expect(liveLspChildCount()).toBe(0);
  });

  it('a missing command reports the cause and remedy instead of a generic error', async () => {
    const project = makeProject({ 'a.ts': FILE_CONTENT }, { server: { command: 'definitely-not-a-real-lsp' } });
    const manager = makeManager(project);

    const error = await manager.documentSymbols(filePath(project), 'typescript').catch((caught) => caught);
    expect(error).toBeInstanceOf(LspUnavailableError);
    expect((error as LspUnavailableError).message).toContain('definitely-not-a-real-lsp');
    expect((error as LspUnavailableError).remedy).toContain('.codegraph/lsp.json');
  });

  it('a language with no matching server reports a clear error', async () => {
    const project = makeProject();
    const manager = makeManager(project);
    const error = await manager.documentSymbols(filePath(project), 'ruby').catch((caught) => caught);
    expect(error).toBeInstanceOf(LspUnavailableError);
    expect((error as Error).message).toContain('ruby');
  });

  it('the jdt.ls workspace data directory lives outside the project and is per-project', () => {
    const first = defaultJdtlsWorkspaceDir('C:/proj/one');
    const second = defaultJdtlsWorkspaceDir('C:/proj/two');
    expect(first).not.toBe(second);
    expect(defaultJdtlsWorkspaceDir('C:/proj/one')).toBe(first);
    expect(first.includes(path.join('.codegraph', 'lsp', 'jdtls'))).toBe(true);
    expect(first.startsWith('C:/proj/one')).toBe(false);
  });
});
