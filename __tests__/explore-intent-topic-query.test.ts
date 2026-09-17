/** Natural-language intent words must not become fuzzy-search targets. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { removeQueryIntentWords, stripQueryIntentWords } from '../src/search/query-intent';

describe('codegraph_explore intent words', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-intent-query-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'callers.ts'),
      'export function callerFn() { return 1; }\n' +
      'export function jsCaller() { return callerFn(); }\n' +
      'export function emitCode() { return jsCaller(); }\n' +
      'export function relatedHelper() { return emitCode(); }\n',
    );
    fs.writeFileSync(path.join(src, 'lookup.ts'),
      'export function search(term: string) { return term.length; }\n' +
      'export function code(id: number) { return id + 1; }\n',
    );
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 30_000);

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns no relevant code for an unknown target plus English intent words', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'Widget render callers and related code',
    });
    const output = result.content[0].text;
    expect(output).toContain('No relevant code found for "Widget render callers and related code"');
    expect(output).not.toMatch(/callerFn|jsCaller|relatedHelper|Found \d+ symbols/);
  });

  it('keeps Chinese intent words out of retrieval too', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'Widget render 的调用方和相关代码',
    });
    expect(result.content[0].text).toContain('No relevant code found for');
    expect(result.content[0].text).not.toContain('callerFn');
  });

  it('still focuses an exact symbol and preserves symbols named like intent words', async () => {
    const focused = await handler.execute('codegraph_explore', {
      query: 'callerFn callers and related code',
    });
    expect(focused.content[0].text).toContain('callerFn');

    const namedSearch = await handler.execute('codegraph_explore', { query: 'search callers' });
    expect(namedSearch.content[0].text).toContain('export function search');
    expect(namedSearch.content[0].text).not.toContain('No relevant code found');
  });

  it('removes only intent words while preserving qualified-name punctuation', () => {
    expect(removeQueryIntentWords('Widget render callers and related code')).toBe('Widget render');
    expect(removeQueryIntentWords('View.render 的调用方')).toBe('View.render');
    expect(removeQueryIntentWords('mod:fn/2 definition')).toBe('mod:fn/2');
    expect(removeQueryIntentWords('search callers', (word) => word === 'search')).toBe('search');
    expect(removeQueryIntentWords('callers and related code')).toBe('');
  });

  it('shares vocabulary with topic-presence checks', () => {
    for (const query of ['runUpgrade definition', 'Widget render callers', '获取用户列表 的调用方']) {
      expect(stripQueryIntentWords(query).trim()).toBe(removeQueryIntentWords(query).trim());
    }
  });
});
