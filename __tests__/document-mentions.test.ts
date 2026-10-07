import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { analyzeChangeContext } from '../src/graph/change-context';
import { execFileSync } from 'node:child_process';
import { decideRoute } from '../src/graph/code-query-route';

let root: string;
let cg: CodeGraph | undefined;
let handler: ToolHandler | undefined;
const write = (file: string, source: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
};
const fixture = async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-documents-'));
  write('settings.rs', 'pub struct Settings { #[serde(rename="officialMixApiKey")] pub enabled: bool }\n');
  write('settings.ts', 'export function readStore() { return "decrypt configuration credentials"; }\n');
  write('docs/person/config.md', '# Settings\n`officialMixApiKey` is a boolean switch.\nreadStore decrypts configuration.\nThe settings.rs file defines the schema.\n');
  write('noise.ts', 'const prose = "officialMixApiKey";\n');
  cg = CodeGraph.initSync(root); await cg.indexAll();
  return cg;
};
afterEach(() => {
  handler?.closeAll(); handler = undefined;
  cg?.close(); cg = undefined;
  __setLoadCodeGraphForTests(null);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('document mentions and local lexical recovery', () => {
  it('finds Markdown mentions by alias, symbol and file path, without including source text', async () => {
    const graph = await fixture();
    const alias = graph.queryCode({ mode: 'documents', query: 'enabled' });
    expect(alias.items).toHaveLength(1);
    expect(alias.items[0]).toMatchObject({ kind: 'document-mention', filePath: 'docs/person/config.md', line: 2, matchedTerms: ['officialMixApiKey'] });
    expect(graph.queryCode({ mode: 'documents', query: 'settings.rs' }).items).toHaveLength(1);
    expect(graph.queryCode({ mode: 'documents', query: 'readStore', limit: 1 }).page.total).toBe(1);
    expect(decideRoute({ mode: 'documents', query: 'enabled', backend: 'auto' }, 'rust', { available: false, family: null }).resolved).toBe('graph');
  });

  it('reports stale documents and updates mentions after edits and deletion', async () => {
    const graph = await fixture();
    write('docs/person/config.md', '# Changed\nNo contract mentioned.\n');
    expect(graph.queryCode({ mode: 'documents', query: 'enabled' }).items).toEqual([]);
    await graph.sync();
    expect(graph.queryCode({ mode: 'documents', query: 'officialMixApiKey' }).items).toEqual([]);
    write('docs/new.md', 'officialMixApiKey\n');
    await graph.sync();
    expect(graph.queryCode({ mode: 'documents', query: 'enabled' }).items).toHaveLength(1);
    fs.unlinkSync(path.join(root, 'docs/new.md')); await graph.sync();
    expect(graph.queryCode({ mode: 'documents', query: 'enabled' }).items).toEqual([]);
  });

  it('recovers Chinese prose through bounded text evidence and leaves missing exact names missing', async () => {
    const graph = await fixture();
    const evidence = graph.queryTextFallback('在哪里解密配置凭证');
    expect(evidence.items.some(item => item.filePath === 'settings.ts')).toBe(true);
    expect(evidence.items.every(item => item.evidence === 'text-candidate')).toBe(true);
    expect(graph.queryTextFallback('不存在的 unknownTarget 的调用链').items).toEqual([]);
    handler = new ToolHandler(graph); __setLoadCodeGraphForTests(CodeGraph);
    const result = await handler.execute('codegraph_explore', { query: '凭证解密的具体实现在哪里' });
    expect(result.isError).toBeFalsy();
    expect(result.content.some(item => item.type === 'text' && item.text.includes('Text candidates'))).toBe(true);
  });

  it('attaches document mentions to change context', async () => {
    const graph = await fixture();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', 'settings.ts', 'settings.rs', 'docs', 'noise.ts'); git('commit', '-m', 'baseline');
    write('settings.ts', 'export function readStore() { return "decrypt changed configuration"; }\n');
    const context = await analyzeChangeContext(graph);
    expect(context?.relatedDocuments?.some(mention => mention.filePath === 'docs/person/config.md' && mention.line === 3)).toBe(true);
  });

  it('keeps manifest guidance ahead of lexical candidates mentioning its path', async () => {
    const graph = await fixture();
    const manifest = 'assets/inject/renderer-inject/manifest.json';
    write(manifest, '{"fragments": [{"name": "part.js"}]}\n');
    write('docs/assembly.md', `Assembly reads ${manifest}.\n`);
    await graph.sync();
    expect(graph.queryTextFallback(manifest).items.length).toBeGreaterThan(0);
    handler = new ToolHandler(graph); __setLoadCodeGraphForTests(CodeGraph);
    const result = await handler.execute('codegraph_explore', { query: manifest });
    const output = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    expect(output).toContain('mode:"text"');
    expect(output).toContain('generatedSources');
    expect(output).not.toContain('Text candidates found');
  });
});
