/**
 * Dependency boundaries and module cycles (`codegraph architecture`).
 *
 * Two halves. The pure derivation in `src/graph/architecture.ts` is tested directly with synthetic
 * link totals, because the interesting cases (a rule that fires only on bare name matches, a cycle
 * that is not a cycle) are about which evidence is admitted and are tedious to produce by indexing.
 * The end-to-end half indexes a real fixture and asserts the report a reader actually sees:
 * violation with its `file:line` evidence, a module cycle, and a one-way dependency that is not
 * reported as one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import {
  foldModuleDependencies,
  matchBoundaryRules,
  moduleCycles,
  type ArchitectureBoundaryRule,
} from '../src/graph/architecture';
import { loadArchitectureConfig } from '../src/project-config';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-architecture-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

async function index(root: string): Promise<CodeGraph> {
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  await graph.indexAll();
  await graph.resolveReferences();
  return graph;
}

afterEach(() => {
  for (const graph of graphs.splice(0)) {
    try { graph.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  }
});

describe('module dependency folding', () => {
  it('folds the per-kind links into one entry per module pair', () => {
    const folded = foldModuleDependencies([
      { source: 'src/graph', target: 'src/bin', count: 2, declared: 2, uncertain: 0 },
      { source: 'src/graph', target: 'src/bin', count: 1, declared: 0, uncertain: 1 },
      { source: 'src/db', target: 'src/bin', count: 3, declared: 1, uncertain: 0 },
    ]);

    expect(folded).toEqual([
      { source: 'src/db', target: 'src/bin', count: 3, declared: 1, uncertain: 0 },
      { source: 'src/graph', target: 'src/bin', count: 3, declared: 2, uncertain: 1 },
    ]);
  });
});

describe('boundary rule matching', () => {
  const rules: ArchitectureBoundaryRule[] = [{ from: 'src/graph', to: 'src/bin', reason: '核心不得依赖 CLI' }];

  it('a rule matches the module itself and everything below it', () => {
    const violations = matchBoundaryRules(
      [
        { source: 'src/graph/engine', target: 'src/bin', count: 4, declared: 4, uncertain: 0 },
        { source: 'src/graph', target: 'src/bin/cli', count: 1, declared: 1, uncertain: 0 },
        { source: 'src/bin', target: 'src/graph', count: 9, declared: 9, uncertain: 0 },
      ],
      rules
    );

    expect(violations.map((violation) => `${violation.source}->${violation.target}`)).toEqual([
      'src/graph->src/bin/cli',
      'src/graph/engine->src/bin',
    ]);
    expect(violations[0]!.rule.reason).toBe('核心不得依赖 CLI');
  });

  it('with requireDeclared, a rule fires only on edges the source writes down', () => {
    const links = [
      { source: 'src/graph', target: 'src/bin', count: 7, declared: 0, uncertain: 0 },
      { source: 'src/graph', target: 'src/bin', count: 2, declared: 2, uncertain: 0 },
    ];

    expect(matchBoundaryRules(links, rules).map((violation) => violation.declared)).toEqual([2]);
    expect(matchBoundaryRules(links, rules, { requireDeclared: false })[0]!.declared).toBe(2);
    expect(matchBoundaryRules([links[0]!], rules)).toEqual([]);
    expect(matchBoundaryRules([links[0]!], rules, { requireDeclared: false })).toHaveLength(1);
  });

  it('no rules means no violations, whatever the dependencies are', () => {
    expect(matchBoundaryRules([{ source: 'a', target: 'b', count: 1, declared: 1, uncertain: 0 }], [])).toEqual([]);
  });
});

describe('module cycles', () => {
  const modulesOf = new Map([
    ['src/a/one.ts', 'src/a'],
    ['src/b/two.ts', 'src/b'],
    ['src/c/three.ts', 'src/c'],
  ]);

  it('reports a two-module cycle and leaves a one-way dependency alone', () => {
    const report = moduleCycles(
      [
        { source: 'src/a/one.ts', target: 'src/b/two.ts' },
        { source: 'src/b/two.ts', target: 'src/a/one.ts' },
        { source: 'src/a/one.ts', target: 'src/c/three.ts' },
      ],
      modulesOf
    );

    expect(report.total).toBe(1);
    expect(report.items[0]!.modules).toEqual(['src/a', 'src/b']);
    expect(report.items[0]!.files).toEqual(['src/a/one.ts', 'src/b/two.ts']);
  });

  it('a same-module edge is not a cycle', () => {
    const report = moduleCycles(
      [
        { source: 'src/a/one.ts', target: 'src/a/other.ts' },
        { source: 'src/a/other.ts', target: 'src/a/one.ts' },
      ],
      new Map([
        ['src/a/one.ts', 'src/a'],
        ['src/a/other.ts', 'src/a'],
      ])
    );

    expect(report.total).toBe(0);
    expect(report.items).toEqual([]);
  });
});

describe('architecture report over a real index', () => {
  const FIXTURE = {
    'src/core/shared.ts': 'export function sharedHelper(): number { return 1; }\n',
    'src/core/registry.ts': [
      'export class Registry {',
      '  load(id: string): string { return id; }',
      '}',
      '',
    ].join('\n'),
    'src/bin/cli.ts': [
      "import { sharedHelper } from '../core/shared';",
      'export function main(): number { return sharedHelper(); }',
      '',
    ].join('\n'),
    'src/graph/engine.ts': [
      "import { main } from '../bin/cli';",
      "import { Registry } from '../core/registry';",
      'export function run(): string {',
      '  const registry = new Registry();',
      '  return main() > 0 ? registry.load("x") : "";',
      '}',
      '',
    ].join('\n'),
    'src/cyclea/a.ts': [
      "import { fromB } from '../cycleb/b';",
      'export function fromA(): number { return fromB(); }',
      '',
    ].join('\n'),
    'src/cycleb/b.ts': [
      "import { fromA } from '../cyclea/a';",
      'export function fromB(): number { return 2; }',
      '',
    ].join('\n'),
  };

  it('reports the violated rule with its import site and the module cycle', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const graph = await index(root);

    const report = graph.getArchitectureReport({
      rules: [{ from: 'src/graph', to: 'src/bin', reason: '核心不得依赖 CLI' }],
    });

    expect(report.rules).toEqual({ configured: 1, violated: 1 });
    expect(report.modules).toBeGreaterThanOrEqual(4);
    const violation = report.violations[0]!;
    expect(violation.source).toBe('src/graph');
    expect(violation.target).toBe('src/bin');
    expect(violation.rule.reason).toBe('核心不得依赖 CLI');
    expect(violation.count).toBeGreaterThan(0);

    const evidence = violation.evidence;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]!.fromFile).toBe('src/graph/engine.ts');
    expect(evidence[0]!.toFile).toBe('src/bin/cli.ts');
    expect(evidence[0]!.line).toBeGreaterThan(0);
    expect(evidence.some((edge) => edge.declared)).toBe(true);

    expect(report.cycles.total).toBe(1);
    expect(report.cycles.items[0]!.modules).toEqual(['src/cyclea', 'src/cycleb']);
  });

  it('without rules it reports cycles only', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const graph = await index(root);

    const report = graph.getArchitectureReport();

    expect(report.rules).toEqual({ configured: 0, violated: 0 });
    expect(report.violations).toEqual([]);
    expect(report.uncertainPairs).toBe(0);
    expect(report.cycles.total).toBe(1);
  });

  it('groups at the scope the viewer would open on, and says it chose it', async () => {
    const root = makeRoot();
    write(root, FIXTURE);
    const graph = await index(root);

    // Every file lives under `src/`, so the auto rule picks it and a depth that
    // splits it into the five directories rather than one box named `src`.
    const auto = graph.getArchitectureReport();
    expect(auto.autoScope).toBe(true);
    expect(auto.root).toBe('src');
    expect(auto.depth).toBe(1);
    expect(auto.modules).toBe(5);

    // Naming a root turns the choice into the caller's, and the whole repository
    // at depth 1 is one module.
    const named = graph.getArchitectureReport({ root: '', depth: 1 });
    expect(named.autoScope).toBe(false);
    expect(named.modules).toBe(1);
  });
});

describe('architecture config loading', () => {
  it('merges the shared and local layers and drops malformed rules', () => {
    const root = makeRoot();
    write(root, {
      'codegraph.json': JSON.stringify({
        architecture: {
          root: 'src',
          depth: 3,
          boundaries: {
            deny: [
              { from: 'src/graph', to: 'src/bin', reason: '核心不得依赖 CLI' },
              { from: 'src/graph' },
              { from: 'src/db', to: 'src/ui-server' },
            ],
          },
        },
      }),
      '.codegraph/codegraph.json': JSON.stringify({
        architecture: { requireDeclared: false },
      }),
    });

    const config = loadArchitectureConfig(root);

    expect(config.root).toBe('src');
    expect(config.depth).toBe(3);
    expect(config.requireDeclared).toBe(false);
    expect(config.deny).toEqual([
      { from: 'src/graph', to: 'src/bin', reason: '核心不得依赖 CLI' },
      { from: 'src/db', to: 'src/ui-server' },
    ]);
  });

  it('a project with no architecture block gets the defaults', () => {
    const root = makeRoot();
    write(root, { 'codegraph.json': JSON.stringify({ exclude: ['vendor/'] }) });

    expect(loadArchitectureConfig(root)).toEqual({
      root: null,
      depth: null,
      minConfidence: 0.6,
      requireDeclared: true,
      deny: [],
    });
  });

  it('an out-of-range depth or confidence falls back to the default instead of the whole block', () => {
    const root = makeRoot();
    write(root, {
      'codegraph.json': JSON.stringify({ architecture: { depth: 99, minConfidence: 3 } }),
    });

    const config = loadArchitectureConfig(root);
    expect(config.depth).toBeNull();
    expect(config.minConfidence).toBe(0.6);
  });
});
