/**
 * Phase 4: rename through a language server.
 *
 * Rename is the one edit that is not graph-native, so what this file pins is the boundary around it:
 * the workspace edit is validated and previewed in full before a byte is written, a server without
 * rename support (or one that answers nothing) is reported as unavailable rather than approximated by
 * text replacement, and an edit that would reach outside the project root is refused outright.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CodeGraph } from '../src';
import { clearLspConfigCache } from '../src/lsp/config';
import { normalizeWorkspaceEdit } from '../src/lsp/manager';
import { __setEditTransactionOperationFaultForTests } from '../src/edits/transaction';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

const CLASS_FILE = 'export class Widget {\n  render() { return 1; }\n}\nexport function helper() { return Widget; }\n';

let project: FakeProject;
let cg: CodeGraph;
let handler: ToolHandler;

const read = (file: string): string => fs.readFileSync(path.join(project.root, file), 'utf-8');

async function setup(files: Record<string, string>, serverArgs: string[] = []): Promise<void> {
  project = createFakeProject(files, { serverArgs });
  cg = CodeGraph.initSync(project.root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
  __setLoadCodeGraphForTests(CodeGraph);
}

afterEach(() => {
  vi.restoreAllMocks();
  __setEditTransactionOperationFaultForTests(null);
  try { cg?.close(); } catch { /* already closed */ }
  __setLoadCodeGraphForTests(null);
  clearLspConfigCache();
  project?.cleanup();
});

describe('normalizeWorkspaceEdit', () => {
  it('flattens changes and documentChanges, keeping the order and the kinds', () => {
    const edit = (line: number, text: string) => ({
      range: { start: { line, character: 0 }, end: { line, character: 3 } }, newText: text,
    });
    expect(normalizeWorkspaceEdit(null)).toEqual([]);
    expect(normalizeWorkspaceEdit({ changes: { 'file:///a.ts': [edit(0, 'x')], 'file:///b.ts': [] } })).toEqual([
      { kind: 'edits', uri: 'file:///a.ts', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'x' }], newUri: null },
    ]);
    expect(normalizeWorkspaceEdit({
      documentChanges: [
        { textDocument: { uri: 'file:///a.ts', version: 3 }, edits: [edit(1, 'y')] },
        { kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///c.ts' },
        { kind: 'create', uri: 'file:///d.ts' },
        { kind: 'delete', uri: 'file:///e.ts' },
      ],
    })).toMatchObject([
      { kind: 'edits', uri: 'file:///a.ts' },
      { kind: 'rename', uri: 'file:///a.ts', newUri: 'file:///c.ts' },
      { kind: 'create', uri: 'file:///d.ts' },
      { kind: 'delete', uri: 'file:///e.ts' },
    ]);
  });

  it('refuses an edit kind it does not understand instead of dropping it', () => {
    expect(() => normalizeWorkspaceEdit({ documentChanges: [{ kind: 'annotate', uri: 'file:///a.ts' }] }))
      .toThrow(/unsupported documentChanges kind/);
    expect(() => normalizeWorkspaceEdit({ changes: { 'file:///a.ts': [{ range: { start: {}, end: {} }, newText: 'x' }] } }))
      .toThrow(/malformed TextEdit/);
  });
});

