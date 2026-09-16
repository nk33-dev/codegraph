/**
 * Phase 4: the structured-edit flow against a real project, a real index, the MCP tool and the CLI.
 *
 * The properties this file pins are the safety ones, because they are what makes a write tool usable
 * from an agent: a preview writes nothing, an apply re-verifies the bytes it planned against, a stale
 * index row or an ambiguous name is refused instead of guessed, and after a write the index is
 * refreshed so the next query sees the new source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { once } from 'events';
import { createInterface } from 'readline';
import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, type CodeEditResult } from '../src';
import { clearLspConfigCache } from '../src/lsp/config';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';

const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
const SERVICE = 'export function run() {\n  return 1;\n}\n';
const VIEW = 'export class View {\n  render() {\n    return 1;\n  }\n}\n';

let root: string;
let cg: CodeGraph;
let handler: ToolHandler;

const write = (file: string, value: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), value);
};
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf-8');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edit-'));
  write('a/service.ts', SERVICE);
  write('b/service.ts', 'export function run() {\n  return 2;\n}\n');
  write('a/main.ts', "import { run } from './service';\nexport function entry() {\n  return run();\n}\n");
  write('view.js', VIEW);
  write('crlf.ts', 'export function crlfFn() {\r\n  return 1;\r\n}\r\n');
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
  __setLoadCodeGraphForTests(CodeGraph);
}, 30_000);

afterEach(() => {
  cg?.unwatch();
  handler?.closeAll();
  cg?.close();
  __setLoadCodeGraphForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('preview (the default)', () => {
  it('plans a body replacement, returns the target and the diff, and writes nothing', async () => {
    const result = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 42; }',
    });

    expect(result).toMatchObject({
      schemaVersion: 1, operation: 'replace-body', applyRequested: false, status: 'preview', applied: null,
      summary: { files: 1, edits: 1, additions: 1, deletions: 3, previewTruncated: false },
    });
    expect(result.previewHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.target).toMatchObject({
      source: 'index', filePath: 'a/service.ts', name: 'run', qualifiedName: 'run', kind: 'function',
      language: 'typescript', freshness: 'current', startLine: 1, startColumn: 0, endLine: 3, endColumn: 1,
    });
    expect(result.routing).toMatchObject({ source: 'index', lsp: { requested: false } });
    expect(result.files[0]).toMatchObject({ filePath: 'a/service.ts', operation: 'modify', previewTruncated: false });
    expect(result.files[0]!.edits[0]).toMatchObject({
      startLine: 1, startColumn: 0, endLine: 3, endColumn: 1,
      oldText: 'export function run() {\n  return 1;\n}',
      newText: 'export function run() { return 42; }',
    });
    expect(result.files[0]!.baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.files[0]!.resultHash).not.toBe(result.files[0]!.baseHash);
    expect(result.warnings.join(' ')).toMatch(/Nothing was written/);

    // The preview is a pure read of the project.
    expect(read('a/service.ts')).toBe(SERVICE);
  });

  it('resolves a name without a file when it is unique, and refuses it when it is not', async () => {
    const unique = await cg.editCode({ operation: 'replace-body', symbol: 'entry', content: 'export function entry() { return 0; }' });
    expect(unique).toMatchObject({ status: 'preview', target: { filePath: 'a/main.ts' } });

    const ambiguous = await cg.editCode({ operation: 'replace-body', symbol: 'run', content: 'x' });
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.files).toEqual([]);
    expect(ambiguous.warnings.join(' ')).toMatch(/matches 2 definitions.*a\/service\.ts:1.*b\/service\.ts:1/);
  });

  it('refuses an unknown symbol, a path outside the root, and a mismatched argument set', async () => {
    const missing = await cg.editCode({ operation: 'replace-body', symbol: 'nope', file: 'a/service.ts', content: 'x' });
    expect(missing.status).toBe('not_found');

    const outside = await cg.editCode({ operation: 'replace-body', symbol: 'run', file: '../outside.ts', content: 'x' });
    expect(outside.status).toBe('rejected');
    expect(outside.warnings.join(' ')).toMatch(/within the project root/);

    const wrongArgument = await cg.editCode({ operation: 'replace-body', symbol: 'run', file: 'a/service.ts', content: 'x', newName: 'y' });
    expect(wrongArgument.status).toBe('error');
    expect(wrongArgument.warnings.join(' ')).toMatch(/newName is only accepted by rename/);
  });

  it('refuses to edit at positions the index no longer matches', async () => {
    write('a/service.ts', '// shifted by one line\nexport function run() {\n  return 1;\n}\n');
    const result = await cg.editCode({ operation: 'replace-body', symbol: 'run', file: 'a/service.ts', content: 'x' });
    expect(result.status).toBe('stale');
    expect(result.warnings.join(' ')).toMatch(/not current in the index/);
    expect(read('a/service.ts')).toBe('// shifted by one line\nexport function run() {\n  return 1;\n}\n');
  });

  it('文件大小和时间戳不变时，仍拒绝内容已变的编辑目标', async () => {
    const absolute = path.join(root, 'a/service.ts');
    const before = fs.statSync(absolute);
    const changed = SERVICE.replace('run()', 'fun()');
    fs.writeFileSync(absolute, changed);
    fs.utimesSync(absolute, before.atime, before.mtime);
    const result = await cg.editCode({ operation: 'replace-body', symbol: 'run', file: 'a/service.ts', content: 'x', apply: true });
    expect(result.status).toBe('stale');
    expect(read('a/service.ts')).toBe(changed);
    const positional = await cg.editCode({ operation: 'rename', file: 'a/service.ts', line: 1, column: 16, newName: 'next', apply: true });
    expect(positional.status).toBe('stale');
  });
});

describe('apply', () => {
  it('writes the change and refreshes the index so the next query sees it', async () => {
    const result = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 42; }', apply: true,
    });

    expect(result).toMatchObject({
      status: 'applied', applyRequested: true,
      applied: { files: ['a/service.ts'], indexSynced: true },
    });
    expect(read('a/service.ts')).toBe('export function run() { return 42; }\n');
    // The index was refreshed in the same call: the definition is now a one-line symbol.
    const definitions = cg.queryCode({ mode: 'definitions', query: 'run', file: 'a/service.ts' });
    expect(definitions.items[0]).toMatchObject({ startLine: 1, endLine: 1, freshness: 'current' });
    expect(cg.queryCode({ mode: 'references', query: 'run', file: 'a/service.ts' }).items.length).toBeGreaterThan(0);
  });

  it('binds an apply to the preview that was shown', async () => {
    const request = {
      operation: 'replace-body' as const, symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 7; }',
    };
    const preview = await cg.editCode(request);
    const applied = await cg.editCode({ ...request, apply: true, expectPreviewHash: preview.previewHash });
    expect(applied.status).toBe('applied');
    expect(read('a/service.ts')).toBe('export function run() { return 7; }\n');

    const mismatched = await cg.editCode({ ...request, apply: true, expectPreviewHash: 'deadbeef' });
    expect(mismatched.status).toBe('conflict');
    expect(mismatched.warnings.join(' ')).toMatch(/expectPreviewHash does not match/);
    expect(read('a/service.ts')).toBe('export function run() { return 7; }\n');
  });

  it('inserts whole lines before and after a symbol, keeping the file line ending', async () => {
    const before = await cg.editCode({
      operation: 'insert-before', symbol: 'run', file: 'a/service.ts',
      content: 'export function setup() {\n  return 0;\n}', apply: true,
    });
    expect(before.status).toBe('applied');
    expect(read('a/service.ts')).toBe('export function setup() {\n  return 0;\n}\nexport function run() {\n  return 1;\n}\n');

    const after = await cg.editCode({
      operation: 'insert-after', symbol: 'View', file: 'view.js',
      content: 'export function helper() {\n  return 2;\n}', apply: true,
    });
    expect(after.status).toBe('applied');
    expect(read('view.js')).toBe(`${VIEW}export function helper() {\n  return 2;\n}\n`);

    const crlf = await cg.editCode({
      operation: 'insert-after', symbol: 'crlfFn', file: 'crlf.ts',
      content: 'export function other() { return 0; }', apply: true,
    });
    expect(crlf.status).toBe('applied');
    expect(read('crlf.ts')).toBe('export function crlfFn() {\r\n  return 1;\r\n}\r\nexport function other() { return 0; }\r\n');
  });

  it('inserts before a nested member above its line, keeping the declaration\'s indentation', async () => {
    const result = await cg.editCode({
      operation: 'insert-before', symbol: 'render', file: 'view.js',
      content: '  helper() {\n    return 0;\n  }', apply: true,
    });
    expect(result.status).toBe('applied');
    // The inserted text carries its own indentation; `render()` keeps the one it already had.
    expect(read('view.js')).toBe('export class View {\n  helper() {\n    return 0;\n  }\n  render() {\n    return 1;\n  }\n}\n');
  });

  it('reports a rename as unavailable instead of approximating it with text replacement', async () => {
    fs.writeFileSync(path.join(root, '.codegraph', 'lsp.json'), JSON.stringify({ disabled: ['typescript'] }));
    clearLspConfigCache();

    const result = await cg.editCode({ operation: 'rename', symbol: 'run', file: 'a/service.ts', newName: 'execute' });
    expect(result.status).toBe('unavailable');
    expect(result.routing.lsp).toMatchObject({ requested: true, available: false });
    expect(result.files).toEqual([]);
    expect(read('a/service.ts')).toBe(SERVICE);
    expect(result.warnings.join(' ')).toMatch(/disabled in \.codegraph\/lsp\.json/);
  });
});

describe('MCP tool and CLI', () => {
  it('exposes codegraph_edit as a mutating tool on the default surface', () => {
    const listed = handler.getTools();
    const edit = listed.find((tool) => tool.name === 'codegraph_edit');
    expect(edit, 'codegraph_edit should be listed by default').toBeDefined();
    expect(edit!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(edit!.inputSchema.required).toContain('operation');
  });

  it('returns the structured result as JSON text and marks a refusal as an error', async () => {
    const preview = await handler.execute('codegraph_edit', {
      operation: 'replace-body', symbol: 'run', file: 'a/service.ts', content: 'export function run() { return 3; }',
    });
    expect(preview.isError).toBeUndefined();
    const payload = JSON.parse(preview.content[0]!.text) as CodeEditResult;
    expect(payload).toMatchObject({ status: 'preview', applyRequested: false, operation: 'replace-body' });
    expect(preview.structuredContent).toEqual(payload);

    const refused = await handler.execute('codegraph_edit', {
      operation: 'replace-body', symbol: 'nope', file: 'a/service.ts', content: 'x',
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ status: 'not_found' });
    expect(read('a/service.ts')).toBe(SERVICE);
  });

  it('the CLI previews by default and writes only with --apply', () => {
    const args = ['edit', 'run', '--operation', 'replace-body', '--file', 'a/service.ts', '--content', 'export function run() { return 9; }', '-p', root];
    const preview = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8', windowsHide: true });
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout.trim())).toMatchObject({ status: 'preview', operation: 'replace-body' });
    expect(read('a/service.ts')).toBe(SERVICE);

    const applied = spawnSync(process.execPath, [bin, ...args, '--apply'], { encoding: 'utf-8', windowsHide: true });
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout.trim())).toMatchObject({ status: 'applied', applied: { files: ['a/service.ts'] } });
    expect(read('a/service.ts')).toBe('export function run() { return 9; }\n');

    // A refusal exits non-zero so a shell script cannot mistake it for a successful edit.
    const refused = spawnSync(process.execPath, [bin, 'edit', 'nope', '--operation', 'replace-body', '--file', 'a/service.ts', '--content', 'x', '-p', root], { encoding: 'utf-8', windowsHide: true });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ status: 'not_found' });
  });

  it('a real MCP handshake lists codegraph_edit and runs it through tools/call', async () => {
    const child = spawn(process.execPath, [bin, 'serve', '--mcp', '--no-watch', '--path', root], {
      cwd: root, stdio: 'pipe', windowsHide: true,
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    let id = 0;
    const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const cleanup = () => { clearTimeout(timer); lines.off('line', receive); child.off('exit', exited); };
      const exited = () => { cleanup(); reject(new Error('MCP process exited before responding')); };
      const receive = (line: string) => {
        try {
          const message = JSON.parse(line);
          if (message.id !== requestId) return;
          cleanup();
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        } catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP ${method} timed out`)); }, 15_000);
      lines.on('line', receive);
      child.once('exit', exited);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    try {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'edit-test', version: '1' }, rootUri: pathToFileURL(root).href });
      const list = await request('tools/list', {});
      const tool = list.tools.find((entry: any) => entry.name === 'codegraph_edit');
      expect(tool, 'codegraph_edit must be listed over the real protocol').toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

      const preview = await request('tools/call', {
        name: 'codegraph_edit',
        arguments: { operation: 'replace-body', symbol: 'run', file: 'a/service.ts', content: 'export function run() { return 5; }' },
      });
      expect(preview.structuredContent).toMatchObject({ schemaVersion: 1, operation: 'replace-body', status: 'preview' });
      expect(JSON.parse(preview.content[0].text)).toEqual(preview.structuredContent);
      expect(read('a/service.ts')).toBe(SERVICE);

      const applied = await request('tools/call', {
        name: 'codegraph_edit',
        arguments: {
          operation: 'replace-body', symbol: 'run', file: 'a/service.ts',
          content: 'export function run() { return 5; }',
          apply: true, expectPreviewHash: preview.structuredContent.previewHash,
        },
      });
      expect(applied.structuredContent).toMatchObject({ status: 'applied', applied: { files: ['a/service.ts'] } });
      expect(read('a/service.ts')).toBe('export function run() { return 5; }\n');

      const refused = await request('tools/call', { name: 'codegraph_edit', arguments: { operation: 'explode', symbol: 'run' } });
      expect(refused.isError).toBe(true);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
  }, 60_000);
});
