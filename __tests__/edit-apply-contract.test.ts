/**
 * `codegraph_edit` direct-apply contract and post-edit index completeness.
 * Direct apply is intentional; preview hash and operation ID are optional bindings.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { editTools } from '../src/mcp/edit-tool';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
const SERVICE = 'export function run() {\n  return 1;\n}\n';
const API = [
  'export interface Envelope<T> { data: T; }',
  'export function mapAll<T, U>(list: T[], fn: (item: T) => U): U[] {',
  '  return list.map(fn);',
  '}',
  '',
].join('\n');
const CONSUMER = [
  `import { mapAll } from './api';`,
  'export function runAll() {',
  '  return mapAll([1, 2], (n) => n * 2);',
  '}',
  '',
].join('\n');

let root: string;
let cg: CodeGraph;
let handler: ToolHandler;

const write = (file: string, value: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), value);
};
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf-8');
const cli = (args: string[]) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf-8', windowsHide: true,
  env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apply-contract-'));
  write('a/service.ts', SERVICE);
  write('b/api.ts', API);
  write('b/consumer.ts', CONSUMER);
  cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 30_000);

afterEach(() => {
  cg?.unwatch();
  handler?.closeAll();
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codegraph_edit direct apply contract', () => {
  it('describes IDs as optional preview bindings', () => {
    const tool = editTools.find((item) => item.name === 'codegraph_edit')!;
    // P0 问题 2：参数绑定语义写在 schema 与初始化说明里，工具描述只保留「一句话定位 +
    // 何时使用」，所以这里断言它不再复述 apply/previewHash/operationId 的用法。
    expect(tool.description).not.toMatch(/Direct apply:true needs no IDs|with both ids/i);
    expect(tool.description).toMatch(/Previews by default/i);
    expect(tool.inputSchema.properties.apply.description).toMatch(/IDs are optional/i);
    expect(tool.inputSchema.properties.expectPreviewHash.description).toMatch(/optional.*bind/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Direct .*apply:true.*needs no IDs/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/with both ids/i);
  });

  it('applies without IDs and refreshes the index', async () => {
    const applied = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 42; }', apply: true,
    });

    expect(applied.status).toBe('applied');
    expect(applied.applied).toMatchObject({ files: ['a/service.ts'], indexSynced: true });
    expect(read('a/service.ts')).toBe('export function run() { return 42; }\n');
  });

  it('enforces provided preview and operation bindings', async () => {
    const request = {
      operation: 'replace-body' as const, symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 7; }',
    };
    const preview = await cg.editCode(request);
    const badHash = await cg.editCode({
      ...request, apply: true, expectPreviewHash: 'deadbeef', operationId: preview.operationId!,
    });
    expect(badHash.status).toBe('conflict');
    expect(read('a/service.ts')).toBe(SERVICE);

    const bound = await cg.editCode({
      ...request, apply: true,
      expectPreviewHash: preview.previewHash!, operationId: preview.operationId!,
    });
    expect(bound.status).toBe('applied');

    const foreignContent = await cg.editCode({
      operation: 'replace-body', symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 8; }', apply: true,
      operationId: preview.operationId!,
    });
    expect(foreignContent.status).toBe('conflict');
    expect(read('a/service.ts')).toBe('export function run() { return 7; }\n');
  });

  it('replays a terminal operation without overwriting later external edits', async () => {
    const request = {
      operation: 'replace-body' as const, symbol: 'run', file: 'a/service.ts',
      content: 'export function run() { return 9; }',
    };
    const preview = await cg.editCode(request);
    const bound = {
      ...request, apply: true,
      expectPreviewHash: preview.previewHash!, operationId: preview.operationId!,
    };
    expect((await cg.editCode(bound)).status).toBe('applied');
    const afterFirst = read('a/service.ts');
    write('a/service.ts', '// drifted by someone else\n' + afterFirst);

    const replay = await cg.editCode(bound);
    expect(replay.status).toBe('applied');
    expect(read('a/service.ts')).toBe('// drifted by someone else\n' + afterFirst);
    expect(replay.warnings.join(' ')).toMatch(/already terminal/);
  });

  it('supports direct CLI apply and rejects a supplied wrong hash', () => {
    const base = ['edit', 'run', '--operation', 'replace-body', '--file', 'a/service.ts', '-p', root];
    const applied = cli([...base, '--content', 'export function run() { return 3; }', '--apply']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout.trim())).toMatchObject({
      status: 'applied', applied: { files: ['a/service.ts'], indexSynced: true },
    });

    const refused = cli([
      ...base, '--content', 'export function run() { return 4; }',
      '--apply', '--expect-preview-hash', 'deadbeef', '--operation-id', 'cli-contract-1',
    ]);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ status: 'conflict' });
    expect(read('a/service.ts')).toBe('export function run() { return 3; }\n');
  });

  it('makes new symbols and call edges queryable from a fresh process after CLI apply', () => {
    const applied = cli([
      'edit', 'runAll', '--operation', 'replace-body', '--file', 'b/consumer.ts', '-p', root,
      '--content', [
        'export function runAll() {',
        '  return mapAll([1, 2], (n) => n * 3);',
        '}',
        'export function runTwice() {',
        '  return runAll() + runAll();',
        '}',
      ].join('\n'),
      '--apply',
    ]);

    expect(applied.status, applied.stderr).toBe(0);
    const payload = JSON.parse(applied.stdout.trim());
    expect(payload).toMatchObject({ status: 'applied', applied: { indexSynced: true } });
    expect(payload.applied.warnings.join(' ')).not.toMatch(/Failed to get parser/);

    const symbols = cli(['query', 'runTwice', '--json', '-p', root]);
    expect(symbols.status, symbols.stderr).toBe(0);
    const hits = JSON.parse(symbols.stdout.trim()) as Array<{ node: { name: string } }>;
    expect(hits.map((hit) => hit.node.name)).toContain('runTwice');

    const callers = cli(['callers', 'runAll', '-p', root]);
    expect(callers.status, callers.stderr).toBe(0);
    expect(callers.stdout).toContain('runTwice');
    const callees = cli(['callees', 'runAll', '-p', root]);
    expect(callees.status, callees.stderr).toBe(0);
    expect(callees.stdout).toContain('mapAll');
  });
});
