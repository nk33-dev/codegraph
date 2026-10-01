import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { createDatabase } from '../src/db/sqlite-adapter';

const summarize = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
};

it.runIf(process.env.CODEGRAPH_RELIABILITY_BENCHMARK === '1')('measures Go index growth and query latency', async () => {
  const startedAt = new Date().toISOString();
  const sourceHash = createHash('sha256');
  for (const file of ['src/index.ts', 'src/extraction/index.ts', 'src/db/index.ts', 'src/db/queries.ts', 'src/db/file-text.ts']) {
    sourceHash.update(file).update(fs.readFileSync(path.resolve(__dirname, '..', file)));
  }
  const results: unknown[] = [];
  for (const count of [100, 1000, 5000]) {
    console.log(`[reliability-benchmark] Indexing ${count} Go files`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reliability-bench-'));
    const source = (i: number, revision = 0) => [
      'package reliability', '',
      `type Worker${i} struct {}`, '',
      `func (w *Worker${i}) Run${i}() int {`,
      `    return ${revision}`, '}', '',
      `func Entry${i}(w *Worker${i}) int {`,
      `    return w.Run${i}()`, '}', '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/reliability\n\ngo 1.22\n');
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(root, `service${i}.go`), source(i));
    let cg = CodeGraph.initSync(root);
    try {
      const start = performance.now();
      await cg.indexAll();
      const indexMs = performance.now() - start;
      const stats = () => {
        const dbPath = path.join(root, '.codegraph', 'codegraph.db');
        const { db } = createDatabase(dbPath, { readOnly: true });
        try {
          const n = (sql: string) => Number(db.prepare(sql).get().n);
          const bytes = (file: string) => fs.existsSync(file) ? fs.statSync(file).size : 0;
          return {
            files: n('SELECT count(*) n FROM files'),
            nodes: n('SELECT count(*) n FROM nodes'), edges: n('SELECT count(*) n FROM edges'),
            duplicates: n('SELECT count(*) n FROM (SELECT 1 FROM edges GROUP BY source,target,kind,ifnull(line,-1),ifnull(col,-1) HAVING count(*) > 1)'),
            vocabRows: n('SELECT count(*) n FROM name_segment_vocab'),
            dbBytes: bytes(dbPath), walBytes: bytes(`${dbPath}-wal`),
            allocatedBytes: Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true })),
            freePages: Number(db.pragma('freelist_count', { simple: true })),
          };
        } finally { db.close(); }
      };
      const initial = stats();
      const syncTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const begin = performance.now();
        await cg.sync();
        syncTimes.push(performance.now() - begin);
      }
      const afterSync = stats();
      expect(afterSync.nodes).toBe(initial.nodes);
      expect(afterSync.edges).toBe(initial.edges);
      const measure = async () => {
        const rows: unknown[] = [];
        for (const mode of ['explore', 'callers', 'impact']) {
          const args = mode === 'explore' ? { query: 'Entry0 Run0', depth: 2 }
            : { mode, query: 'Run0', ...(mode === 'impact' ? { depth: 2 } : {}) };
          const cold: number[] = [];
          for (let i = 0; i < 10; i++) {
            const begin = performance.now();
            const reader = CodeGraph.openSync(root, { readOnly: true });
            try {
              const result = await new ToolHandler(reader).executeReadTool('codegraph_explore', args);
              expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
              cold.push(performance.now() - begin);
            } finally { reader.destroy(); }
          }
          const handler = new ToolHandler(cg);
          const hot: number[] = [];
          for (let i = 0; i < 30; i++) {
            const begin = performance.now();
            const result = await handler.executeReadTool('codegraph_explore', args);
            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            hot.push(performance.now() - begin);
          }
          rows.push({ mode, coldConnection: summarize(cold), hot: summarize(hot) });
        }
        return rows;
      };
      const beforeQueries = await measure();
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(root, 'service0.go'), source(0, i + 10));
        await cg.sync({ paths: ['service0.go'] });
      }
      const afterEdits = stats();
      expect(afterEdits.nodes).toBe(initial.nodes);
      expect(afterEdits.edges).toBe(initial.edges);
      expect(afterEdits.duplicates).toBe(0);
      results.push({ count, lines: count * 11, indexMs, initial, afterSync, afterEdits,
        bytesPer1000Files: afterEdits.allocatedBytes * 1000 / count,
        bytesPer10000Lines: afterEdits.allocatedBytes * 10000 / (count * 11),
        noChangeSync: summarize(syncTimes), beforeQueries, afterQueries: await measure() });
      console.log(`[reliability-benchmark] Completed ${count} Go files`);
    } finally {
      cg.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const report = { startedAt, baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    sourceSha256: sourceHash.digest('hex'), platform: process.platform, node: process.version, cpu: os.cpus()[0]?.model.trim(),
    coldDefinition: 'New SQLite connection plus first query in the same warmed Node process; OS file cache is retained.',
    fixtures: 'Synthetic Go projects with unique methods and bounded fan-out; no production latency or precision claim.',
    results };
  const destination = process.env.CODEGRAPH_RELIABILITY_REPORT;
  if (destination) fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}, 600_000);
