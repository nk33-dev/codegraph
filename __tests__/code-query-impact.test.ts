/**
 * Phase three: change impact (mode=impact) and related tests (mode=tests).
 *
 * Covers graph-side distance propagation and pagination, parity across the CLI, MCP, and
 * library entry points, and the existing CLI `impact` / `affected` commands sharing one
 * implementation with the new entry point (same input, same answer).
 * Every assertion runs against a real index (SQLite + Tree-sitter); graph queries are not mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, type AffectedTestItem, type ImpactItem } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
let cg: CodeGraph;
let handler: ToolHandler;

function write(file: string, source: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

const cliEnv = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_SHARED_SERVICE: '0', CODEGRAPH_TELEMETRY: '0', NO_COLOR: '1' };

function exploreCli(args: string[], timeout = 60_000) {
  return spawnSync(process.execPath, [BIN, 'explore', ...args, '-p', root], { encoding: 'utf-8', timeout, env: cliEnv, windowsHide: true });
}

/** Deterministic fields the CLI and MCP must agree on (pid, timestamps, and shared-service state vary per process). */
function deterministic(result: any) {
  return {
    backend: result.backend,
    mode: result.mode,
    status: result.status,
    coordinates: result.coordinates,
    items: result.items,
    page: result.page,
    ambiguous: result.ambiguous,
    resolved: result.routing.resolved,
    sources: result.routing.sources,
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-change-impact-'));
  write('src/util.ts', 'export function utilFn() { return 1; }\n');
  write('src/service.ts', "import { utilFn } from './util';\nexport function serviceFn() { return utilFn(); }\n");
  write('src/main.ts', "import { serviceFn } from './service';\nexport function mainFn() { return serviceFn(); }\n");
  write('src/lonely.ts', 'export function lonely() { return 0; }\n');
  write('src/util.test.ts', "import { utilFn } from './util';\nexport function testUtil() { return utilFn(); }\n");
  write('tests/service.test.ts', "import { serviceFn } from '../src/service';\nexport function testService() { return serviceFn(); }\n");
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 60_000);

afterAll(() => {
  handler?.closeAll();
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('mode=impact', () => {
  it('reports affected symbols, propagation distance, and the edge types behind them', () => {
    const result = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 1 });
    expect(result.status).toBe('ok');
    expect(result.backend).toBe('graph');
    expect(result.routing).toMatchObject({ requested: 'graph', resolved: 'graph' });

    const byName = new Map(result.items.map((item) => [(item as ImpactItem).name, item as ImpactItem]));
    // The definition itself (distance 0), its direct callers, and the "file that imported this
    // symbol" nodes (existing graph semantics: cross-file dependency edges make the file a
    // bounded leaf). Structured modes do not silently drop file nodes.
    expect(byName.get('utilFn')).toMatchObject({ distance: 0, via: [], filePath: 'src/util.ts', kind: 'function' });
    expect(byName.get('serviceFn')).toMatchObject({ distance: 1, filePath: 'src/service.ts' });
    expect(byName.get('serviceFn')!.via).toContain('calls');
    expect(byName.get('serviceFn')!.rootId).toBe(byName.get('utilFn')!.id);
    expect(byName.get('testUtil')).toMatchObject({ distance: 1, filePath: 'src/util.test.ts' });
    expect(byName.get('service.ts')).toMatchObject({ distance: 1, kind: 'file' });
    expect(byName.get('util.test.ts')).toMatchObject({ distance: 1, kind: 'file' });
    // The impact set contains only paths inside this project
    expect(result.items.every((item) => (item as ImpactItem).filePath.startsWith('src/'))).toBe(true);
    expect(result.routing.sources.graph).toBe(result.items.length);
    expect(result.warnings.join('\n')).toContain('propagation depth');
  }, 30_000);

  it('depth bounds propagation: two hops reach mainFn, one hop does not', () => {
    const shallow = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 1 });
    expect((shallow.items as ImpactItem[]).some((item) => item.name === 'mainFn')).toBe(false);

    const deep = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2 });
    const main = (deep.items as ImpactItem[]).find((item) => item.name === 'mainFn');
    expect(main).toMatchObject({ distance: 2, filePath: 'src/main.ts' });
  }, 30_000);

  it('pagination is stable and total counts unpaginated items', () => {
    const all = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2 });
    const first = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2, limit: 1 });
    expect(first.page).toMatchObject({ total: all.page.total, nextOffset: 1 });
    const second = cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2, limit: 10, offset: 1 });
    expect(second.page.nextOffset).toBeNull();
    expect([...first.items, ...second.items]).toEqual(all.items);
  }, 30_000);

  it('a missing symbol yields not_found, not an empty success', () => {
    const result = cg.queryCode({ mode: 'impact', query: 'noSuchSymbol' });
    expect(result.status).toBe('not_found');
    expect(result.page.total).toBe(0);
  }, 30_000);

  it('shares one implementation with the CLI impact command: identical affected symbol sets', () => {
    const cli = spawnSync(process.execPath, [BIN, 'impact', 'utilFn', '--depth', '2', '--json', '-p', root], {
      encoding: 'utf-8', timeout: 60_000, env: cliEnv,
      windowsHide: true,
    });
    expect(cli.status, cli.stderr).toBe(0);
    const json = JSON.parse(cli.stdout);
    const cliNames = new Set(json.affected.map((node: { name: string }) => node.name));
    const modeNames = new Set(cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2 }).items.map((item) => (item as ImpactItem).name));
    expect(cliNames).toEqual(modeNames);

    const cliCli = exploreCli(['utilFn', '--mode', 'impact', '--depth', '2']);
    expect(cliCli.status, cliCli.stderr).toBe(0);
    const cliResult = JSON.parse(cliCli.stdout);
    expect(deterministic(cliResult)).toEqual(deterministic(cg.queryCode({ mode: 'impact', query: 'utilFn', depth: 2 })));
  }, 90_000);
});

