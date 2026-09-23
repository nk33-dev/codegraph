import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Edge, Node } from '../src/types';
import { findDynamicBoundaries } from '../src/graph/dynamic-boundary-report';
import { buildFlowEvidenceReport } from '../src/graph/flow-evidence';
import { resolveNamedSymbolFlow, type NamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { ToolHandler, type ExploreStructuredContent } from '../src/mcp/tools';
import { expectWithinBudget } from './perf-utils';

let tempDir: string;
let projectRoot: string;
let cg: CodeGraph;

function nodeNamed(name: string, kind?: string): Node {
  const node = cg.getNodesByName(name).find((candidate) => !kind || candidate.kind === kind);
  expect(node, `缺少 ${kind ?? 'symbol'} ${name}`).toBeDefined();
  return node!;
}

function evidenceFixture(edges: Edge[]): { graph: CodeGraph; flow: NamedSymbolFlow } {
  const makeNode = (id: string, name: string, line: number): Node => ({
    id,
    name,
    qualifiedName: name,
    kind: 'function',
    filePath: 'src/evidence.ts',
    language: 'typescript',
    startLine: line,
    endLine: line + 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 0,
  });
  const source = makeNode('source', 'source', 1);
  const target = makeNode('target', 'target', 10);
  const graph = {
    getOutgoingEdges: (id: string) => id === source.id ? edges : [],
    getIncomingEdges: () => [],
    getNode: (id: string) => id === source.id ? source : id === target.id ? target : null,
  } as unknown as CodeGraph;
  const flow: NamedSymbolFlow = {
    tokens: ['source', 'target'],
    named: new Map([[source.id, source], [target.id, target]]),
    namedTypes: new Map(),
    dynNamed: new Map(),
    tokenNodes: new Map([['source', [source.id]], ['target', [target.id]]]),
    tokenResolved: new Map([['source', [source.id]], ['target', [target.id]]]),
    tokenFamily: new Map(),
    uniqueNamedNodeIds: new Set([source.id, target.id]),
    preciseNamedIds: new Set(),
    chains: [{
      steps: [
        { node: source, edge: null },
        { node: target, edge: edges[0]! },
      ],
      callSites: new Map([[source.id, edges[0]!.line!]]),
    }],
  };
  return { graph, flow };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-flow-evidence-'));
  projectRoot = path.join(tempDir, 'project');
  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'main.ts'),
    `export interface Sender {
  send(): void;
}

export class EmailSender implements Sender {
  send(): void {}
}

export class SmsSender implements Sender {
  send(): void {}
}

export abstract class TaskHandler {
  abstract handleTask(): void;
}

export class LocalTaskHandler extends TaskHandler {
  handleTask(): void {}
}

export class RemoteTaskHandler extends TaskHandler {
  handleTask(): void {}
}

export function finish(): void {}

export function start(): void {
  finish();
}

export function dispatch(registry: Record<string, () => void>, key: string): void {
  registry[key]();
}
`,
  );

  cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
}, 60_000);

