/**
 * Phase three: unified routing (auto) and merging (both).
 *
 * Uses real SQLite, a real index, and the fake language server (deterministic) to cover:
 *   - auto decisions (mode, language, server availability) and **honest fallback**;
 *   - both merging, deduplication, cross-corroboration, and column-unit conversion;
 *   - argument validation (which layer owns depth/files, unknown backend);
 *   - status starts no language server process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import {
  decideRoute,
  mergeItems,
  projectRequest,
  type LspAvailability,
} from '../src/graph/code-query-route';
import type { CodeQueryRequest, CodeSymbol, LspSymbolItem } from '../src/graph/code-query';
import { createFakeProject, waitFor, type FakeProject } from './lsp-test-utils';

const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';
const PYTHON = 'def python_entry():\n    return 1\n';

let project: FakeProject;
let cg: CodeGraph;

async function setupProject(options: Parameters<typeof createFakeProject>[1] = {}): Promise<void> {
  project = createFakeProject({ 'a.ts': FILE_CONTENT, 'py.py': PYTHON, 'entry.rb': 'def ruby_entry\n  1\nend\n' }, { serverArgs: ['--pull-diagnostics'], ...options });
  cg = CodeGraph.initSync(project.root);
  await cg.indexAll();
  __setLoadCodeGraphForTests(CodeGraph);
}

afterEach(() => {
  try { cg?.close(); } catch { /* ignore */ }
  __setLoadCodeGraphForTests(null);
  project?.cleanup();
});

const availability = (over: Partial<LspAvailability> = {}): LspAvailability => ({
  family: 'typescript', available: true, reason: null, command: ['fake'], ...over,
});

describe('auto routing', () => {
  beforeEach(async () => {
    await setupProject();
  }, 30_000);

  it('definitions uses LSP when a server is available and the reason for the choice is explained', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'definitions', query: 'Widget' });

    expect(result.backend).toBe('lsp');
    expect(result.coordinates.columnEncoding).toBe('utf-16');
    expect(result.routing).toMatchObject({
      requested: 'auto',
      resolved: 'lsp',
      fallback: null,
      families: ['typescript'],
      sources: { graph: 0, lsp: 1 },
      servedBy: 'in-process',
    });
    expect(result.routing.reason).toContain('typescript');
    expect(result.status).toBe('ok');
    expect((result.items[0] as Record<string, unknown>).filePath).toBe('a.ts');
  }, 60_000);

  it('a disabled server falls back to the graph index, explained in routing and warnings', async () => {
    cg.close();
    project.cleanup();
    await setupProject({ config: { disabled: ['typescript'] } });

    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'definitions', query: 'Widget' });

    expect(result.backend).toBe('graph');
    expect(result.routing).toMatchObject({ requested: 'auto', resolved: 'graph', fallback: 'typescript is disabled in .codegraph/lsp.json' });
    expect(result.routing.reason).toContain('not available');
    expect(result.status).toBe('ok');
    expect(result.items).toHaveLength(1);
  }, 60_000);

  it('未映射服务族的 Ruby 回退到图查询', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'definitions', query: 'ruby_entry' });

    expect(result.backend).toBe('graph');
    expect(result.status).toBe('ok');
    expect(result.routing).toMatchObject({ requested: 'auto', resolved: 'graph' });
    expect(result.routing.reason).toContain('no language server');
  }, 30_000);

  it('Python 服务禁用时明确说明回退原因', async () => {
    project.writeConfig({ config: { disabled: ['python'] } });
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'definitions', query: 'python_entry' });
    expect(result.status).toBe('ok');
    expect(result.routing).toMatchObject({ resolved: 'graph', fallback: 'python is disabled in .codegraph/lsp.json' });
  }, 30_000);

  it('tests mode is graph-only: language servers have no notion of test associations', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'tests', query: 'a.ts' });

    expect(result.backend).toBe('graph');
    expect(result.routing.resolved).toBe('graph');
    expect(result.routing.reason).toContain('test associations');
  }, 30_000);

  it('only LSP can answer diagnostics, so auto picks it (and is honestly unavailable when it cannot)', async () => {
    const lsp = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' });
    expect(lsp.backend).toBe('lsp');
    expect(lsp.routing.resolved).toBe('lsp');
    expect(lsp.status).toBe('ok');
    expect(lsp.items[0]).toMatchObject({ severity: 'error' });

    cg.close();
    project.cleanup();
    await setupProject({ config: { disabled: ['typescript'] } });
    const unavailable = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' });
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.routing.resolved).toBe('lsp');
    expect(unavailable.warnings.join('\n')).toContain('.codegraph/lsp.json');
  }, 60_000);

  it('impact defaults to the graph and points at backend="both" for server reference sites', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'impact', query: 'Widget', depth: 1 });

    expect(result.backend).toBe('graph');
    expect(result.routing.resolved).toBe('graph');
    expect(result.routing.reason).toContain('both');
    expect(result.routing.families).toEqual([]);
  }, 30_000);

  it('a position query never falls back to the graph when no server can answer it', async () => {
    cg.close();
    project.cleanup();
    await setupProject({ config: { disabled: ['typescript'] } });

    const result = await cg.queryCodeWithBackend({
      backend: 'auto', mode: 'definitions', query: 'Widget', file: 'a.ts', line: 1, column: 7,
    });

    // Answering by NAME here would be a fabricated answer to a different question.
    expect(result.backend).toBe('lsp');
    expect(result.status).toBe('unavailable');
    expect(result.routing).toMatchObject({ requested: 'auto', resolved: 'lsp', sources: { graph: 0, lsp: 0 } });
    expect(result.routing.reason).toContain('no graph fallback');
    expect(result.items).toHaveLength(0);
  }, 60_000);

  it('status reports the index plus every language family and starts no language server', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'status', query: 'status' });

    expect(result.backend).toBe('both');
    expect(result.routing.resolved).toBe('both');
    expect(result.status).toBe('ok');
    expect(result.index).not.toBeNull();
    expect(result.lsp?.servers?.map((entry) => entry.family)).toEqual(['cpp', 'typescript', 'rust', 'go', 'java', 'python']);
    // No process started: every family is stopped and the fake server log has no initialize
    expect(result.lsp!.servers!.every((entry) => entry.state === 'stopped' && entry.pid === null)).toBe(true);
    expect(project.events('initialize')).toHaveLength(0);
  }, 30_000);
});

