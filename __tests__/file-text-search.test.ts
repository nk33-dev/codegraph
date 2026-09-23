import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { ToolHandler } from '../src/mcp/tools';

describe('file text search', () => {
  let root: string;
  let graph: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-text-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export function main() { return "api.timeout"; }\n');
    fs.writeFileSync(path.join(root, 'settings.json'), '{"api.timeout": 5000}\n');
    fs.writeFileSync(path.join(root, 'build.sh'), '# api.timeout is configurable\n');
    fs.writeFileSync(path.join(root, '.env'), 'api.timeout=secret\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
  }, 30_000);

  afterEach(() => {
    graph?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds code, configuration and scripts with stable file pagination', () => {
    const first = graph.queryCode({ mode: 'text', query: 'api.timeout', limit: 2 });
    expect(first.status).toBe('ok');
    expect(first.page).toMatchObject({ total: 3, nextOffset: 2 });
    const second = graph.queryCode({ mode: 'text', query: 'api.timeout', offset: 2, limit: 2 });
    const hits = [...first.items, ...second.items] as Array<{ filePath: string; lines: Array<{ line: number }> }>;
    expect(hits.map((hit) => hit.filePath)).toEqual(['build.sh', 'settings.json', 'src/main.ts']);
    expect(hits.every((hit) => hit.lines[0]?.line === 1)).toBe(true);
    expect(second.page.nextOffset).toBeNull();
  });

  it('uses the same structured contract through MCP and handles literal punctuation', async () => {
    const handler = new ToolHandler(graph);
    const result = await handler.execute('codegraph_explore', {
      mode: 'text', query: 'api.timeout', file: 'settings.json', offset: 0, limit: 1,
    });
    expect(result.structuredContent).toMatchObject({ status: 'ok', page: { total: 1 } });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result.content[0]!.text).not.toContain('5000');
    handler.closeAll();
  });

  it('upgrades an older database and requires sync before claiming text completeness', async () => {
    graph.destroy();
    const connection = DatabaseConnection.open(getDatabasePath(root));
    connection.getDb().exec(`
      DROP TRIGGER IF EXISTS file_text_ai;
      DROP TRIGGER IF EXISTS file_text_ad;
      DROP TRIGGER IF EXISTS file_text_au;
      DROP TABLE IF EXISTS file_text_fts;
      DROP TABLE IF EXISTS file_text;
      DELETE FROM schema_versions WHERE version >= 10;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (9, 0, 'legacy');
      DELETE FROM project_metadata WHERE key = 'text_index_ready';
    `);
    connection.close();
    graph = await CodeGraph.open(root);
    expect(graph.queryCode({ mode: 'text', query: 'api.timeout' }).status).toBe('unavailable');
    await graph.sync();
    expect(graph.queryCode({ mode: 'text', query: 'api.timeout' }).page.total).toBe(3);
    graph.destroy();
    graph = await CodeGraph.open(root);
    expect(graph.queryCode({ mode: 'text', query: 'api.timeout' }).page.total).toBe(3);
  });

  it('updates changed and removed files on sync', async () => {
    fs.writeFileSync(path.join(root, 'settings.json'), '{"new.option": true}\n');
    fs.rmSync(path.join(root, 'build.sh'));
    fs.writeFileSync(path.join(root, 'README.md'), 'new.option documentation\n');
    const status = graph.queryCode({ mode: 'status', query: 'status', checkFiles: true });
    expect(status.index).toMatchObject({
      textChanges: { added: ['README.md'], modified: ['settings.json'], removed: ['build.sh'] },
      laggingFileCount: 3,
    });
    const stale = graph.queryCode({ mode: 'text', query: 'api.timeout', file: 'settings.json' });
    expect(stale.items).toMatchObject([{ freshness: 'changed', lines: [] }]);
    expect(stale.warnings).toContain('Some text matches changed after indexing; their indexed snippets were omitted. Run codegraph sync.');
    await graph.sync();
    expect(graph.queryCode({ mode: 'status', query: 'status', checkFiles: true }).index?.textChanges)
      .toEqual({ added: [], modified: [], removed: [] });
    expect(graph.queryCode({ mode: 'text', query: 'api.timeout' }).page.total).toBe(1);
    expect(graph.queryCode({ mode: 'text', query: 'new.option' }).items).toMatchObject([
      { filePath: 'README.md', lines: [{ line: 1 }] },
      { filePath: 'settings.json', lines: [{ line: 1 }] },
    ]);
  });

  it('upgrades a word FTS index transactionally and keeps literal punctuation searchable', async () => {
    graph.destroy();
    const connection = DatabaseConnection.open(getDatabasePath(root));
    const db = connection.getDb();
    db.exec(`DROP TRIGGER file_text_ai; DROP TRIGGER file_text_ad; DROP TRIGGER file_text_au;
      DROP TABLE file_text_fts;
      CREATE VIRTUAL TABLE file_text_fts USING fts5(content, content='file_text', content_rowid='rowid');
      INSERT INTO file_text_fts(file_text_fts) VALUES ('rebuild');`);
    connection.close();
    graph = await CodeGraph.open(root);
    expect(graph.queryCode({ mode: 'text', query: 'timeo' }).page.total).toBe(3);
    expect(graph.queryCode({ mode: 'text', query: 'pi.t' }).page.total).toBe(3);
    expect(graph.queryCode({ mode: 'text', query: 'ti' }).page.total).toBe(3);
  });

  it('removes large-file records after deletion and preserves redaction during live scans', async () => {
    fs.writeFileSync(path.join(root, 'large.json'), '{"secretNeedle":"private-value"}\n' + ' '.repeat(270000));
    await graph.sync();
    const result = graph.queryCode({ mode: 'text', query: 'secretNeedle', file: 'large.json' });
    expect(result.items).toMatchObject([{ source: 'disk', indexedAt: null, lines: [{ text: '[configuration value omitted]' }] }]);
    expect(JSON.stringify(result)).not.toContain('private-value');
    fs.rmSync(path.join(root, 'large.json'));
    await graph.sync();
    const removed = graph.queryCode({ mode: 'text', query: 'secretNeedle' });
    expect(removed.items).toEqual([]);
    expect(removed.warnings).toEqual([]);
  });

  it('bounds live scans and merges their matches into stable indexed pagination', async () => {
    const needle = 'budgetNeedle\n';
    fs.writeFileSync(path.join(root, 'README.md'), needle);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, `large-${i}.md`), needle + 'x'.repeat(2 * 1024 * 1024 - needle.length));
    }
    await graph.sync();
    const first = graph.queryCode({ mode: 'text', query: 'budgetNeedle', limit: 2 });
    const rest = graph.queryCode({ mode: 'text', query: 'budgetNeedle', offset: 2, limit: 10 });
    expect(first.page).toMatchObject({ total: 5, nextOffset: 2 });
    expect([...first.items, ...rest.items].map((item: any) => item.filePath))
      .toEqual(['README.md', 'large-0.md', 'large-1.md', 'large-2.md', 'large-3.md']);
    expect(first.warnings.join('\n')).toContain('1 large or unreadable file(s) were not searched');
    const narrowed = graph.queryCode({ mode: 'text', query: 'budgetNeedle', file: 'large-4.md' });
    expect(narrowed.page.total).toBe(1);
    expect(narrowed.warnings).toEqual([]);
  });
});
