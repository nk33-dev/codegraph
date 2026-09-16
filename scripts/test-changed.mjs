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

for (const file of changed) {
  if (file.endsWith('.test.ts')) selected.add(file);
}

function withoutExtension(file) {
  return file.replace(/\.(?:[cm]?[jt]sx?|json)$/i, '').replace(/\/index$/i, '');
}

function importsFile(test, changedFile) {
  const text = fs.readFileSync(path.join(root, test), 'utf8');
  const imports = text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g);
  const changedKey = withoutExtension(changedFile);
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const resolved = normalize(path.resolve(root, path.dirname(test), specifier));
    if (withoutExtension(resolved) === changedKey) return true;
  }
  return false;
}

for (const file of changed) {
  for (const test of tests) {
    if (importsFile(test, file)) selected.add(test);
  }
}

const impactRules = [
  [/^src\/lsp\//, /^__tests__\/lsp-.*\.test\.ts$/],
  [/^src\/edits\//, /^__tests__\/edit-.*\.test\.ts$/],
  [/^src\/installer\//, /^__tests__\/installer.*\.test\.ts$/],
  [/^src\/sync\/worktree\.ts$/, /^__tests__\/worktree-detection\.test\.ts$/],
  [/^ui\/src\//, /^__tests__\/ui-package\.test\.ts$/],
  [/^__tests__\/fixtures\/fake-lsp-server\.js$/, /^__tests__\/(?:lsp|edit-lsp)-.*\.test\.ts$/],
];

for (const file of changed) {
  for (const [sourcePattern, testPattern] of impactRules) {
    if (!sourcePattern.test(file)) continue;
    for (const test of tests) if (testPattern.test(test)) selected.add(test);
  }
}

const files = [...selected].sort();
console.log(`[test:changed] 变更文件 ${changed.length} 个，选择测试文件 ${files.length} 个。`);
for (const file of files) console.log(`  ${file}`);

if (listOnly) process.exit(0);
if (files.length === 0) {
  const hasRuntimeChange = changed.some((file) => /^(?:src|ui\/src)\//.test(file));
  if (hasRuntimeChange) {
    console.error('[test:changed] 未找到直接或领域测试，请用 npm run test:focused -- <test files> 明确指定。');
    process.exit(2);
  }
  console.log('[test:changed] 仅文档、工作流或元数据变化，无需运行 Vitest。');
  process.exit(0);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', ...files], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(result.status ?? 1);