describe('decideRoute decision table', () => {
  const request = (over: Partial<CodeQueryRequest>): CodeQueryRequest => ({ mode: 'definitions', query: 'x', ...over });

  it('reasons are layered by mode, language, and availability', () => {
    const unavailable = availability({ available: false, reason: 'rust-analyzer is not on PATH' });

    expect(decideRoute(request({ backend: 'auto', mode: 'diagnostics' }), 'typescript', availability()).resolved).toBe('lsp');
    expect(decideRoute(request({ backend: 'auto', mode: 'tests' }), 'typescript', availability()).resolved).toBe('graph');
    expect(decideRoute(request({ backend: 'auto', mode: 'status' }), null, availability()).resolved).toBe('both');
    expect(decideRoute(request({ backend: 'both' }), 'typescript', availability()).resolved).toBe('both');
    expect(decideRoute(request({ backend: 'auto' }), null, availability()).resolved).toBe('graph');
    expect(decideRoute(request({ backend: 'auto' }), 'python', availability({ family: null })).resolved).toBe('graph');
    const fallback = decideRoute(request({ backend: 'auto' }), 'rust', unavailable);
    expect(fallback.resolved).toBe('graph');
    expect(fallback.unavailable).toBe('rust-analyzer is not on PATH');
    expect(decideRoute(request({ backend: 'auto' }), 'typescript', availability()).resolved).toBe('lsp');
    expect(decideRoute(request({ backend: 'auto', mode: 'impact' }), 'typescript', availability()).resolved).toBe('graph');
  });

  it('auto/both project onto a single source: each drops arguments exclusive to the other', () => {
    const both = projectRequest({
      backend: 'both', mode: 'references', query: 'x', includeDeclaration: false, checkFiles: false, line: 3, column: 4,
    }, 'graph');
    expect(both.backend).toBe('graph');
    expect(both.includeDeclaration).toBeUndefined();
    expect(both.line).toBeUndefined();
    expect(both.column).toBeUndefined();

    const lsp = projectRequest({ backend: 'both', mode: 'status', query: 'status', checkFiles: true }, 'lsp');
    expect(lsp.checkFiles).toBeUndefined();
    expect(lsp.backend).toBe('lsp');
  });
});

