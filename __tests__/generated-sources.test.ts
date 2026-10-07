import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph, type CodeSymbol } from '../src';
import { generatedSources, generatedLocation } from '../src/graph/generated-sources';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import type { Node } from '../src/types';

let root: string;
let cg: CodeGraph | undefined;
let handler: ToolHandler | undefined;
const write = (file: string, source: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
};
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-generated-'));
  write('parts/a.js', 'function first() { return 1; }\n');
  write('parts/b.js', 'function second() { return first(); }\n');
  write('parts/manifest.json', JSON.stringify({ fragments: [{ name: 'a.js', lines: 999 }, { name: 'b.js', lines: 999 }] }));
  write('bundle.js', fs.readFileSync(path.join(root, 'parts/a.js'), 'utf8') + fs.readFileSync(path.join(root, 'parts/b.js'), 'utf8'));
  write('scripts/assemble.mjs', `import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const root = path.resolve(import.meta.dirname, '..');
const fragmentDir = path.join(root, 'parts');
const artifactPath = path.join(root, 'bundle.js');
const manifest = JSON.parse(await readFile(path.join(fragmentDir, 'manifest.json'), 'utf8'));
let assembled = '';
for (const fragment of manifest.fragments) {
 const body = await readFile(path.join(fragmentDir, fragment.name), 'utf8');
 assembled += body;
}
await writeFile(artifactPath, assembled, 'utf8');
`);
  write('src/assets.rs', 'const SCRIPT: &str = include_str!("../bundle.js");\n');
  return ['parts/a.js', 'parts/b.js', 'bundle.js', 'scripts/assemble.mjs', 'src/assets.rs'];
}
afterEach(() => {
  handler?.closeAll(); handler = undefined;
  cg?.close(); cg = undefined;
  __setLoadCodeGraphForTests(null);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('generated source evidence', () => {
  it('discovers ordered manifest assembly, measures real lines and tracks include_str consumers', () => {
    const files = fixture();
    const sources = generatedSources(root, files);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ output: 'bundle.js', status: 'verified', evidence: 'static-assembly',
      generator: 'scripts/assemble.mjs', manifest: 'parts/manifest.json', consumers: [{ filePath: 'src/assets.rs', line: 1 }] });
    expect(sources[0]!.ranges[1]).toEqual({ input: 'parts/b.js', outputStartLine: 2, outputEndLine: 2 });
  });

  it('folds duplicate definitions and retains explicit artifact queries', async () => {
    fixture();
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const result = cg.queryCode({ mode: 'definitions', query: 'second' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ filePath: 'parts/b.js', generatedSource: { output: 'bundle.js', input: 'parts/b.js', status: 'verified' } });
    expect(cg.queryCode({ mode: 'definitions', query: 'second', file: 'bundle.js' }).items).toHaveLength(1);
    handler = new ToolHandler(cg); __setLoadCodeGraphForTests(CodeGraph);
    const explore = await handler.execute('codegraph_explore', { query: 'second' });
    const text = explore.content.find(item => item.type === 'text');
    expect(text?.type === 'text' && text.text).toContain('Generated source:');
  });

  it('retains artifact coordinates when content drifts or a symbol spans inputs', () => {
    const files = fixture();
    const node = { filePath: 'bundle.js', startLine: 1, endLine: 2 } as Node;
    expect(generatedLocation(node, generatedSources(root, files))).toMatchObject({ status: 'verified', reason: expect.stringContaining('boundaries') });
    write('bundle.js', 'function second() { return 3; }\n');
    expect(generatedLocation(node, generatedSources(root, files))).toMatchObject({ status: 'drifted' });
    expect(generatedLocation(node, generatedSources(root, files))?.input).toBeUndefined();
  });

  it('supports shared configuration and a local override with malformed entries refused', async () => {
    fixture();
    write('codegraph.json', JSON.stringify({ generatedSources: [{ output: 'bundle.js', inputs: ['parts/a.js', 'parts/b.js'] }] }));
    write('.codegraph/codegraph.json', JSON.stringify({ generatedSources: [{ output: '../outside.js', inputs: ['parts/a.js'] },
      { output: 'bundle.js', inputs: ['parts/a.js', 'parts/b.js'], generator: 'scripts/assemble.mjs' }] }));
    expect(generatedSources(root, ['bundle.js'])[0]).toMatchObject({ evidence: 'configuration', status: 'verified' });
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect((cg.queryCode({ mode: 'definitions', query: 'second' }).items[0] as CodeSymbol).generatedSource?.generator).toBe('scripts/assemble.mjs');
  });

  it('invalidates source mappings when manifest order or a fragment changes', () => {
    const files = fixture();
    expect(generatedSources(root, files)[0]!.status).toBe('verified');
    write('parts/manifest.json', JSON.stringify({ fragments: [{ name: 'b.js' }, { name: 'a.js' }] }));
    expect(generatedSources(root, files)[0]!.status).toBe('drifted');
    write('parts/b.js', 'function second() { return 123; }');
    expect(generatedSources(root, files)[0]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('newline') });
  });
});
