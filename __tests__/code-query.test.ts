import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { once } from 'events';
import { createInterface } from 'readline';
import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, type CodeSymbol, type CodeReference } from '../src';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { __emitWatchEventForTests } from '../src/sync/watcher';

let root: string;
let cg: CodeGraph;
let handler: ToolHandler;
const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
const write = (file: string, value: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), value);
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-code-query-'));
  write('a/service.ts', 'export function run() { return 1; }\n');
  write('a/main.ts', "import { run } from './service';\nexport function entry() { return run(); }\n");
  write('b/service.ts', 'export function run() { return 2; }\n');
  write('b/main.ts', "import { run } from './service';\nexport function otherEntry() { return run(); }\n");
  write('src/lib.rs', 'pub fn rust_value() -> u32 { 1 }\npub fn rust_entry() -> u32 { rust_value() }\n');
  write('view.js', 'export class View {\n  render() { return 1; }\n}\n');
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

describe('structured graph queries', () => {
  it('definitions keep same-name ambiguity, paginate stably, and honor file filters', () => {
    const all = cg.queryCode({ mode: 'definitions', query: 'run' });
    expect(all.status).toBe('ok');
    expect(all.ambiguous).toBe(true);
    expect(all.page.total).toBe(2);
    const first = cg.queryCode({ mode: 'definitions', query: 'run', limit: 1 });
    const next = cg.queryCode({ mode: 'definitions', query: 'run', limit: 1, offset: first.page.nextOffset! });
    expect([...first.items, ...next.items]).toEqual(all.items);
    expect(next.page.nextOffset).toBeNull();
    expect(cg.queryCode({ mode: 'definitions', query: 'run', file: '.\\a\\service.ts' })).toMatchObject({ ambiguous: false, page: { total: 1 } });
    expect(cg.queryCode({ mode: 'definitions', query: 'run', file: 'service.ts' }).status).toBe('not_found');
    expect(cg.queryCode({ mode: 'definitions', query: 'runn' }).status).toBe('not_found');
  });

  it('references carry target ownership and source and treat contains as non-usage', () => {
    const result = cg.queryCode({ mode: 'references', query: 'run', file: 'a/service.ts' });
    const refs = result.items as CodeReference[];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every(r => r.target.filePath === 'a/service.ts')).toBe(true);
    expect(refs.every(r => r.source.filePath !== 'b/main.ts')).toBe(true);
    expect(refs.some(r => r.source.name === 'entry' && r.kind === 'calls' && r.site.line === 2)).toBe(true);
    expect(refs.some(r => r.kind === 'contains')).toBe(false);
    expect(refs.every(r => typeof r.provenance === 'string')).toBe(true);
  });

  it('Rust and JS reuse the existing parsers and outlines keep symbol hierarchy', () => {
    expect(cg.queryCode({ mode: 'references', query: 'rust_value' }).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ name: 'rust_entry', language: 'rust' }) }),
    ]));
    const symbols = cg.queryCode({ mode: 'symbols', query: 'view.js' }).items as CodeSymbol[];
    const container = symbols.find(n => n.name === 'View')!;
    const method = symbols.find(n => n.name === 'render')!;
    expect(method.parentId).toBe(container.id);
    expect(method.startLine).toBe(2);
    expect(method.freshness).toBe('current');
    expect(cg.queryCode({ mode: 'definitions', query: 'View.render' }).items).toHaveLength(1);
  });

  it('an unsynced file is marked stale and an identical rewrite is not flagged', async () => {
    write('a/service.ts', '\n\nexport function run() { return 111; }\n');
    expect((cg.queryCode({ mode: 'definitions', query: 'run', file: 'a/service.ts' }).items[0] as CodeSymbol).freshness).toBe('changed');
    await cg.sync();
    const result = cg.queryCode({ mode: 'definitions', query: 'run', file: 'a/service.ts' });
    expect(result.items[0]).toMatchObject({ startLine: 3, freshness: 'current' });
    const time = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(root, 'a/service.ts'), time, time);
    expect((cg.queryCode({ mode: 'definitions', query: 'run', file: 'a/service.ts' }).items[0] as CodeSymbol).freshness).toBe('current');
  });

  it('status separates unscanned from on-disk changes and incremental sync updates only changed files', async () => {
    const untouched = cg.getFile('view.js')!.indexedAt;
    const status = cg.queryCode({ mode: 'status', query: 'status' });
    expect(status.index).toMatchObject({ watching: false, changes: null });
    expect(status.warnings).not.toContain('This index connection has no live watcher.');
    write('added.ts', 'export function added() {}\n');
    write('b/service.ts', 'export function changedName() {}\n');
    fs.unlinkSync(path.join(root, 'a/service.ts'));
    const before = cg.queryCode({ mode: 'status', query: 'status', checkFiles: true });
    expect(before.index!.changes).toMatchObject({
      added: expect.arrayContaining(['added.ts']), modified: expect.arrayContaining(['b/service.ts']), removed: expect.arrayContaining(['a/service.ts']),
    });
    expect(cg.getFile('added.ts')).toBeNull();
    expect((cg.queryCode({ mode: 'definitions', query: 'run', file: 'a/service.ts' }).items[0] as CodeSymbol).freshness).toBe('missing');
    await cg.sync();
    expect(cg.queryCode({ mode: 'status', query: 'status', checkFiles: true }).index!.changes).toEqual({ added: [], modified: [], removed: [] });
    expect(cg.queryCode({ mode: 'definitions', query: 'run' }).status).toBe('not_found');
    expect(cg.getFile('view.js')!.indexedAt).toBe(untouched);
  });

  it('after a file rename and import update, a long-lived connection returns no stale reference sites', async () => {
    await handler.execute('codegraph_explore', { mode: 'references', query: 'run' });
    fs.renameSync(path.join(root, 'a/service.ts'), path.join(root, 'a/renamed.ts'));
    write('a/main.ts', "import { run } from './renamed';\nexport function entry() { return run(); }\n");
    await cg.sync();
    const result = await handler.execute('codegraph_explore', { mode: 'references', query: 'run', file: 'a/renamed.ts' });
    expect(result.structuredContent!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ name: 'entry' }), target: expect.objectContaining({ filePath: 'a/renamed.ts' }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain('a/service.ts');
  });

  it('CLI and MCP share the same JSON contract and default explore keeps text plus structured evidence', async () => {
    const args = { mode: 'definitions', query: 'run', file: 'a/service.ts' };
    const result = await handler.execute('codegraph_explore', args);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    const cli = spawnSync(process.execPath, [bin, 'explore', 'run', '--mode', 'definitions', '--file', 'a/service.ts', '-p', root], {
      encoding: 'utf-8', timeout: 30_000,
      env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0' },
      windowsHide: true,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(result.structuredContent);
    const legacy = await handler.execute('codegraph_explore', { query: 'View render' });
    expect(legacy.content[0]!.text).toContain('View');
    expect(legacy.structuredContent).toMatchObject({
      schemaVersion: 1,
      kind: 'explore',
      query: 'View render',
      projectRoot: root,
      evidence: { schemaVersion: 1 },
    });
  }, 30_000);

  it('syncing after a worktree branch switch matches a clean rebuild', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git('init', '-b', 'base');
    git('add', 'a', 'b', 'src', 'view.js');
    git('-c', 'user.name=CodeGraph Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    git('switch', '-c', 'feature');
    write('a/service.ts', 'export function replacement() {}\n');
    git('add', 'a/service.ts');
    git('-c', 'user.name=CodeGraph Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'rename');
    await cg.sync();
    expect(cg.queryCode({ mode: 'status', query: 'status', checkFiles: true }).index).toMatchObject({
      indexedCommit: git('rev-parse', 'HEAD').toString().trim(),
      currentCommit: git('rev-parse', 'HEAD').toString().trim(),
    });
    expect(cg.queryCode({ mode: 'definitions', query: 'replacement' }).page.total).toBe(1);
    git('switch', 'base');
    const beforeSync = cg.queryCode({ mode: 'status', query: 'status', checkFiles: true });
    expect(beforeSync.index.indexedCommit).not.toBe(beforeSync.index.currentCommit);
    expect(beforeSync.warnings).toContain('The index was built at a different Git commit; run codegraph sync and check the changed-file list.');
    await cg.sync();
    expect(cg.queryCode({ mode: 'status', query: 'status', checkFiles: true }).index.indexedCommit).toBe(git('rev-parse', 'HEAD').toString().trim());
    const incremental = cg.queryCode({ mode: 'references', query: 'run' }).items;
    expect(cg.queryCode({ mode: 'definitions', query: 'replacement' }).status).toBe('not_found');
    await cg.indexAll();
    expect(cg.queryCode({ mode: 'references', query: 'run' }).items).toEqual(incremental);
  }, 30_000);

  it('an unindexed project is not disguised as an empty query and bad arguments or directory escapes are rejected', async () => {
    const empty = new ToolHandler(null);
    const missing = await empty.execute('codegraph_explore', { mode: 'definitions', query: 'run' });
    expect(missing.isError).not.toBe(true);
    expect(missing.structuredContent!.status).toBe('not_indexed');
    empty.closeAll();
    for (const extra of [{ file: '../outside.ts' }, { limit: -1 }, { offset: 1.5 }, { checkFiles: true }]) {
      const result = await handler.execute('codegraph_explore', { mode: 'definitions', query: 'run', ...extra });
      expect(result.isError).toBe(true);
      expect(result.structuredContent!.status).toBe('error');
    }
  });

  it('an explicit project path still reports main watcher state and JSON is not broken by text banners', async () => {
    cg.watch({ debounceMs: 30_000, inertForTests: true });
    await cg.waitUntilWatcherReady();
    write('a/service.ts', 'export function run() { return 999; }\n');
    __emitWatchEventForTests(root, 'a/service.ts');
    const result = await handler.execute('codegraph_explore', { mode: 'status', query: 'status', projectPath: root });
    expect(result.structuredContent!.index).toMatchObject({
      watching: true, pendingFileCount: 1,
      pendingFiles: [expect.objectContaining({ path: 'a/service.ts' })],
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('cross-project queries isolate results by projectRoot', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-code-query-other-'));
    let second: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(other, 'other.ts'), 'export function onlyOther() {}\n');
      second = CodeGraph.initSync(other);
      await second.indexAll();
      const result = await handler.execute('codegraph_explore', { mode: 'definitions', query: 'onlyOther', projectPath: other });
      expect(result.structuredContent!.projectRoot).toBe(other);
      expect(result.structuredContent!.items).toHaveLength(1);
      expect((await handler.execute('codegraph_explore', { mode: 'definitions', query: 'onlyOther' })).structuredContent!.status).toBe('not_found');
    } finally {
      handler.closeAll();
      second?.close();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a real MCP handshake exposes the new modes and tools/call keeps structured fields', async () => {
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
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'code-query-test', version: '1' }, rootUri: pathToFileURL(root).href });
      const list = await request('tools/list', {});
      const tool = list.tools.find((t: any) => t.name === 'codegraph_explore');
      expect(tool.inputSchema.properties.mode.enum).toContain('definitions');
      expect(tool.annotations.readOnlyHint).toBe(true);
      const result = await request('tools/call', { name: 'codegraph_explore', arguments: { mode: 'definitions', query: 'rust_value' } });
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1, backend: 'graph', status: 'ok' });
      expect(result.structuredContent.items[0]).toMatchObject({ name: 'rust_value', language: 'rust' });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }
  }, 30_000);
});
