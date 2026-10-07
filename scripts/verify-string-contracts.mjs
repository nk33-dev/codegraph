import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync, backup } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { CodeGraph } = require('../dist/index.js');
const { DatabaseConnection } = require('../dist/db/index.js');
const { QueryBuilder } = require('../dist/db/queries.js');
const { refreshFieldContracts } = require('../dist/db/field-contracts.js');
const { refreshStringRoutes } = require('../dist/db/string-routes.js');
const [outputArgument, ...projects] = process.argv.slice(2);
if (!outputArgument || !projects.length) throw new Error('Usage: node scripts/verify-string-contracts.mjs <output-directory> <indexed-project> [...]');
const output = path.resolve(outputArgument);
fs.mkdirSync(output, { recursive: true });

function snapshot(connection) {
  const db = connection.getDb();
  const counts = {};
  for (const table of ['nodes', 'edges', 'files', 'file_text', 'field_contracts']) {
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) counts[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  }
  let tableBytes = null;
  let storageWarning = null;
  try { tableBytes = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all(); }
  catch (error) { storageWarning = `dbstat unavailable: ${error.message}`; }
  return { counts, tableBytes, storageWarning,
    pageCount: db.pragma('page_count', { simple: true }), freePages: db.pragma('freelist_count', { simple: true }) };
}

function probe(cg, request) {
  const samples = [];
  let result;
  for (let i = 0; i < 6; i++) {
    const started = performance.now();
    result = cg.queryCode(request);
    samples.push(performance.now() - started);
  }
  const warm = samples.slice(1).sort((a, b) => a - b);
  return { request, status: result.status, total: result.page.total,
    coldMs: samples[0], warmP50Ms: warm[2], warmP95Ms: warm[4],
    targets: result.items.slice(0, 5).map(item => ({ name: item.name ?? item.target?.name,
      filePath: item.filePath ?? item.target?.filePath, line: item.startLine ?? item.line,
      fieldTypes: item.fieldContracts?.map(contract => contract.fieldType),
      generatedSource: item.generatedSource, evidence: item.evidence })), warnings: result.warnings };
}

const reports = [];
for (const projectArgument of projects) {
  const project = path.resolve(projectArgument);
  const sourcePath = path.join(project, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(sourcePath)) throw new Error(`No existing index: ${project}`);
  const relativeOutput = path.relative(project, output);
  if (!path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`)) {
    throw new Error('Keep verification copies outside the source project');
  }
  const copy = path.join(output, `${path.basename(project)}.db`);
  if (fs.existsSync(copy)) throw new Error(`Verification copy already exists: ${copy}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, copy); } finally { source.close(); }
  const connection = DatabaseConnection.open(copy);
  const queries = new QueryBuilder(connection.getDb());
  // Internal diagnostic construction binds copied storage to the original, read-only source tree.
  const cg = new CodeGraph(connection, queries, project);
  try {
    const before = snapshot(connection);
    const requests = [{ mode: 'definitions', query: 'officialMixApiKey' },
      { mode: 'callers', query: 'load_settings', file: 'apps/codex-plus-manager/src-tauri/src/commands.rs' },
      { mode: 'callers', query: '/settings/get' }, { mode: 'definitions', query: 'postJson' },
      { mode: 'documents', query: 'officialMixApiKey' }];
    const beforeProbes = requests.map(request => probe(cg, request));
    const started = performance.now();
    await refreshFieldContracts(connection.getDb(), queries, project);
    await refreshStringRoutes(connection.getDb(), queries, project);
    cg.resolver.initialize();
    await cg.resolver.refreshSynthesis(copy);
    const enrichmentMs = performance.now() - started;
    const after = snapshot(connection);
    const report = { project, copy, sourceDbBytes: fs.statSync(sourcePath).size,
      enrichmentMs, before, after, beforeProbes, memory: process.memoryUsage(),
      generatedSources: cg.getGeneratedSources(),
      probes: requests.map(request => probe(cg, request)) };
    reports.push(report);
    fs.writeFileSync(path.join(output, `${path.basename(project)}.json`), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ project, enrichmentMs, counts: after.counts,
      probes: report.probes.map(item => ({ mode: item.request.mode, query: item.request.query, total: item.total, warmP95Ms: item.warmP95Ms })) }) + '\n');
  } finally { cg.close(); }
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(reports.map(report => ({
  project: report.project, enrichmentMs: report.enrichmentMs,
  before: report.before.counts, after: report.after.counts, memory: report.memory,
})), null, 2));