describe('rename preview and apply', () => {
  beforeEach(async () => {
    await setup({ 'a.ts': CLASS_FILE }, ['--rename']);
  }, 30_000);

  it('previews every occurrence the server reports and writes nothing', async () => {
    const preview = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget' });

    expect(preview).toMatchObject({
      operation: 'rename', status: 'preview', applyRequested: false, applied: null,
      routing: { source: 'lsp', lsp: { requested: true, available: true, family: 'typescript', reason: null } },
      target: { source: 'lsp', filePath: 'a.ts', name: 'Widget', kind: 'class', language: 'typescript', freshness: 'current' },
    });
    expect(preview.files).toHaveLength(1);
    const file = preview.files[0]!;
    expect(file).toMatchObject({ filePath: 'a.ts', operation: 'modify' });
    expect(file.edits).toHaveLength(2);
    expect(file.edits[0]).toMatchObject({ startLine: 1, startColumn: 13, oldText: 'Widget', newText: 'Gadget' });
    expect(file.edits[1]).toMatchObject({ startLine: 4, oldText: 'Widget', newText: 'Gadget' });
    expect(read('a.ts')).toBe(CLASS_FILE);
    expect(preview.warnings.join(' ')).toMatch(/Nothing was written/);
  });

  it('applies the whole workspace edit and refreshes the index', async () => {
    const request = { operation: 'rename' as const, symbol: 'Widget', file: 'a.ts', newName: 'Gadget' };
    const preview = await cg.editCode(request);
    const applied = await cg.editCode({ ...request, apply: true, expectPreviewHash: preview.previewHash });

    expect(applied).toMatchObject({ status: 'applied', applied: { files: ['a.ts'], indexSynced: true } });
    expect(read('a.ts')).toBe('export class Gadget {\n  render() { return 1; }\n}\nexport function helper() { return Gadget; }\n');
    expect(cg.queryCode({ mode: 'definitions', query: 'Gadget', file: 'a.ts' }).items).toHaveLength(1);
    expect(cg.queryCode({ mode: 'definitions', query: 'Widget', file: 'a.ts' }).status).toBe('not_found');
  });

  it('renames by position (file + line + column) as well as by name', async () => {
    const result = await cg.editCode({ operation: 'rename', file: 'a.ts', line: 1, column: 13, newName: 'Gadget', apply: true });
    expect(result.status).toBe('applied');
    expect(read('a.ts')).toContain('export class Gadget');
  });

  it('keeps a CRLF file\'s line endings', async () => {
    writeFile('crlf.ts', 'export class Widget {\r\n  render() { return Widget; }\r\n}\r\n');
    await cg.indexFiles(['crlf.ts']);
    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'crlf.ts', newName: 'Gadget', apply: true });
    expect(result.status).toBe('applied');
    expect(read('crlf.ts')).toBe('export class Gadget {\r\n  render() { return Gadget; }\r\n}\r\n');
  });

  it('refuses an ambiguous name, and an unknown name, without asking the server for the wrong symbol', async () => {
    writeFile('b.ts', 'export class Widget {}\n');
    await cg.sync();
    const ambiguous = await cg.editCode({ operation: 'rename', symbol: 'Widget', newName: 'Gadget' });
    expect(ambiguous.status).toBe('ambiguous');

    const missing = await cg.editCode({ operation: 'rename', symbol: 'Nothing', file: 'a.ts', newName: 'Gadget' });
    expect(missing.status).toBe('not_found');
  });

  it('exposes the same result through the MCP tool', async () => {
    const response = await handler.execute('codegraph_edit', { operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget' });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ operation: 'rename', status: 'preview', routing: { source: 'lsp' } });
    expect(read('a.ts')).toBe(CLASS_FILE);
  });
});

