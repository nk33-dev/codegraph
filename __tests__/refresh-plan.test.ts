/**
 * Refresh scope from actual changes: a body-only edit stays inside the file, while a changed export
 * surface or import block pulls in exactly the dependents the resolver already knows about — not
 * the whole project, and not every file that merely contains the word "export".
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planRefresh, type RefreshSources, type RefreshSymbol } from '../src/sync/refresh-plan';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-refresh-plan-'));

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const symbol = (qualifiedName: string, kind: string, startLine: number, isExported = true): RefreshSymbol =>
  ({ qualifiedName, kind, isExported, startLine });

function sources(options: {
  previous: string | null;
  before?: RefreshSymbol[];
  after?: RefreshSymbol[];
  dependents?: string[];
}): RefreshSources {
  return {
    indexedText: () => options.previous,
    indexedSymbols: () => options.before ?? [],
    extractSymbols: () => options.after ?? [],
    dependents: () => options.dependents ?? [],
  };
}

let counter = 0;
function plan(content: string, src: RefreshSources, file = `f${counter++}.ts`) {
  fs.writeFileSync(path.join(ROOT, file), content);
  return planRefresh(ROOT, file, src);
}

describe('refresh plan scope', () => {
  it('keeps a body-only change inside the file', () => {
    const before = [symbol('run', 'function', 1)];
    const result = plan(
      'export function run() { return 2; }\n',
      sources({ previous: 'export function run() { return 1; }\n', before, after: before }),
    );

    expect(result).toMatchObject({ scope: 'file', taskLevel: 'ordinary' });
    expect(result.reason).toContain('body-level');
    expect(result.files).toBeUndefined();
  });

  it('keeps a multi-line body change inside the file', () => {
    const before = [symbol('run', 'function', 1)];
    const result = plan(
      'export function run() {\n  return 2;\n}\n',
      sources({ previous: 'export function run() {\n  return 1;\n}\n', before, after: before }),
    );

    expect(result.scope).toBe('file');
  });

  it('widens to the resolved dependents when an exported signature changes', () => {
    const result = plan(
      'export function run(count: number) { return count; }\n',
      sources({
        previous: 'export function run() { return 1; }\n',
        before: [symbol('run', 'function', 1)],
        after: [symbol('run', 'function', 1)],
        dependents: ['main.ts'],
      }),
    );

    expect(result).toMatchObject({ scope: 'related', taskLevel: 'interface' });
    expect(result.files).toContain('main.ts');
    expect(result.reason).toContain('dependents');
  });

  it('widens when an exported symbol is added or removed', () => {
    const added = plan(
      'export interface Runner { run(): number }\nexport function run() { return 3; }\n',
      sources({
        previous: 'export function run() { return 3; }\n',
        before: [symbol('run', 'function', 1)],
        after: [symbol('Runner', 'interface', 1), symbol('run', 'function', 2)],
      }),
    );
    expect(added.scope).toBe('related');

    const removed = plan(
      'export function run() { return 3; }\n',
      sources({
        previous: 'export function helper() { return 1; }\nexport function run() { return 3; }\n',
        before: [symbol('helper', 'function', 1), symbol('run', 'function', 2)],
        after: [symbol('run', 'function', 1)],
      }),
    );
    expect(removed.scope).toBe('related');
  });

  it('widens when import/export lines change, even with an identical symbol set', () => {
    const run = [symbol('run', 'function', 2)];
    const result = plan(
      "import { b } from './b';\nexport function run() { return 1; }\n",
      sources({
        previous: "import { a } from './a';\nexport function run() { return 1; }\n",
        before: run,
        after: run,
        dependents: ['main.ts'],
      }),
    );

    expect(result.scope).toBe('related');
    expect(result.reason).toContain('import/export');
    // The changed file itself plus the one dependent.
    expect(result.files).toHaveLength(2);
    expect(result.files).toContain('main.ts');
  });

  it('stays local when only a private symbol changes', () => {
    const result = plan(
      'export function run() { return 1; }\n',
      sources({
        previous: 'function helper() { return 1; }\nexport function run() { return helper(); }\n',
        before: [symbol('helper', 'function', 1, false), symbol('run', 'function', 2)],
        after: [symbol('run', 'function', 1)],
      }),
    );

    expect(result.scope).toBe('file');
  });

  it('treats an unchanged file and an unindexed file as file-scoped', () => {
    const same = 'export function run() { return 1; }\n';
    const unchanged = plan(same, sources({ previous: same, before: [symbol('run', 'function', 1)] }));
    expect(unchanged).toMatchObject({ scope: 'file', taskLevel: 'ordinary' });
    expect(unchanged.reason).toContain('matches the indexed bytes');

    const unindexed = plan(same, sources({ previous: null }));
    expect(unindexed.scope).toBe('file');
    expect(unindexed.reason).toContain('no indexed snapshot');
  });

  it('treats project configuration as a project-wide refresh', () => {
    const result = planRefresh(ROOT, 'package.json', sources({ previous: null }));
    expect(result).toMatchObject({ scope: 'project', taskLevel: 'global' });
  });
});
