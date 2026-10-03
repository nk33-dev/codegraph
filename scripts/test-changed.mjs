#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const listOnly = process.argv.includes('--list');
const requested = process.argv.slice(2).filter((arg) => arg !== '--list');

const normalize = (file) => path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');

function gitLines(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles() {
  if (requested.length > 0) return requested.map(normalize);
  const working = new Set([
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ]);
  if (working.size > 0) return [...working].map(normalize);
  return gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD^', 'HEAD']).map(normalize);
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.name.endsWith('.test.ts')) files.push(normalize(absolute));
  }
  return files;
}

const tests = walk(path.join(root, '__tests__'));
const selected = new Set();
const changed = changedFiles();
const testSources = new Map(tests.map((test) => [test, fs.readFileSync(path.join(root, test), 'utf8')]));

for (const file of changed) {
  if (file.endsWith('.test.ts')) selected.add(file);
}

function withoutExtension(file) {
  return file.replace(/\.(?:[cm]?[jt]sx?|json)$/i, '').replace(/\/index$/i, '');
}

function importedFiles(test) {
  const text = testSources.get(test);
  const imports = text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g);
  const imported = new Set();
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const resolved = normalize(path.resolve(root, path.dirname(test), specifier));
    imported.add(withoutExtension(resolved));
  }
  return imported;
}

const changedKeys = new Set(changed.map(withoutExtension));
for (const test of tests) {
  if ([...importedFiles(test)].some((file) => changedKeys.has(file))) selected.add(test);
}

const impactRules = [
  [/^src\/lsp\//, /^__tests__\/lsp-.*\.test\.ts$/],
  [/^src\/edits\//, /^__tests__\/edit-.*\.test\.ts$/],
  [/^src\/installer\//, /^__tests__\/installer.*\.test\.ts$/],
  [/^src\/sync\/worktree\.ts$/, /^__tests__\/worktree-detection\.test\.ts$/],
  [/^ui\/src\//, /^__tests__\/ui-package\.test\.ts$/],
  [/^__tests__\/fixtures\/fake-lsp-server\.js$/, /^__tests__\/(?:lsp|edit-lsp)-.*\.test\.ts$/],
  // The architecture report reads project config and adds a query of its own; the direct-import
  // graph does not connect either file to the report's test.
  [/^src\/(?:project-config|db\/queries)\.ts$/, /^__tests__\/(?:architecture|project-config|query-cache).*\.test\.ts$/],
  // The read memos and the detector language gate span the resolver, the extractor and the query
  // layer; only `db/queries` is a direct relative import of query-cache.test.ts, so the files that
  // own the caches it describes have to be named here.
  [/^src\/(?:extraction\/index|resolution\/index|resolution\/import-resolver|resolution\/frameworks\/[^/]+)\.ts$/, /^__tests__\/query-cache\.test\.ts$/],
  // The store window's accounting lives next to the writer that uses it, and the budget comes from
  // the resource profile; neither file is imported by the test that pins the semantics.
  [/^src\/(?:extraction\/(?:store-writer|index)|resource-profile)\.ts$/, /^__tests__\/(?:store-window|resource-profile)\.test\.ts$/],
  // The Cargo manifest reader is shared by the resolver and the rust build context; the node render
  // test covers the seam that puts the context into output.
  [/^src\/(?:cargo-manifest|graph\/rust-context)\.ts$/, /^__tests__\/(?:rust-context|cli-node-command|node-file-view)\.test\.ts$/],
  // The end-to-end baseline pins what extraction, resolution and persistence actually wrote. None
  // of the three is a direct relative import of the test, so the import graph cannot reach it —
  // and this is precisely the test a parser, resolver or schema change should run.
  [/^src\/(?:extraction|resolution|db)\//, /^__tests__\/graph-baseline\.test\.ts$/],
  [/^__tests__\/fixtures\/graph-baseline\//, /^__tests__\/graph-baseline\.test\.ts$/],
];

for (const file of changed) {
  for (const [sourcePattern, testPattern] of impactRules) {
    if (!sourcePattern.test(file)) continue;
    for (const test of tests) if (testPattern.test(test)) selected.add(test);
  }
}

// Tests that spawn the built CLI cannot run without dist/; skip them visibly instead of
// letting a missing build show up as dozens of unrelated failures.
const builtCli = path.join(root, 'dist', 'bin', 'codegraph.js');
const needsBuiltCli = (test) =>
  /dist[\\/]bin|['"]dist['"]\s*,\s*['"]bin['"]/.test(testSources.get(test));
const cliMissing = !fs.existsSync(builtCli);
const skippedForBuild = cliMissing ? [...selected].filter(needsBuiltCli).sort() : [];
for (const test of skippedForBuild) selected.delete(test);

const files = [...selected].sort();
console.log(`[test:changed] 变更文件 ${changed.length} 个，选择测试文件 ${files.length} 个。`);
for (const file of files) console.log(`  ${file}`);
if (skippedForBuild.length > 0) {
  console.log(`[test:changed] 未找到 dist/bin/codegraph.js，跳过 ${skippedForBuild.length} 个依赖构建产物的测试（未运行，不算通过）：`);
  for (const file of skippedForBuild) console.log(`  - ${file}`);
  console.log('[test:changed] 这些测试留给 CI，或在本地构建后用 npm run test:focused -- <test files> 运行。');
}

if (listOnly) process.exit(0);
if (files.length === 0) {
  if (skippedForBuild.length > 0) {
    console.log('[test:changed] 选中的测试都依赖构建产物，本次没有运行任何 Vitest。');
    process.exit(0);
  }
  const hasRuntimeChange = changed.some((file) => /^(?:src|ui\/src)\//.test(file));
  if (hasRuntimeChange) {
    console.error('[test:changed] 未找到直接或领域测试，请用 npm run test:focused -- <test files> 明确指定。');
    process.exit(2);
  }
  console.log('[test:changed] 仅文档、工作流或元数据变化，无需运行 Vitest。');
  process.exit(0);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const projects = ['--project', 'engine', '--project', 'ui'];
const result = spawnSync(process.execPath, [vitest, 'run', ...files, ...projects], {
  cwd: root,
  // vitest.config.mts runs __tests__/global-setup-dist.ts (which rebuilds the engine and
  // the viewer when stale) unless this is set. The quick path is deliberately not a build:
  // suites that need dist/ were listed and skipped above, and the full `npm test` builds.
  env: { ...process.env, CODEGRAPH_SKIP_TEST_BUILD: '1' },
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(result.status ?? 1);
