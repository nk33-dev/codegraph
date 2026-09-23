import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport } from '../src/mcp/transport';
import { analyzeChangeContext } from '../src/graph/change-context';
import { analyzeImpact, findAffectedTests } from '../src/graph/change-impact';
import { extractCodeTokens } from '../src/directory';
import type { Edge, Node } from '../src/types';
import type { ImpactItem } from '../src/graph/code-query';

let root: string;
let cg: CodeGraph;
let handler: ToolHandler;
const source = 'export function runtimeBuildIdentity() { return 1; }\nexport function invokeRuntime() { return runtimeBuildIdentity(); }\n';
function write(file: string, text: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-experience-'));
  write('src/runtime-info.ts', source);
  write('src/query.ts', 'export function queryCode() { return 1; }\n');
  write('src/real.ts', 'export class Real { constructor() {} }\n');
  write('tests/real.test.ts', 'export class Test { constructor() {} }\n');
  write('__tests__/fixtures/fake.ts', 'export class Fake { constructor() {} }\n');
  write('tests/personal-runtime.test.ts', 'export const spawnedCliTest = 1;\n');
  write('large.md', 'largeNeedle\n' + 'x'.repeat(270000));
  write('huge.md', 'hugeNeedle\n' + 'x'.repeat(2 * 1024 * 1024));
  git('init', '-b', 'main');
  git('config', 'user.name', 'CodeGraph Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-m', 'fixture');
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 30000);