describe('both merging', () => {
  beforeEach(async () => {
    await setupProject();
  }, 30_000);

  it('definitions: a site hit by both sources dedupes and is marked corroborated', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'both', mode: 'definitions', query: 'Widget' });

    expect(result.backend).toBe('both');
    expect(result.coordinates.columnEncoding).toBe('utf-16');
    expect(result.routing).toMatchObject({
      requested: 'both',
      resolved: 'both',
      sources: { graph: 1, lsp: 1 },
      corroborated: 1,
      families: ['typescript'],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ origin: 'lsp', corroborated: true, filePath: 'a.ts', name: 'Widget' });
    expect(result.warnings.join('\n')).toContain('corroborated');
    expect(result.warnings.join('\n')).toContain('UTF-16');
  }, 60_000);

  it('symbols: server-only entries are kept and each item is labeled with its origin', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'both', mode: 'symbols', query: 'a.ts', file: 'a.ts' });

    const byName = new Map(result.items.map((item) => [(item as { name?: string }).name, item as { origin: string; corroborated: boolean }]));
    expect(byName.get('Widget')).toMatchObject({ origin: 'lsp', corroborated: true });
    // helper exists only in the language server outline (the fake server always returns it)
    expect(byName.get('helper')).toMatchObject({ origin: 'lsp', corroborated: false });
    expect(result.routing.corroborated).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('merges complete source result sets before applying a non-zero page offset', async () => {
    const full = await cg.queryCodeWithBackend({
      backend: 'both', mode: 'symbols', query: 'a.ts', file: 'a.ts',
    });
    const lastOffset = full.page.total - 1;
    expect(lastOffset).toBeGreaterThan(0);

    const last = await cg.queryCodeWithBackend({
      backend: 'both', mode: 'symbols', query: 'a.ts', file: 'a.ts', offset: lastOffset, limit: 1,
    });

    expect(last.page).toMatchObject({ offset: lastOffset, limit: 1, total: full.page.total, nextOffset: null });
    expect(last.items).toHaveLength(1);
  }, 60_000);

  it('references: with no graph edges every result comes from the server and external sites are kept', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'both', mode: 'references', query: 'Widget' });

    expect(result.routing.sources.graph).toBe(0);
    expect(result.routing.sources.lsp).toBe(2);
    expect(result.items.every((item) => (item as { origin: string }).origin === 'lsp')).toBe(true);
    expect(result.items.some((item) => (item as { site?: { external?: boolean } }).site?.external === true)).toBe(true);
  }, 60_000);

  it('impact: the graph supplies propagation distance and server reference sites merge in as separate items', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'both', mode: 'impact', query: 'Widget', depth: 1 });

    expect(result.routing.resolved).toBe('both');
    expect(result.routing.sources.lsp).toBeGreaterThan(0);
    const origins = new Set(result.items.map((item) => (item as { origin: string }).origin));
    expect(origins.has('lsp')).toBe(true);
  }, 60_000);

  it('diagnostics + both does not try to merge the graph (it has no diagnostics)', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'both', mode: 'diagnostics', query: 'a.ts', file: 'a.ts' });
    expect(result.backend).toBe('lsp');
    expect(result.routing.resolved).toBe('lsp');
  }, 60_000);
});

