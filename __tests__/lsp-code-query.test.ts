/**
 * Unified contract for LSP queries: result shape and pagination for all four modes,
 * availability, CLI/MCP output parity, and unchanged graph-backend behavior (phase-one regression).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { once } from 'events';
import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';

let project: FakeProject;
let cg: CodeGraph;

async function setupProject(options: Parameters<typeof createFakeProject>[1] = {}): Promise<void> {
  project = createFakeProject({ 'a.ts': FILE_CONTENT }, options);
  cg = CodeGraph.initSync(project.root);
  await cg.indexAll();
  __setLoadCodeGraphForTests(CodeGraph);
}

beforeEach(async () => {
  await setupProject({ serverArgs: ['--pull-diagnostics'] });
}, 30_000);

afterEach(() => {
  try { cg?.close(); } catch { /* ignore */ }
  __setLoadCodeGraphForTests(null);
  project?.cleanup();
});

describe('LSP structured query contract', () => {
  it('symbols: hierarchy, parent index, qualified name, and result source are all surfaced', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'symbols', query: 'a.ts', file: 'a.ts' });

    expect(result).toMatchObject({
      schemaVersion: 1,
      backend: 'lsp',
      mode: 'symbols',
      status: 'ok',
      coordinates: { lineBase: 1, columnBase: 0, columnEncoding: 'utf-16' },
      page: { offset: 0, limit: 50, total: 3, nextOffset: null },
    });
    const items = result.items as Array<Record<string, any>>;
    expect(items.map((item) => item.name)).toEqual(['Widget', 'render', 'helper']);
    expect(items[0]).toMatchObject({ source: 'lsp', kind: 'class', qualifiedName: 'Widget', parentIndex: null, external: false });
    expect(items[1]).toMatchObject({ kind: 'method', qualifiedName: 'Widget.render', parentIndex: 0 });
    // Positions convert LSP's 0-based lines plus UTF-16 columns into 1-based lines
    expect(items[0]).toMatchObject({ startLine: 1, startColumn: 7 });
    // Server information is reported as-is
    expect(result.lsp?.server).toMatchObject({
      family: 'typescript',
      state: 'ready',
      capabilities: { documentSymbol: true, diagnostics: 'pull' },
      indexing: false,
    });
    expect(typeof result.lsp?.server?.pid).toBe('number');
    expect(result.lsp?.documentsOpened).toBe(1);
  });

  it('definitions: locate the symbol by name in the graph index, then ask the language server', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'definitions', query: 'Widget' });
    expect(result.status).toBe('ok');
    const items = result.items as Array<Record<string, any>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'lsp',
      filePath: 'a.ts',
      external: false,
      startLine: 1,
      startColumn: 7,
      name: 'Widget',
      kind: 'class',
      symbolId: expect.any(String),
    });
  });

  it('references: distinguish in-project sites from out-of-project URIs', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'references', query: 'Widget' });
    const items = result.items as Array<Record<string, any>>;
    expect(result.page.total).toBe(2);
    expect(items[0]).toMatchObject({ source: 'lsp', kind: 'lsp_usage', provenance: 'lsp' });
    expect(items[0]!.site).toMatchObject({ filePath: 'a.ts', startLine: 2, startColumn: 4, external: false });
    expect(items[0]!.target).toMatchObject({ filePath: 'a.ts', name: 'Widget' });
    // Out-of-project sites keep absolute paths and are marked external
    expect(items[1]!.site.external).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('outside the project'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('include the declaration'))).toBe(true);
  });

  it('diagnostics: pull results map severity and provider and can be filtered by minimum severity', async () => {
    const all = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' });
    expect(all.status).toBe('ok');
    const items = all.items as Array<Record<string, any>>;
    expect(items[0]).toMatchObject({
      source: 'lsp',
      filePath: 'a.ts',
      severity: 'error',
      message: expect.stringContaining('fake pull diagnostic'),
      code: 'FAKE0',
      diagnosticSource: 'fake-lsp',
    });
    expect(items[0]).toMatchObject({ startLine: 1, startColumn: 2, endLine: 1, endColumn: 8 });
  });

  it('pagination is stable and nextOffset agrees with total', async () => {
    const first = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'symbols', query: 'a.ts', file: 'a.ts', limit: 1 });
    expect(first.page).toMatchObject({ total: 3, nextOffset: 1 });
    const second = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'symbols', query: 'a.ts', file: 'a.ts', limit: 5, offset: 1 });
    expect(second.page).toMatchObject({ total: 3, nextOffset: null });
    expect((second.items as Array<Record<string, any>>).map((item) => item.name)).toEqual(['render', 'helper']);
  });

  it('graph backend is unchanged: still graph/utf-8, and rejects LSP-only arguments', async () => {
    const graph = cg.queryCode({ mode: 'symbols', query: 'a.ts' });
    expect(graph.backend).toBe('graph');
    expect(graph.coordinates.columnEncoding).toBe('utf-8');
    expect(graph.lsp).toBeNull();

    await expect(cg.queryCodeWithBackend({ backend: 'graph', mode: 'definitions', query: 'Widget', line: 1 }))
      .rejects.toThrow(/line\/column require backend/);
    await expect(cg.queryCodeWithBackend({ backend: 'graph', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' }))
      .rejects.toThrow(/diagnostics requires backend "lsp"/);
    // Phase three: auto is implemented. An explicit invalid backend is still rejected
    // (the "not implemented" hint is gone).
    await expect(cg.queryCodeWithBackend({ mode: 'definitions', query: 'Widget', backend: 'sometimes' as never }))
      .rejects.toThrow(/backend must be/);
    await expect(cg.queryCodeWithBackend({ backend: 'lsp', mode: 'diagnostics', query: 'a.ts' }))
      .rejects.toThrow(/requires a project-relative file/);
    await expect(cg.queryCodeWithBackend({ backend: 'lsp', mode: 'status', query: 'status', severity: 2 }))
      .rejects.toThrow(/severity is only supported in diagnostics/);
    // Only the graph can answer tests mode, so explicitly asking for LSP is rejected
    // instead of returning a fake answer.
    await expect(cg.queryCodeWithBackend({ backend: 'lsp', mode: 'tests', query: 'a.ts' }))
      .rejects.toThrow(/tests mode is graph-only/);
  });
});

describe('LSP diagnostic filtering and availability', () => {
  it('severity filters out items below the threshold', async () => {
    cg.close();
    project.cleanup();
    await setupProject({ serverArgs: ['--pull-diagnostics', '--mixed-diagnostics'] });

    const all = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' });
    expect(all.page.total).toBe(2);

    const errorsOnly = await cg.queryCodeWithBackend({ backend: 'lsp', mode: 'diagnostics', query: 'a.ts', file: 'a.ts', severity: 1 });
    expect(errorsOnly.page.total).toBe(1);
    expect((errorsOnly.items[0] as Record<string, any>).severity).toBe('error');
  });

  it('with no usable language server it returns unavailable (not a tool failure) plus a remedy', async () => {
    cg.close();
    project.cleanup();
    await setupProject({ config: { disabled: ['typescript'] } });

    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('codegraph_explore', { backend: 'lsp', mode: 'symbols', query: 'a.ts', file: 'a.ts' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ backend: 'lsp', status: 'unavailable' });
      expect(result.structuredContent!.warnings.join('\n')).toContain('.codegraph/lsp.json');
    } finally {
      handler.closeAll();
    }
  });
});