afterAll(() => {
  handler?.closeAll();
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('MCP experience regressions', () => {
  it('keeps full long exploration text on the wire and structured modes unchanged', async () => {
    const text = 'source line\n'.repeat(2000);
    const result = { content: [{ type: 'text', text }], structuredContent: { kind: 'explore', rendered: { text: null } } };
    const engine = { hasDefaultCodeGraph: () => true, getToolHandler: () => ({ execute: async () => result }) } as unknown as MCPEngine;
    let deliver: (message: any) => Promise<void>;
    const sent: any[] = [];
    const transport = { start: (callback: typeof deliver) => { deliver = callback; }, sendResult: (_id: unknown, body: unknown) => sent.push(body) } as unknown as JsonRpcTransport;
    new MCPSession(transport, engine).start();
    for (const mode of [undefined, 'explore', 'definitions']) {
      await deliver!({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query: 'name', mode } } });
    }
    expect(sent[0]).toEqual({ content: result.content });
    expect(sent[1]).toEqual({ content: result.content });
    expect(sent[2]).toBe(result);
  });

  it('ranks production definitions before tests and fixtures', () => {
    const result = cg.queryCode({ mode: 'definitions', query: 'constructor' });
    expect(result.items.map((item: any) => item.filePath)).toEqual(['src/real.ts', 'tests/real.test.ts', '__tests__/fixtures/fake.ts']);
  });

  it('ranks the affected definition and direct callers before distant dependents', () => {
    const result = cg.queryCode({ mode: 'impact', query: 'runtimeBuildIdentity', limit: 1 });
    expect(result.items[0]).toMatchObject({ name: 'runtimeBuildIdentity', distance: 0 });
    const all = cg.queryCode({ mode: 'impact', query: 'runtimeBuildIdentity' }).items as ImpactItem[];
    expect(all.map((item) => item.distance)).toEqual(all.map((item) => item.distance).sort((a, b) => a - b));
  });

  it('suggests a mistyped symbol without resolving or editing it', async () => {
    const result = cg.queryCode({ mode: 'definitions', query: 'runtimeBuildIdentty' });
    expect(result.status).toBe('not_found');
    expect(result.items).toEqual([]);
    expect(result.warnings.join('\n')).toContain('runtimeBuildIdentity');
    const guessed = cg.queryCode({ mode: 'definitions', query: 'runCodeQuery' });
    expect(guessed.status).toBe('not_found');
    expect(guessed.warnings.join('\n')).toContain('queryCode');
    expect((await cg.editCode({ operation: 'replace-body', symbol: 'runtimeBuildIdentty', content: 'bad' })).canApply).toBe(false);
  });

  it('reports filename-only tests separately from graph-confirmed dependencies', () => {
    const result = cg.queryCode({ mode: 'tests', query: 'src/runtime-info.ts' });
    expect(result.filenameCandidates).toContainEqual({ filePath: 'tests/personal-runtime.test.ts', reason: 'filename', confidence: 'low', distance: null });
    expect(result.items.some((item: any) => item.filePath === 'tests/personal-runtime.test.ts')).toBe(false);
  });

  it('reports HEAD on ordinary queries and refreshes it on status', () => {
    const first = cg.queryCode({ mode: 'definitions', query: 'runtimeBuildIdentity' });
    expect(first.index?.currentCommit).toBe(git('rev-parse', 'HEAD'));
    git('commit', '--allow-empty', '-m', 'next');
    const status = cg.queryCode({ mode: 'status', query: 'status' });
    expect(status.index?.currentCommit).toBe(git('rev-parse', 'HEAD'));
    expect(status.index?.currentCommit).not.toBe(first.index?.currentCommit);
  });

  it('finds literal substrings and bounded large files, warning about unsearched files', () => {
    expect(cg.queryCode({ mode: 'text', query: 'BuildIdentity', file: 'src/runtime-info.ts' }).page.total).toBe(1);
    const large = cg.queryCode({ mode: 'text', query: 'largeNeedle', file: 'large.md' });
    expect(large.items[0]).toMatchObject({ filePath: 'large.md', lines: [{ line: 1, text: 'largeNeedle' }] });
    expect(large.warnings.join('\n')).not.toContain('were not searched');
    const huge = cg.queryCode({ mode: 'text', query: 'hugeNeedle', file: 'huge.md' });
    expect(huge.warnings.join('\n')).toContain('1 large or unreadable file(s) were not searched');
  });

  it('does not report symbol or edge changes for shifted lines or CRLF conversion', async () => {
    try {
      for (const content of ['// New heading\n' + source, source.replace(/\n/g, '\r\n')]) {
        write('src/runtime-info.ts', content);
        const result = await analyzeChangeContext(cg, { candidateFiles: ['src/runtime-info.ts'] });
        expect(result?.symbols).toEqual([]);
        expect(result?.edges).toEqual([]);
      }
      write('src/runtime-info.ts', source.replace('return 1', 'return 2'));
      const result = await analyzeChangeContext(cg, { candidateFiles: ['src/runtime-info.ts'] });
      expect(result?.symbols.map((symbol) => symbol.name)).toEqual(['runtimeBuildIdentity']);
      const explore = await handler.execute('codegraph_explore', { query: 'runtimeBuildIdentity' });
      expect(explore.content[0].text).not.toContain('**Change context**');
    } finally { write('src/runtime-info.ts', source); }
  });

  it('normalizes CRLF edit input to the LF file before preview', async () => {
    const result = await cg.editCode({ operation: 'replace-body', symbol: 'runtimeBuildIdentity', content: 'export function runtimeBuildIdentity() {\r\n  return 3;\r\n}' });
    expect(result.canApply).toBe(true);
    expect(result.files[0].edits[0].newText).not.toContain('\r');
    expect(fs.readFileSync(path.join(root, 'src/runtime-info.ts'), 'utf8')).toBe(source);
  });

  it('requires code-shaped tokens for hook candidates', () => {
    expect(extractCodeTokens('帮我分析一下这顿晚饭怎么搭配')).toEqual([]);
    expect(extractCodeTokens('请介绍一下截图 screenShot.png')).toEqual([]);
    expect(extractCodeTokens('检查 src/runtime-info.ts')).toContain('src/runtime-info.ts');
    expect(extractCodeTokens('runtimeBuildIdentity 的调用方')).toContain('runtimeBuildIdentity');
  });

  it('runs the source CLI hook quietly for chat and emits structured exploration JSON', () => {
    const repo = path.resolve(__dirname, '..');
    const runner = path.join(repo, 'node_modules/vite-node/vite-node.mjs');
    const cli = path.join(repo, 'src/bin/codegraph.ts');
    const env = { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_SHARED_SERVICE: '0', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' };
    const chat = spawnSync(process.execPath, [runner, cli, 'prompt-hook'], {
      cwd: repo, env, windowsHide: true, encoding: 'utf8', timeout: 30000,
      input: JSON.stringify({ cwd: root, prompt: '帮我分析一下这顿晚饭怎么搭配 screenShot.png' }),
    });
    expect(chat.status, chat.stderr).toBe(0);
    expect(chat.stdout).toBe('');
    const explore = spawnSync(process.execPath, [runner, cli, 'explore', 'runtimeBuildIdentity', '--json', '-p', root], {
      cwd: repo, env, windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    expect(explore.status, explore.stderr).toBe(0);
    expect(JSON.parse(explore.stdout)).toMatchObject({ kind: 'explore', source: { files: expect.arrayContaining(['src/runtime-info.ts']) } });
  }, 65000);

  it('visits impact edges linearly when deriving via kinds', () => {
    let accesses = 0;
    const nodes = new Map<string, Node>([['root', { id: 'root' } as Node]]);
    const edges = Array.from({ length: 1000 }, (_, i) => {
      const id = `node${i}`;
      nodes.set(id, { id } as Node);
      return { get source() { accesses++; return id; }, target: 'root', kind: 'calls' } as Edge;
    });
    const fake = { getImpactRadius: () => ({ nodes, edges }) } as unknown as CodeGraph;
    const result = analyzeImpact(fake, [nodes.get('root')!], 2);
    expect(result.entries.size).toBe(1001);
    expect(result.entries.get('node999')?.via).toEqual(['calls']);
    expect(accesses).toBeLessThan(10000);
  });

  it('classifies each unique test once across converging changed files', () => {
    const getRoot = vi.fn(() => root);
    const fake = { getProjectRoot: getRoot, getFileDependents: () => ['tests/personal-runtime.test.ts'], getFiles: () => [] } as unknown as CodeGraph;
    const result = findAffectedTests(fake, Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`), { depth: 5 });
    expect(result.tests).toHaveLength(1);
    expect(getRoot).toHaveBeenCalledTimes(1);
  });
});