describe('cross-file and unsafe workspace edits', () => {
  it('移动提交失败时回滚原文件，并返回逐文件恢复状态', async () => {
    await setup({ 'a.ts': CLASS_FILE }, ['--rename']);
    const source = path.join(project.root, 'a.ts');
    const destination = path.join(project.root, 'renamed.ts');
    vi.spyOn(cg.getLspManager(), 'rename').mockResolvedValue({
      items: [
        { kind: 'edits', uri: pathToFileURL(source).href, newUri: null, edits: [
          { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }, newText: 'Gadget' },
        ] },
        { kind: 'rename', uri: pathToFileURL(source).href, newUri: pathToFileURL(destination).href, edits: [] },
      ], retried: false,
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === destination) throw new Error('模拟移动失败');
      rename(from, to);
    });

    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true });

    expect(result).toMatchObject({
      status: 'error',
      applied: {
        files: [], indexSynced: false, transactionState: 'rolled_back',
        fileStates: [{ filePath: 'a.ts', state: 'restored' }],
      },
    });
    expect(result.warnings.join(' ')).toContain('restored from the transaction backups');
    expect(read('a.ts')).toBe(CLASS_FILE);
    expect(fs.existsSync(destination)).toBe(false);
    expect(cg.queryCode({ mode: 'definitions', query: 'Widget', file: 'a.ts' }).status).toBe('ok');
  }, 30_000);

  it('结构性编辑遇到索引写锁竞争时不误报索引已刷新', async () => {
    await setup({ 'a.ts': CLASS_FILE }, ['--rename']);
    const source = path.join(project.root, 'a.ts');
    const destination = path.join(project.root, 'renamed.ts');
    vi.spyOn(cg.getLspManager(), 'rename').mockResolvedValue({
      items: [
        { kind: 'edits', uri: pathToFileURL(source).href, newUri: null, edits: [
          { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }, newText: 'Gadget' },
        ] },
        { kind: 'rename', uri: pathToFileURL(source).href, newUri: pathToFileURL(destination).href, edits: [] },
      ], retried: false,
    });
    const lockPath = path.join(project.root, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.pid));

    try {
      const result = await cg.editCode({
        operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true,
      });

      expect(result).toMatchObject({
        status: 'applied',
        applied: { files: ['renamed.ts'], indexSynced: false, indexFiles: 0 },
      });
      expect(result.warnings.join(' ')).toContain('index writer lock is busy');
      expect(fs.existsSync(source)).toBe(false);
      expect(read('renamed.ts')).toContain('export class Gadget');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }, 30_000);

  it('第二个文件写入失败时恢复第一个文件，不留下部分修改', async () => {
    await setup({ 'a.ts': CLASS_FILE, 'b.ts': CLASS_FILE }, ['--rename']);
    project.writeConfig({ serverArgs: ['--rename', '--rename-extra', path.join(project.root, 'b.ts')] });
    __setEditTransactionOperationFaultForTests((point) => {
      if (point === 'before-commit:1') throw new Error('模拟第二次写入失败');
    });
    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true });
    expect(result).toMatchObject({
      status: 'error',
      applied: {
        files: [], transactionState: 'rolled_back',
        fileStates: [{ filePath: 'a.ts', state: 'restored' }, { filePath: 'b.ts', state: 'restored' }],
      },
    });
    expect(read('a.ts')).toBe(CLASS_FILE);
    expect(read('b.ts')).toBe(CLASS_FILE);
    expect(fs.readdirSync(project.root).some((file) => file.endsWith('.tmp'))).toBe(false);
  }, 30_000);

  it('plans and applies a rename that touches a second file', async () => {
    await setup({
      'a.ts': CLASS_FILE,
      'b.ts': "import { Widget } from './a';\nexport const make = () => new Widget();\n",
    }, ['--rename']);
    project.writeConfig({ serverArgs: ['--rename', '--rename-extra', path.join(project.root, 'b.ts')] });

    const preview = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget' });
    expect(preview.status).toBe('preview');
    expect(preview.files.map((file) => file.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(preview.warnings.join(' ')).toMatch(/The rename touches 2 files/);
    expect(read('b.ts')).toContain('new Widget()');

    const applied = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true });
    expect(applied.status).toBe('applied');
    expect(applied.applied?.files).toEqual(['a.ts', 'b.ts']);
    expect(read('a.ts')).toContain('export class Gadget');
    expect(read('b.ts')).toContain('import { Gadget }');
    expect(read('b.ts')).toContain('new Gadget()');
  }, 30_000);

  it('refuses a workspace edit that reaches outside the project root', async () => {
    const outside = path.join(os.tmpdir(), `codegraph-outside-${process.pid}.ts`);
    fs.writeFileSync(outside, 'export const Widget = 1;\n');
    try {
      await setup({ 'a.ts': CLASS_FILE }, ['--rename']);
      project.writeConfig({ serverArgs: ['--rename', '--rename-extra', outside] });

      const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true });
      expect(result.status).toBe('rejected');
      expect(result.warnings.join(' ')).toMatch(/outside the project root/);
      // Nothing at all was written — not even the in-project file.
      expect(read('a.ts')).toBe(CLASS_FILE);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('export const Widget = 1;\n');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  }, 30_000);

  it('refuses a workspace edit that reaches outside through an in-project directory link', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rename-outside-'));
    const outsideFile = path.join(outside, 'outside.ts');
    fs.writeFileSync(outsideFile, 'export const Widget = 1;\n');
    try {
      await setup({ 'a.ts': CLASS_FILE }, ['--rename']);
      const linked = path.join(project.root, 'linked-outside');
      try {
        fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }
      project.writeConfig({
        serverArgs: ['--rename', '--rename-extra', path.join(linked, 'outside.ts')],
      });

      const result = await cg.editCode({
        operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true,
      });

      expect(result.status).toBe('rejected');
      expect(result.warnings.join(' ')).toMatch(/outside the project root/);
      expect(read('a.ts')).toBe(CLASS_FILE);
      expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('export const Widget = 1;\n');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts the documentChanges form of the same edit', async () => {
    await setup({ 'a.ts': CLASS_FILE }, ['--rename', '--rename-document-changes']);
    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget', apply: true });
    expect(result.status).toBe('applied');
    expect(read('a.ts')).toContain('export class Gadget');
  }, 30_000);
});

describe('a server that cannot rename', () => {
  it('reports no-edits as unavailable, and writes nothing', async () => {
    await setup({ 'a.ts': CLASS_FILE }, ['--rename-null']);
    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget' });
    expect(result.status).toBe('unavailable');
    expect(result.routing.lsp).toMatchObject({ requested: true, available: false });
    expect(result.warnings.join(' ')).toMatch(/returned no rename edits/);
    expect(read('a.ts')).toBe(CLASS_FILE);
  }, 30_000);

  it('reports a missing renameProvider as unavailable', async () => {
    await setup({ 'a.ts': CLASS_FILE }, []);
    const result = await cg.editCode({ operation: 'rename', symbol: 'Widget', file: 'a.ts', newName: 'Gadget' });
    expect(result.status).toBe('unavailable');
    expect(result.warnings.join(' ')).toMatch(/does not advertise textDocument\/rename/);
    expect(read('a.ts')).toBe(CLASS_FILE);
  }, 30_000);
});

/** Write a file into the fake project root (the project is created by the suite's helper). */
function writeFile(relative: string, content: string): void {
  fs.writeFileSync(path.join(project.root, relative), content);
}