describe('LSP CLI / MCP parity', () => {
  const deterministic = (result: any) => ({
    backend: result.backend,
    mode: result.mode,
    status: result.status,
    coordinates: result.coordinates,
    items: result.items,
    page: result.page,
    ambiguous: result.ambiguous,
  });

  it('CLI and MCP JSON agree on every deterministic field for the same query', async () => {
    const args = { backend: 'lsp', mode: 'symbols', query: 'a.ts', file: 'a.ts', limit: 10 };
    const handler = new ToolHandler(cg);
    let mcp: any;
    try {
      const result = await handler.execute('codegraph_explore', args);
      mcp = result.structuredContent;
      expect(JSON.parse(result.content[0]!.text)).toEqual(mcp);
    } finally {
      handler.closeAll();
    }

    const cli = spawnSync(process.execPath, [
      bin, 'explore', 'a.ts', '--mode', 'symbols', '--backend', 'lsp', '--file', 'a.ts', '--limit', '10', '-p', project.root,
    ], {
      encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0' },
      windowsHide: true,
    });
    expect(cli.status, cli.stderr).toBe(0);
    const cliResult = JSON.parse(cli.stdout);
    // pid, timestamps, and request counts vary per process, so they are not compared
    expect(deterministic(cliResult)).toEqual(deterministic(mcp));
  }, 60_000);

  it('a real MCP handshake exposes backend and diagnostics mode and tools/call keeps structured fields', async () => {
    const child = spawn(process.execPath, [bin, 'serve', '--mcp', '--no-watch', '--path', project.root], {
      cwd: project.root, stdio: 'pipe', windowsHide: true,
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
      const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP ${method} timed out`)); }, 30_000);
      lines.on('line', receive);
      child.once('exit', exited);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });

    try {
      await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'lsp-code-query-test', version: '1' }, rootUri: pathToFileURL(project.root).href,
      });
      const list = await request('tools/list', {});
      const tool = list.tools.find((entry: any) => entry.name === 'codegraph_explore');
      expect(tool.inputSchema.properties.backend.enum).toEqual(['graph', 'lsp', 'auto', 'both']);
      expect(tool.inputSchema.properties.mode.enum).toContain('diagnostics');
      expect(tool.inputSchema.properties.mode.enum).toContain('impact');
      expect(tool.inputSchema.properties.mode.enum).toContain('tests');
      expect(tool.inputSchema.properties.severity.type).toBe('number');
      expect(tool.inputSchema.properties.depth.type).toBe('number');
      expect(tool.inputSchema.properties.files.type).toBe('array');

      const result = await request('tools/call', {
        name: 'codegraph_explore',
        arguments: { backend: 'lsp', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' },
      });
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1, backend: 'lsp', mode: 'diagnostics', status: 'ok' });
      expect(result.structuredContent.items[0]).toMatchObject({ severity: 'error', filePath: 'a.ts' });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
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
