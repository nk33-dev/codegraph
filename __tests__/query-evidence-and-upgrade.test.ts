import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, QueryBuilder, type DatabaseConnection, type CodeReference, type CodeSymbol } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { lookupSymbolNodes, matchesSymbol, rankSymbolNodes, describeSymbolNode } from '../src/graph/symbol-lookup';
import { IndexRelationSnapshot, formatIndexRelationChanges } from '../src/graph/index-relation-delta';
import * as upgradePlanning from '../src/sync/upgrade-index';
import { FAKE_SERVER } from './lsp-test-utils';

let root: string;
let cg: CodeGraph;
let handler: ToolHandler;
const storage = () => cg as unknown as { db: DatabaseConnection; queries: QueryBuilder };
const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), body);
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-query-evidence-'));
  write('a/router.ts', 'export function router() { return 1; }\n');
  write('z/router.ts', 'export function router() { return 2; }\n');
  write('main.ts', "import { router } from './z/router';\nexport function entry() { return router(); }\nexport function dispatch(key: string) { handlers[key](); }\n");
  write('a/View.vue', '<script setup lang="ts">\nconst router = useRouter();\n</script>\n<template><div /></template>\n');
  write('z/View.vue', '<script setup lang="ts">\nconst router = useRouter();\n</script>\n<template><div /></template>\n');
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  if (cg) await cg.getLspManager().close();
  handler?.closeAll();
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('symbol context and relationship evidence', () => {
  it('keeps CLI definition labels compatible and appends a reusable selector', () => {
    const node = cg.getNodesByName('router').find(node => node.filePath === 'a/router.ts')!;
    expect(describeSymbolNode(node)).toBe('function router (typescript) — a/router.ts:1 [a/router.ts#router]');
  });

  it('lists Vue candidates with reusable selectors and narrows exact files', async () => {
    const all = cg.queryCode({ mode: 'definitions', query: 'router' });
    const vue = (all.items as CodeSymbol[]).filter((node) => node.filePath.endsWith('.vue'));
    expect(vue).toHaveLength(2);
    expect(all.ambiguous).toBe(true);
    for (const node of vue) {
      expect(node.selector).toBe(`${node.filePath}#${node.qualifiedName}`);
      expect(cg.queryCode({ mode: 'definitions', query: node.selector! })).toMatchObject({ ambiguous: false, page: { total: 1 } });
    }
    const explored = await handler.execute('codegraph_explore', { query: 'router' });
    const text = explored.content[0]?.text;
    expect(explored.structuredContent).toMatchObject({ target: { status: 'found', count: all.page.total }, coverage: { completeness: 'partial' } });
    expect(text).toContain('Ambiguous symbol');
    expect(text).toContain(vue[0]!.selector);
    expect(text).toContain(vue[1]!.selector);
    const selected = (await handler.execute('codegraph_explore', { query: vue[0]!.selector })).content[0]?.text;
    expect(selected).not.toContain('Ambiguous symbol');
    expect(selected).toContain('const router');
    expect(cg.queryCode({ mode: 'definitions', query: vue[0]!.selector!, file: vue[1]!.filePath }).page.total).toBe(0);
  });

  it('ranks import and language evidence without hiding same-name alternatives', () => {
    const contextual = cg.queryCode({ mode: 'definitions', query: 'router', contextFile: 'main.ts' });
    expect((contextual.items[0] as CodeSymbol).filePath).toBe('z/router.ts');
    expect(contextual.page.total).toBe(cg.queryCode({ mode: 'definitions', query: 'router' }).page.total);
    const nodes = lookupSymbolNodes(cg, 'router').nodes;
    const scoped = nodes.map((node, i) => ({ ...node, qualifiedName: `${i === 1 ? 'Owner' : 'Other'}::router` }));
    expect(rankSymbolNodes(cg, scoped, { scope: 'Owner' })[0]?.qualifiedName).toBe('Owner::router');
    expect(() => cg.queryCode({ mode: 'definitions', query: 'router', contextFile: '../outside.ts' })).toThrow('project root');
  });

  it('requires scope boundaries and ordered module paths', () => {
    const node = cg.getNodesByName('router').find((candidate) => candidate.filePath === 'a/router.ts')!;
    expect(matchesSymbol({ ...node, qualifiedName: 'NotOwner::router' }, 'Owner.router')).toBe(false);
    expect(matchesSymbol({ ...node, filePath: 'src/one/two/router.ts' }, 'two::one::router')).toBe(false);
    expect(matchesSymbol({ ...node, filePath: 'src/one/two/router.ts' }, 'one::two::router')).toBe(true);
  });

  it('keeps static and inferred sites separate even when both come from tree-sitter', () => {
    const entry = cg.getNodesByName('entry')[0]!;
    const router = cg.getNodesByName('router').find((node) => node.filePath === 'z/router.ts')!;
    const queries = storage().queries;
    queries.deleteEdgesBySource(entry.id);
    queries.insertEdges([
      { source: entry.id, target: router.id, kind: 'calls', line: 2, column: 10, provenance: 'tree-sitter', metadata: { resolvedBy: 'import', confidence: 0.95 } },
      { source: entry.id, target: router.id, kind: 'calls', line: 2, column: 20, provenance: 'tree-sitter', metadata: { resolvedBy: 'exact-match', confidence: 0.7 } },
    ]);
    const result = cg.queryCode({ mode: 'callees', query: 'entry' });
    expect(result.items).toHaveLength(2);
    const refs = result.items as CodeReference[];
    expect(refs.map((item) => item.confidence).sort()).toEqual(['direct', 'inferred']);
    expect(refs.map((item) => item.evidence?.source).sort()).toEqual(['exact-match', 'import']);
    expect(result.coverage).toMatchObject({ completeness: 'partial', resolvedStatic: 1, inferred: 1 });
  });

  it('reports dynamic sites and keeps zero callers distinct from a missing target', async () => {
    const result = cg.queryCode({ mode: 'callers', query: 'dispatch' });
    expect(result.target).toMatchObject({ status: 'found', count: 1 });
    expect(result.page.total).toBe(0);
    expect(result.coverage?.dynamicSites).toContainEqual(expect.objectContaining({ filePath: 'main.ts', form: 'computed-call', line: 3 }));
    expect(result.warnings.join(' ')).toContain('zero results do not prove absence');
    expect(cg.queryCode({ mode: 'callers', query: 'missingDispatch' }).target?.status).toBe('not_found');
    const text = (await handler.execute('codegraph_explore', { query: 'dispatch' })).content[0]?.text;
    expect(text).toContain('Relationship coverage — partial');
    expect(text).toContain('Possible dynamic omission');
    write('main.ts', 'export function dispatch(key: string) { somethingElse(); }\n');
    expect(cg.queryCode({ mode: 'callees', query: 'dispatch' }).coverage?.dynamicSites).toEqual([]);
  });

  it('preserves context ranking through both and labels LSP coverage', async () => {
    fs.writeFileSync(path.join(root, '.codegraph', 'lsp.json'), JSON.stringify({
      servers: { typescript: { command: process.execPath, args: [FAKE_SERVER], enabled: true } },
    }));
    const merged = await cg.queryCodeWithBackend({ mode: 'definitions', query: 'router', contextFile: 'main.ts', backend: 'both' });
    expect((merged.items[0] as CodeSymbol).filePath).toBe('z/router.ts');
    const refs = await cg.queryCodeWithBackend({ mode: 'references', query: 'dispatch', backend: 'lsp' });
    expect(refs.coverage).toMatchObject({ completeness: 'partial', basis: 'lsp', resolvedStatic: refs.page.total });
    expect(refs.coverage!.dynamicSites).toContainEqual(expect.objectContaining({ form: 'computed-call' }));
  }, 30_000);
});

