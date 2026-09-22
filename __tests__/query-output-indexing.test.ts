import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';

describe('query output and indexing state', () => {
  let root: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-query-output-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), [
      'export function main(value: number) {',
      '  return helper(value);',
      '}',
      'function helper(value: number) { return value + 1; }',
      'const localValue = 1;',
      'class Entity {',
      '  private value = 1;',
      '  getValue() { return this.value; }',
      '}',
    ].join('\n'));
    cg = await CodeGraph.init(root, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows a newly created source file directly without adding it to graph results', async () => {
    const file = path.join(root, 'src', 'new-file.ts');
    fs.writeFileSync(file, 'export function fresh() { return 42; }\n');
    const result = await new ToolHandler(cg).execute('codegraph_node', { file: 'src/new-file.ts' });
    expect(result.content[0]!.text).toContain('unindexed');
    expect(result.content[0]!.text).toContain('fresh');
    expect(result.content[0]!.text).toContain('codegraph sync --file');
    expect(cg.getFile('src/new-file.ts')).toBeNull();

    const explore = await new ToolHandler(cg).execute('codegraph_explore', { query: 'src/new-file.ts' });
    expect(explore.content[0]!.text).toContain('unindexed');
    expect(explore.content[0]!.text).toContain('fresh');
    expect(cg.getFile('src/new-file.ts')).toBeNull();
  });

  it('accepts display filters and exposes them in the explore schema', async () => {
    const explore = tools.find((tool) => tool.name === 'codegraph_explore')!;
    expect(explore.inputSchema.properties.directory).toBeDefined();
    expect(explore.inputSchema.properties.languages).toBeDefined();
    expect(explore.inputSchema.properties.frameworks).toBeDefined();
    expect(explore.inputSchema.properties.symbolTypes).toBeDefined();
    expect(explore.inputSchema.properties.excludeTypes).toBeDefined();
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'main helper',
      directory: 'src',
      languages: ['typescript'],
      symbolTypes: ['function'],
      excludeTypes: ['field'],
      depth: 2,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('main');
  });
});