afterAll(() => {
  cg?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('统一流证据', () => {
  it('宽泛问题中的普通英文词不伪装成断链', () => {
    const flow = resolveNamedSymbolFlow(cg, 'explain parsing lookup startup flow');
    const report = buildFlowEvidenceReport(cg, flow).report;
    expect(report.breaks.filter((item) => item.reason === 'unindexed')).toEqual([]);
    expect(report.breaks.filter((item) => item.reason === 'no_syntax_edge')).toEqual([]);
  });
  it('为静态路径保留定义位置和调用位置', () => {
    const flow = resolveNamedSymbolFlow(cg, 'start finish');
    const built = buildFlowEvidenceReport(cg, flow);
    expect(built.report.status).toBe('connected');
    expect(built.report.evidence).toHaveLength(1);
    expect(built.report.evidence[0]).toMatchObject({
      kind: 'static',
      confidence: 'confirmed',
      definitionLocation: { filePath: 'src/main.ts' },
      callLocation: { filePath: 'src/main.ts' },
      registrationLocation: null,
      synthesizedBy: null,
    });
  });

  it('区分 LSP、双方印证和启发式证据，并保留合成注册位置', () => {
    const base: Edge = { source: 'source', target: 'target', kind: 'calls', line: 4 };
    const lsp = { ...base, provenance: 'scip' as const };
    const lspFixture = evidenceFixture([lsp]);
    expect(buildFlowEvidenceReport(lspFixture.graph, lspFixture.flow).report.evidence[0]).toMatchObject({
      kind: 'lsp',
      source: 'lsp',
      confidence: 'confirmed',
    });

    const syntax = { ...base, provenance: 'tree-sitter' as const };
    const corroboratedFixture = evidenceFixture([syntax, lsp]);
    expect(buildFlowEvidenceReport(corroboratedFixture.graph, corroboratedFixture.flow).report.evidence[0]).toMatchObject({
      kind: 'corroborated',
      confidence: 'corroborated',
    });

    const heuristic: Edge = {
      ...base,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'event-bus', registeredAt: 'src/register.ts:27' },
    };
    const heuristicFixture = evidenceFixture([heuristic]);
    expect(buildFlowEvidenceReport(heuristicFixture.graph, heuristicFixture.flow).report.evidence[0]).toMatchObject({
      kind: 'heuristic',
      source: 'synthesizer',
      confidence: 'heuristic',
      registrationLocation: { filePath: 'src/register.ts', line: 27 },
      synthesizedBy: 'event-bus',
    });
  });

  it('单独查询接口时自动展开实现者并遵守候选预算', () => {
    const flow = resolveNamedSymbolFlow(cg, 'Sender');
    const built = buildFlowEvidenceReport(cg, flow, [], { maxImplementations: 1 });
    expect(built.report.implementations).toHaveLength(1);
    expect(built.report.implementations[0]).toMatchObject({
      contract: 'Sender',
      total: 2,
      truncated: true,
    });
    expect(built.report.implementations[0]!.candidates).toHaveLength(1);
    expect(built.report.implementations[0]!.candidates[0]!.relation).toBe('implements');
  });

  it('查询接口抽象方法时返回具体方法候选而不是只返回类型', () => {
    const flow = resolveNamedSymbolFlow(cg, 'send');
    const built = buildFlowEvidenceReport(cg, flow);
    const expansion = built.report.implementations.find((item) => item.contract.endsWith('Sender'));
    expect(expansion).toBeDefined();
    expect(expansion!.candidates.map((candidate) => candidate.name).sort()).toEqual([
      'EmailSender::send',
      'SmsSender::send',
    ]);
    expect(expansion!.candidates.every((candidate) => candidate.relation === 'overrides')).toBe(true);
  });

  it('抽象类与抽象方法使用同一实现者展开契约', () => {
    const typeReport = buildFlowEvidenceReport(cg, resolveNamedSymbolFlow(cg, 'TaskHandler')).report;
    expect(typeReport.implementations[0]).toMatchObject({ contract: 'TaskHandler', total: 2 });

    const methodReport = buildFlowEvidenceReport(cg, resolveNamedSymbolFlow(cg, 'handleTask')).report;
    const expansion = methodReport.implementations.find((item) => item.contract.endsWith('TaskHandler'));
    expect(expansion).toBeDefined();
    expect(expansion?.candidates.map((candidate) => candidate.name).sort()).toEqual([
      'LocalTaskHandler::handleTask',
      'RemoteTaskHandler::handleTask',
    ]);
  });

  it('把运行时键归一为 dynamic_key 断链且不把候选说成真实调用', () => {
    const dispatch = nodeNamed('dispatch', 'function');
    const flow = resolveNamedSymbolFlow(cg, 'dispatch MissingTarget');
    const boundaries = findDynamicBoundaries(cg, [dispatch], {
      named: new Map([[dispatch.id, dispatch]]),
    });
    const built = buildFlowEvidenceReport(cg, flow, boundaries);
    expect(built.report.breaks).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'dynamic_key', symbol: 'dispatch' }),
      expect.objectContaining({ reason: 'unindexed', symbol: 'MissingTarget' }),
    ]));
    expect(built.report.evidence.some((item) => item.kind === 'boundary')).toBe(true);
  });

  it('第二轮只返回新增证据但仍报告去重数量', () => {
    const flow = resolveNamedSymbolFlow(cg, 'start finish');
    const first = buildFlowEvidenceReport(cg, flow);
    const second = buildFlowEvidenceReport(cg, flow, [], {
      priorEvidenceKeys: new Set(first.observedEvidenceKeys),
    });
    expect(second.report.evidence).toEqual([]);
    expect(second.report.deduplicatedEvidence).toBe(1);
  });

  it('第二轮也不重复未索引与无连边断点', () => {
    const flow = resolveNamedSymbolFlow(cg, 'dispatch MissingTarget');
    const first = buildFlowEvidenceReport(cg, flow);
    const second = buildFlowEvidenceReport(cg, flow, [], {
      priorEvidenceKeys: new Set(first.observedEvidenceKeys),
    });
    expect(first.report.breaks.some((item) => item.reason === 'unindexed')).toBe(true);
    expect(second.report.breaks).toEqual([]);
    expect(second.report.evidence).toEqual([]);
  });

  it('统一表达候选歧义、语言边界和 LSP 不可用', () => {
    const flow = resolveNamedSymbolFlow(cg, 'dispatch finish');
    const dispatch = nodeNamed('dispatch', 'function');
    const ambiguousBoundary = [{
      node: dispatch,
      sites: [{
        form: 'computed-call',
        label: 'computed member call',
        snippet: 'registry[key]()',
        line: dispatch.startLine + 1,
        key: 'run',
        candidates: [],
        candidateNote: 'key `run` is too generic to shortlist',
      }],
    }];
    const built = buildFlowEvidenceReport(cg, flow, ambiguousBoundary, {
      lspUnavailable: 'typescript-language-server 未安装',
    });
    expect(built.report.breaks.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'ambiguous_candidates',
      'lsp_unavailable',
    ]));

    const crossLanguage = resolveNamedSymbolFlow(cg, 'dispatch finish');
    const finish = crossLanguage.named.get(nodeNamed('finish', 'function').id)!;
    crossLanguage.named.set(finish.id, { ...finish, language: 'python' });
    crossLanguage.chains = [];
    const crossReport = buildFlowEvidenceReport(cg, crossLanguage).report;
    expect(crossReport.breaks.some((item) => item.reason === 'language_boundary')).toBe(true);
  });
});

describe('codegraph_explore 证据契约', () => {
  it('文本与 structured content 同时呈现接口实现者', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Sender' });
    const structured = result.structuredContent as ExploreStructuredContent;
    expect(result.content[0]!.text).toContain('**Runtime implementations**');
    expect(structured).toMatchObject({
      schemaVersion: 1,
      kind: 'explore',
      query: 'Sender',
      projectRoot,
      evidence: { schemaVersion: 1 },
    });
    expect(structured.evidence!.implementations[0]!.total).toBe(2);
  });

  it('普通已连接路径的证据文本增长不超过 15%', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'start finish' });
    const text = result.content[0]!.text;
    const evidenceLine = text.split('\n').find((line) => line.startsWith('**Evidence**')) ?? '';
    expect(evidenceLine.length / Math.max(1, text.length - evidenceLine.length)).toBeLessThanOrEqual(0.15);
  });

  it('统一证据推导 p95 保持在 25ms 预算内', () => {
    const flow = resolveNamedSymbolFlow(cg, 'start finish');
    const samples = Array.from({ length: 100 }, () => buildFlowEvidenceReport(cg, flow).report.elapsedMs)
      .sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expectWithinBudget(p95, 25, '统一证据推导 p95');
  });
});