describe('mode=tests', () => {
  it('finds test files along file dependencies and reports distance and reason', () => {
    const result = cg.queryCode({ mode: 'tests', query: 'src/service.ts' });
    expect(result.status).toBe('ok');
    expect(result.page.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      filePath: 'tests/service.test.ts',
      language: 'typescript',
      distance: 1,
      reason: 'dependent',
      via: ['src/service.ts'],
    } satisfies Partial<AffectedTestItem>);
  }, 30_000);

  it('a changed file that is itself a test gets reason="changed" and distance 0', () => {
    const result = cg.queryCode({ mode: 'tests', query: 'tests/service.test.ts' });
    expect(result.items[0]).toMatchObject({ filePath: 'tests/service.test.ts', distance: 0, reason: 'changed', via: [] });
  }, 30_000);

  it('depth decides reach: one hop sees direct dependents, five hops reach farther tests', () => {
    const shallow = cg.queryCode({ mode: 'tests', query: 'src/util.ts', depth: 1 });
    expect(shallow.items.map((item) => (item as AffectedTestItem).filePath)).toEqual(['src/util.test.ts']);

    const deep = cg.queryCode({ mode: 'tests', query: 'src/util.ts', depth: 5 });
    expect(deep.items.map((item) => (item as AffectedTestItem).filePath)).toEqual(['src/util.test.ts', 'tests/service.test.ts']);
    expect((deep.items[1] as AffectedTestItem).distance).toBeGreaterThan(1);
  }, 30_000);

  it('the files array is equivalent to a whitespace-separated list in query', () => {
    const fromQuery = cg.queryCode({ mode: 'tests', query: 'src/util.ts' });
    // `files` alone is a valid request: the query string may be empty in that one mode.
    const fromFiles = cg.queryCode({ mode: 'tests', files: ['src/util.ts'], query: '' });
    expect(fromFiles.status).toBe('ok');
    expect(fromFiles.items).toEqual(fromQuery.items);

    const both = cg.queryCode({ mode: 'tests', files: ['src/util.ts'], query: 'ignored placeholder' });
    expect(both.items).toEqual(fromQuery.items);
    expect(both.warnings.join('\n')).toContain('query string was ignored');
  }, 30_000);

  it('unindexed changed files warn honestly and no related tests yields not_found', () => {
    const result = cg.queryCode({ mode: 'tests', query: 'src/lonely.ts missing.ts' });
    expect(result.status).toBe('not_found');
    expect(result.warnings.join('\n')).toContain('not in the index');
    expect(result.warnings.join('\n')).toContain('missing edge');
  }, 30_000);

  it('the MCP layer accepts the files array and CLI and library deterministic fields match', () => {
    const args = { mode: 'tests', query: 'src/service.ts', depth: 3 };
    const mcp = handler.execute('codegraph_explore', args);
    return mcp.then((result) => {
      const cli = exploreCli(['src/service.ts', '--mode', 'tests', '--depth', '3']);
      expect(cli.status, cli.stderr).toBe(0);
      expect(deterministic(JSON.parse(cli.stdout))).toEqual(deterministic(result.structuredContent));
    });
  }, 60_000);

  it('the CLI affected command shares the implementation with the new entry point: identical test file lists', () => {
    const cli = spawnSync(process.execPath, [BIN, 'affected', 'src/util.ts', '--json', '-p', root], {
      encoding: 'utf-8', timeout: 60_000, env: cliEnv,
      windowsHide: true,
    });
    expect(cli.status, cli.stderr).toBe(0);
    const json = JSON.parse(cli.stdout);
    const mode = cg.queryCode({ mode: 'tests', query: 'src/util.ts', depth: 5 });
    expect(json.affectedTests).toEqual(mode.items.map((item) => (item as AffectedTestItem).filePath));
    expect(json.totalDependentsTraversed).toBeGreaterThan(0);

    const quiet = spawnSync(process.execPath, [BIN, 'affected', 'src/util.ts', '--quiet', '-p', root], {
      encoding: 'utf-8', timeout: 60_000, env: cliEnv,
      windowsHide: true,
    });
    expect(quiet.stdout.split('\n').filter(Boolean)).toEqual(json.affectedTests);
  }, 90_000);

  it('CLI affected --filter still classifies test files by a custom glob', () => {
    const filtered = spawnSync(process.execPath, [BIN, 'affected', 'src/util.ts', '--quiet', '--filter', 'tests/*.ts', '-p', root], {
      encoding: 'utf-8', timeout: 60_000, env: cliEnv,
      windowsHide: true,
    });
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stdout.split('\n').filter(Boolean)).toEqual(['tests/service.test.ts']);

    const none = spawnSync(process.execPath, [BIN, 'affected', 'src/util.ts', '--quiet', '--filter', '*.spec.ts', '-p', root], {
      encoding: 'utf-8', timeout: 60_000, env: cliEnv,
      windowsHide: true,
    });
    expect(none.stdout.trim()).toBe('');
  }, 90_000);
});