describe('mergeItems column conversion and origin merging', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-merge-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const graphSymbol = (over: Partial<CodeSymbol> = {}): CodeSymbol => ({
    id: 'function:1', name: 'target', qualifiedName: 'target', kind: 'function', language: 'typescript',
    filePath: 'multi.ts', startLine: 1, endLine: 1, startColumn: 0, endColumn: 6,
    parentId: null, freshness: 'current', ...over,
  });

  const lspSymbol = (over: Partial<LspSymbolItem> = {}): LspSymbolItem => ({
    source: 'lsp', filePath: 'multi.ts', external: false,
    startLine: 1, startColumn: 0, endLine: 1, endColumn: 6,
    name: 'target', kind: 'function', language: 'typescript', symbolId: 'function:1', ...over,
  });

  it('graph UTF-8 byte columns convert to UTF-16 code-unit columns', () => {
    // In the same line the CJK identifier occupies 6 bytes / 2 UTF-16 code units; the mismatch is in the prefix, not an emoji
    fs.writeFileSync(path.join(dir, 'multi.ts'), 'const 名字 = 1; function target() {}\n', 'utf-8');
    const byteColumn = Buffer.byteLength('const 名字 = 1; ', 'utf-8');
    const utf16Column = 'const 名字 = 1; '.length;

    const merged = mergeItems(dir, [graphSymbol({ startColumn: byteColumn, endColumn: byteColumn + 6 })], []);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ origin: 'graph', startColumn: utf16Column, corroborated: false });
    expect(utf16Column).toBeLessThan(byteColumn);
  });

  it('an unreadable file keeps byte columns and declares utf-8 on the item', () => {
    const merged = mergeItems(dir, [graphSymbol({ filePath: 'gone.ts', startColumn: 12, endColumn: 18 })], []);
    expect(merged.items[0]).toMatchObject({ columnEncoding: 'utf-8', startColumn: 12 });
  });

  it('both sources at the same site (file + line + name) merge into one item marked corroborated', () => {
    fs.writeFileSync(path.join(dir, 'multi.ts'), 'function target() {}\n', 'utf-8');
    const merged = mergeItems(dir, [graphSymbol()], [lspSymbol()]);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ origin: 'lsp', corroborated: true });
    expect(merged.corroborated).toBe(1);
  });

  it('different sites do not merge: a different column still counts as two', () => {
    fs.writeFileSync(path.join(dir, 'multi.ts'), 'function target() {}\n', 'utf-8');
    const merged = mergeItems(dir, [graphSymbol({ startLine: 2, startColumn: 3 })], [lspSymbol({ startLine: 3, startColumn: 3 })]);
    expect(merged.items).toHaveLength(2);
    expect(merged.corroborated).toBe(0);
    expect(new Set(merged.items.map((item) => (item as { origin: string }).origin))).toEqual(new Set(['graph', 'lsp']));
  });
});

describe('phase-three argument validation', () => {
  beforeEach(async () => {
    await setupProject();
  }, 30_000);

  it('depth/files are accepted only in their own modes and an unknown backend errors outright', async () => {
    await expect(cg.queryCodeWithBackend({ mode: 'definitions', query: 'Widget', depth: 2 }))
      .rejects.toThrow(/depth is only supported in impact or tests mode/);
    await expect(cg.queryCodeWithBackend({ mode: 'definitions', query: 'Widget', files: ['a.ts'] }))
      .rejects.toThrow(/files is only supported in tests mode/);
    await expect(cg.queryCodeWithBackend({ mode: 'impact', query: 'Widget', depth: 11 }))
      .rejects.toThrow(/depth must be an integer between 1 and 10/);
    await expect(cg.queryCodeWithBackend({ mode: 'tests', query: 'a.ts', file: 'a.ts' }))
      .rejects.toThrow(/not a single file/);
    await expect(cg.queryCodeWithBackend({ mode: 'impact', query: 'Widget', line: 3, file: 'a.ts' }))
      .rejects.toThrow(/line\/column are only supported in definitions or references mode/);
    await expect(cg.queryCodeWithBackend({ mode: 'definitions', query: 'Widget', backend: 'sometimes' as never }))
      .rejects.toThrow(/backend must be "graph", "lsp", "auto", or "both"/);
  }, 30_000);

  it('the MCP layer passes auto through verbatim without silently downgrading to graph', async () => {
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('codegraph_explore', { backend: 'auto', mode: 'definitions', query: 'Widget' });
      expect(result.structuredContent).toMatchObject({ backend: 'lsp', routing: { requested: 'auto', resolved: 'lsp' } });
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    } finally {
      handler.closeAll();
    }
  }, 60_000);

  it('after auto picks LSP the fake server really starts and reaches ready', async () => {
    const result = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'symbols', query: 'a.ts', file: 'a.ts' });
    expect(result.backend).toBe('lsp');
    expect(result.lsp?.server?.state).toBe('ready');
    expect(await waitFor(() => project.events('initialize').length > 0)).toBe(true);
  }, 60_000);
});