describe('index upgrade relation comparison', () => {
  it('compares stable symbol identities across rebuilt node IDs and counts duplicate removal separately', () => {
    const db = storage().db.getDb();
    const queries = storage().queries;
    const router = cg.getNodesByName('router').find((node) => node.filePath === 'a/router.ts')!;
    const entry = cg.getNodesByName('entry')[0]!;
    db.exec('DROP INDEX idx_edges_identity');
    const edge = { source: entry.id, target: router.id, kind: 'references' as const, line: 2, column: 99, provenance: 'tree-sitter' as const };
    queries.insertEdge(edge);
    queries.insertEdge(edge);
    const snapshot = new IndexRelationSnapshot(db);
    const snapshotFile = (snapshot as unknown as { file: string }).file;
    expect(fs.existsSync(snapshotFile)).toBe(true);
    expect(db.pragma('temp_store', { simple: true })).toBe(2);
    try {
      db.prepare('DELETE FROM edges WHERE id = (SELECT MAX(id) FROM edges)').run();
      const newId = `${router.id}-rebuilt`;
      queries.insertNode({ ...router, id: newId });
      db.prepare('UPDATE edges SET source = ? WHERE source = ?').run(newId, router.id);
      db.prepare('UPDATE edges SET target = ? WHERE target = ?').run(newId, router.id);
      const report = snapshot.compare();
      expect(report).toMatchObject({ added: 0, removed: 0, deduplicated: 1 });
      expect(report.groups).toContainEqual(expect.objectContaining({ kind: 'references', deduplicated: 1, evidence: expect.objectContaining({ source: 'syntax', confidence: 'direct' }) }));
    } finally { snapshot.close(); }
    expect(fs.existsSync(snapshotFile)).toBe(false);
    expect(db.prepare('PRAGMA database_list').all().some((database: { name: string }) => database.name === 'relation_upgrade')).toBe(false);
  });

  it.each(['all', 'language'] as const)('reports added/deleted relations and evidence during an actual %s upgrade', async (scope) => {
    const queries = storage().queries;
    const entry = cg.getNodesByName('entry')[0]!;
    const router = cg.getNodesByName('router').find((node) => node.filePath === 'z/router.ts')!;
    queries.deleteEdgesBySource(entry.id);
    queries.insertEdge({ source: entry.id, target: router.id, kind: 'references', line: 2, column: 999, provenance: 'heuristic', metadata: { synthesizedBy: 'fixture', confidence: 'low' } });
    queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
    if (scope === 'language') {
      const assessment = upgradePlanning.planIndexUpgrade(cg);
      vi.spyOn(upgradePlanning, 'planIndexUpgrade').mockReturnValueOnce({ ...assessment, plan: { ...assessment.plan!, scope: ['typescript'] } });
    }
    const report = await cg.upgradeIndex();
    expect(report.success).toBe(true);
    expect(report.relations!.added).toBeGreaterThan(0);
    expect(report.relations!.removed).toBeGreaterThan(0);
    expect(report.relations!.groups).toContainEqual(expect.objectContaining({ kind: 'references', removed: 1, evidence: expect.objectContaining({ source: 'fixture', classification: 'runtime-candidate' }) }));
    expect(formatIndexRelationChanges(report.relations!)).toContain('source=import');
    expect(cg.isIndexStale()).toBe(false);
    expect((await cg.upgradeIndex()).relations).toBeNull();
  }, 30_000);

  it('does not advance the stamp after a partial extraction result', async () => {
    storage().queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
    const orchestrator = (cg as unknown as { orchestrator: { indexAll: (...args: unknown[]) => Promise<unknown> } }).orchestrator;
    vi.spyOn(orchestrator, 'indexAll').mockResolvedValueOnce({ success: true, filesIndexed: 1, filesSkipped: 0, filesErrored: 1,
      nodesCreated: 0, edgesCreated: 0, errors: [{ severity: 'error', message: 'fixture partial extraction' }], durationMs: 1 });
    const result = await cg.upgradeIndex();
    expect(result.success).toBe(false);
    expect(cg.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION - 1);
    expect(cg.getIndexState()).toBe('partial');
  }, 30_000);

  it('cleans up relation snapshots and releases the writer when extraction throws', async () => {
    storage().queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
    const orchestrator = (cg as unknown as { orchestrator: { indexAll: (...args: unknown[]) => Promise<unknown> } }).orchestrator;
    vi.spyOn(orchestrator, 'indexAll').mockRejectedValueOnce(new Error('fixture extraction failure'));
    await expect(cg.upgradeIndex()).rejects.toThrow('fixture extraction failure');
    expect(cg.isIndexStale()).toBe(true);
    expect(storage().db.getDb().prepare('PRAGMA database_list').all().some((database: { name: string }) => database.name === 'relation_upgrade')).toBe(false);
    expect((await cg.upgradeIndex()).success).toBe(true);
  }, 30_000);
});
