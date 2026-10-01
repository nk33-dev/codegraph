import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { QueryBuilder } from '../src/db/queries';
import { ToolHandler } from '../src/mcp/tools';

let root = '';
let cg: CodeGraph | undefined;
let handler: ToolHandler | undefined;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
async function setup(withGit = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-trust-'));
  fs.writeFileSync(path.join(root, 'service.ts'), 'export function work() { return 1; }');
  if (withGit) {
    git('init'); git('add', 'service.ts');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  }
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
  return (cg as unknown as { queries: QueryBuilder }).queries;
}
afterEach(() => {
  handler?.closeAll(); cg?.close(); cg = undefined; handler = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('index trust in query results', () => {
  it('separates verified commits, unchanged files without provenance, unverified, and drift', async () => {
    const queries = await setup(true);
    expect(cg!.queryCode({ mode: 'status', query: '' }).index?.revision).toBe('verified');
    queries.setMetadata('index_commit', '');
    expect(cg!.getIndexStatus().revision).toBe('files-current');
    expect(cg!.queryCode({ mode: 'definitions', query: 'work' }).index).toMatchObject({ revision: 'unverified', freshness: 'unverified' });
    expect(cg!.queryCode({ mode: 'status', query: '', checkFiles: true }).index?.revision).toBe('files-current');
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function work() { return 123456; }');
    expect(cg!.queryCode({ mode: 'status', query: '', checkFiles: true }).index?.revision).toBe('stale');
    queries.setMetadata('index_commit', 'different-commit');
    expect(cg!.queryCode({ mode: 'definitions', query: 'work' }).index?.revision).toBe('stale');
  });

  it('reports pending counts and scope in structured modes and MCP text, even with no callers', async () => {
    const queries = await setup();
    const work = cg!.getNodesByName('work')[0]!;
    queries.insertUnresolvedRefsBatch(Array.from({ length: 2500 }, (_, i) => ({
      fromNodeId: work.id, filePath: 'service.ts', referenceName: `pending${i}`, referenceKind: 'calls' as const,
      language: 'typescript' as const, line: 1, column: i,
    })));
    for (const mode of ['definitions', 'callers', 'impact', 'text', 'status'] as const) {
      const result = cg!.queryCode({ mode, query: 'work' });
      expect(result.index?.completeness).toMatchObject({ status: 'incomplete', pendingReferenceFileCount: 1, pendingReferenceFiles: ['service.ts'] });
      expect(result.warnings.join('\n')).toContain('2500 references');
      expect(result.warnings.join('\n')).toContain('Callers and impact may omit results');
    }
    for (const tool of ['codegraph_search', 'codegraph_callers', 'codegraph_impact', 'codegraph_explore']) {
      const result = await handler!.execute(tool, { query: 'work', symbol: 'work' });
      expect(result.content[0]?.text).toContain('Index incomplete:');
      expect(result.content[0]?.text).toContain('service.ts');
    }
    const status = await handler!.execute('codegraph_status', {});
    expect(status.structuredContent).toMatchObject({ index: { revision: 'files-current', completeness: { status: 'incomplete' } } });
  });

  it.each(['partial', 'failed', 'indexing'])('shows project scope for %s tasks without pending references', async state => {
    const queries = await setup();
    queries.setMetadata('index_state', state);
    queries.setMetadata('index_failure_reason', 'parser interrupted');
    const result = cg!.queryCode({ mode: 'callers', query: 'work' });
    expect(result.index?.completeness).toMatchObject({ status: 'incomplete', scope: 'project' });
    expect(result.warnings.join('\n')).toContain('parser interrupted');
    expect(result.warnings.join('\n')).toContain('empty result does not prove');
  });

  it('does not treat attempted external calls as unfinished indexing', async () => {
    await setup();
    expect(cg!.queryCode({ mode: 'status', query: '' }).index?.completeness.status).toBe('complete');
  });
});
