import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { existsSync, readFileSync, statSync } from 'fs';
import { validatePathWithinRoot } from '../utils';
import type { NodeBoundary } from './dynamic-boundary-report';
import type { NamedSymbolFlow } from './named-symbol-flow';
import { countImplementers } from './type-hierarchy';
import { isSourceFile } from '../extraction/grammars';

export const FLOW_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type FlowEvidenceKind = 'static' | 'lsp' | 'corroborated' | 'heuristic' | 'boundary';
export type FlowConfidence = 'confirmed' | 'corroborated' | 'heuristic' | 'unknown';
export type FlowEvidenceSource = 'syntax' | 'graph' | 'lsp' | 'synthesizer' | 'boundary';
export type FlowBreakReason =
  | 'unindexed'
  | 'unsupported'
  | 'no_syntax_edge'
  | 'dynamic_key'
  | 'ambiguous_candidates'
  | 'language_boundary'
  | 'lsp_unavailable';

export interface FlowLocation {
  filePath: string;
  line: number;
}

export interface FlowEvidence {
  id: string;
  kind: FlowEvidenceKind;
  confidence: FlowConfidence;
  source: FlowEvidenceSource;
  definitionLocation: FlowLocation | null;
  callLocation: FlowLocation | null;
  registrationLocation: FlowLocation | null;
  synthesizedBy: string | null;
  detail: string;
}

export interface FlowBreak {
  reason: FlowBreakReason;
  at: FlowLocation | null;
  symbol: string | null;
  detail: string;
  candidateEvidenceIds: string[];
}

export interface RuntimeCandidate {
  id: string;
  name: string;
  kind: string;
  location: FlowLocation;
  relation: 'extends' | 'implements' | 'overrides';
  evidenceId: string;
}

export interface ImplementerExpansion {
  symbolId: string;
  symbol: string;
  contractId: string;
  contract: string;
  total: number;
  candidates: RuntimeCandidate[];
  truncated: boolean;
  timedOut: boolean;
}

export interface FlowEvidenceBudget {
  maxEvidence: number;
  maxBreaks: number;
  maxImplementations: number;
  maxChars: number;
  maxMs: number;
}

export interface FlowEvidenceReport {
  schemaVersion: typeof FLOW_EVIDENCE_SCHEMA_VERSION;
  status: 'connected' | 'partial' | 'unconnected';
  evidence: FlowEvidence[];
  breaks: FlowBreak[];
  implementations: ImplementerExpansion[];
  deduplicatedEvidence: number;
  truncated: boolean;
  elapsedMs: number;
  budget: FlowEvidenceBudget;
}

export interface BuildFlowEvidenceOptions extends Partial<FlowEvidenceBudget> {
  priorEvidenceKeys?: ReadonlySet<string>;
  /** 调用方已尝试 LSP 但不可用时，纳入统一断链报告。 */
  lspUnavailable?: boolean | string;
}

export interface BuiltFlowEvidence {
  report: FlowEvidenceReport;
  observedEvidenceKeys: string[];
}

export const DEFAULT_FLOW_EVIDENCE_BUDGET: FlowEvidenceBudget = {
  maxEvidence: 16,
  maxBreaks: 6,
  maxImplementations: 6,
  maxChars: 2400,
  maxMs: 25,
};

const CONTRACT_KINDS = new Set(['interface', 'trait', 'protocol']);
const HIERARCHY_KINDS = new Set(['extends', 'implements']);
const HIERARCHY_TYPE_KINDS = new Set([
  'class', 'interface', 'struct', 'trait', 'protocol', 'type_alias', 'union',
]);
const MAX_ABSTRACT_DECLARATION_FILE_CHARS = 200_000;

interface EvidenceBuildContext {
  abstractDeclarations: Map<string, boolean>;
  fileLines: Map<string, string[] | null>;
}

function location(node: Node | null | undefined, line?: number | null): FlowLocation | null {
  if (!node) return null;
  return { filePath: node.filePath, line: line && line > 0 ? line : node.startLine };
}

function metadata(edge: Edge): Record<string, unknown> {
  return (edge.metadata ?? {}) as Record<string, unknown>;
}

function registrationLocation(edge: Edge): FlowLocation | null {
  const value = metadata(edge).registeredAt;
  if (typeof value !== 'string') return null;
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match) return null;
  return { filePath: match[1]!, line: Number(match[2]) };
}

function edgeEvidence(
  cg: CodeGraph,
  from: Node,
  to: Node,
  edge: Edge,
  relation = edge.kind,
): FlowEvidence {
  let kind: FlowEvidenceKind;
  let confidence: FlowConfidence;
  let source: FlowEvidenceSource;
  const meta = metadata(edge);
  const synthesizedBy = typeof meta.synthesizedBy === 'string' ? meta.synthesizedBy : null;

  if (edge.provenance === 'heuristic' || synthesizedBy) {
    kind = 'heuristic';
    confidence = 'heuristic';
    source = 'synthesizer';
  } else if (edge.provenance === 'scip') {
    kind = 'lsp';
    confidence = 'confirmed';
    source = 'lsp';
  } else {
    let corroborated = false;
    try {
      const matching = cg.getOutgoingEdges(from.id).filter(
        (candidate) => candidate.target === to.id && candidate.kind === edge.kind,
      );
      const origins = new Set(matching.map((candidate) => candidate.provenance ?? 'graph'));
      corroborated = origins.has('scip') && origins.size > 1;
    } catch {
      corroborated = false;
    }
    kind = corroborated ? 'corroborated' : 'static';
    confidence = corroborated ? 'corroborated' : 'confirmed';
    source = edge.provenance === 'tree-sitter' ? 'syntax' : 'graph';
  }

  const call = location(from, edge.line ?? from.startLine);
  const registration = registrationLocation(edge);
  const id = [kind, from.id, to.id, edge.kind, edge.line ?? 0, synthesizedBy ?? ''].join(':');
  return {
    id,
    kind,
    confidence,
    source,
    definitionLocation: location(to),
    callLocation: call,
    registrationLocation: registration,
    synthesizedBy,
    detail: `${from.name} ${relation} ${to.name}`,
  };
}

function boundaryEvidence(report: NodeBoundary, index: number): FlowEvidence {
  const site = report.sites[index]!;
  const id = ['boundary', report.node.id, site.line, site.form, site.key ?? 'dynamic'].join(':');
  return {
    id,
    kind: 'boundary',
    confidence: 'unknown',
    source: 'boundary',
    definitionLocation: location(report.node),
    callLocation: location(report.node, site.line),
    registrationLocation: null,
    synthesizedBy: null,
    detail: site.label,
  };
}

function breakEvidence(
  reason: FlowBreakReason,
  detail: string,
  symbol: string | null,
  at: FlowLocation | null = null,
): FlowEvidence {
  return {
    id: ['break', reason, symbol ?? '', at?.filePath ?? '', at?.line ?? 0].join(':'),
    kind: 'boundary',
    confidence: 'unknown',
    source: 'boundary',
    definitionLocation: at,
    callLocation: at,
    registrationLocation: null,
    synthesizedBy: null,
    detail,
  };
}

function ownerType(cg: CodeGraph, member: Node): Node | null {
  try {
    const edge = cg.getIncomingEdges(member.id).find((candidate) => candidate.kind === 'contains');
    return edge ? cg.getNode(edge.source) : null;
  } catch {
    return null;
  }
}

function membersNamed(cg: CodeGraph, type: Node, name: string): Node[] {
  try {
    return cg.getOutgoingEdges(type.id)
      .filter((edge) => edge.kind === 'contains')
      .map((edge) => cg.getNode(edge.target))
      .filter((node): node is Node => !!node && node.name === name);
  } catch {
    return [];
  }
}

function fileLinesFor(cg: CodeGraph, node: Node, context: EvidenceBuildContext): string[] | null {
  const absPath = validatePathWithinRoot(cg.getProjectRoot(), node.filePath);
  if (!absPath) return null;
  let lines = context.fileLines.get(node.filePath);
  if (lines === undefined) {
    lines = existsSync(absPath) && statSync(absPath).size <= MAX_ABSTRACT_DECLARATION_FILE_CHARS
      ? readFileSync(absPath, 'utf8').split('\n')
      : null;
    context.fileLines.set(node.filePath, lines);
  }
  return lines;
}

function isAbstractDeclaration(cg: CodeGraph, node: Node, context: EvidenceBuildContext): boolean {
  if (node.isAbstract === true || /\babstract\b/i.test(node.signature ?? '')) return true;
  const cached = context.abstractDeclarations.get(node.id);
  if (cached !== undefined) return cached;

  let abstract = false;
  try {
    const lines = fileLinesFor(cg, node, context);
    if (lines) {
      const declaration = lines.slice(Math.max(0, node.startLine - 1), Math.min(lines.length, node.startLine + 2)).join('\n');
      abstract = /\babstract\b/i.test(declaration);
    }
  } catch {
    abstract = false;
  }
  context.abstractDeclarations.set(node.id, abstract);
  return abstract;
}

function declarationContainsMember(
  cg: CodeGraph,
  type: Node,
  memberName: string,
  context: EvidenceBuildContext,
): boolean {
  try {
    const lines = fileLinesFor(cg, type, context);
    if (!lines) return false;
    const declaration = lines.slice(
      Math.max(0, type.startLine - 1),
      Math.min(lines.length, type.endLine),
    ).join('\n');
    const escaped = memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(declaration);
  } catch {
    return false;
  }
}

function contractFor(
  cg: CodeGraph,
  node: Node,
  context: EvidenceBuildContext,
): { contract: Node; member: Node | null } | null {
  if (
    HIERARCHY_TYPE_KINDS.has(node.kind)
    && (CONTRACT_KINDS.has(node.kind) || isAbstractDeclaration(cg, node, context))
  ) {
    return { contract: node, member: null };
  }
  if (node.kind !== 'method') return null;
  const owner = ownerType(cg, node);
  if (!owner) return null;
  if (
    CONTRACT_KINDS.has(owner.kind)
    || isAbstractDeclaration(cg, owner, context)
    || isAbstractDeclaration(cg, node, context)
  ) {
    return { contract: owner, member: node };
  }
  try {
    const parents = cg.getOutgoingEdges(owner.id)
      .filter((edge) => HIERARCHY_KINDS.has(edge.kind))
      .map((edge) => cg.getNode(edge.target))
      .filter((parent): parent is Node => !!parent);
    for (const parent of parents) {
      if (!CONTRACT_KINDS.has(parent.kind) && !isAbstractDeclaration(cg, parent, context)) continue;
      if (
        membersNamed(cg, parent, node.name).length > 0
        || declarationContainsMember(cg, parent, node.name, context)
      ) {
        return { contract: parent, member: node };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function implementationExpansion(
  cg: CodeGraph,
  symbol: Node,
  budget: FlowEvidenceBudget,
  deadline: number,
  context: EvidenceBuildContext,
): { expansion: ImplementerExpansion; evidence: FlowEvidence[] } | null {
  const resolved = contractFor(cg, symbol, context);
  if (!resolved) return null;

  const { contract, member } = resolved;
  const total = countImplementers(cg, contract.id);
  if (total === 0) return null;

  let edges: Edge[] = [];
  try {
    edges = cg.getIncomingEdges(contract.id).filter((edge) => HIERARCHY_KINDS.has(edge.kind));
  } catch {
    return null;
  }

  const candidates: RuntimeCandidate[] = [];
  const evidence: FlowEvidence[] = [];
  const seenTypes = new Set<string>();
  let timedOut = false;
  for (const edge of edges) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    if (seenTypes.has(edge.source)) continue;
    seenTypes.add(edge.source);
    const subtype = cg.getNode(edge.source);
    if (!subtype) continue;
    const targets = member ? membersNamed(cg, subtype, member.name) : [subtype];
    for (const target of targets) {
      const relation = member ? 'overrides' : edge.kind as 'extends' | 'implements';
      const itemEvidence = edgeEvidence(cg, subtype, contract, edge, relation);
      itemEvidence.definitionLocation = location(target);
      itemEvidence.callLocation = null;
      itemEvidence.detail = `${target.qualifiedName || target.name} ${relation} ${contract.qualifiedName || contract.name}`;
      evidence.push(itemEvidence);
      candidates.push({
        id: target.id,
        name: target.qualifiedName || target.name,
        kind: target.kind,
        location: location(target)!,
        relation,
        evidenceId: itemEvidence.id,
      });
      if (candidates.length >= budget.maxImplementations) break;
    }
    if (candidates.length >= budget.maxImplementations) break;
  }

  return {
    expansion: {
      symbolId: symbol.id,
      symbol: member
        ? `${contract.qualifiedName || contract.name}::${member.name}`
        : (symbol.qualifiedName || symbol.name),
      contractId: contract.id,
      contract: contract.qualifiedName || contract.name,
      total,
      candidates,
      truncated: total > seenTypes.size || candidates.length >= budget.maxImplementations,
      timedOut,
    },
    evidence,
  };
}

function evidenceCost(item: FlowEvidence): number {
  return item.detail.length
    + (item.definitionLocation?.filePath.length ?? 0)
    + (item.callLocation?.filePath.length ?? 0)
    + (item.registrationLocation?.filePath.length ?? 0)
    + 96;
}

/**
 * 把已有路径、边界扫描和类型层级收敛为同一个有界证据报告。
 * 这里只读取图，不创建新边；MCP、CLI 或 UI 可以共享同一份事实再各自渲染。
 */
export function buildFlowEvidenceReport(
  cg: CodeGraph,
  flow: NamedSymbolFlow,
  boundaries: readonly NodeBoundary[] = [],
  options: BuildFlowEvidenceOptions = {},
): BuiltFlowEvidence {
  const startedAt = Date.now();
  const budget: FlowEvidenceBudget = {
    maxEvidence: options.maxEvidence ?? DEFAULT_FLOW_EVIDENCE_BUDGET.maxEvidence,
    maxBreaks: options.maxBreaks ?? DEFAULT_FLOW_EVIDENCE_BUDGET.maxBreaks,
    maxImplementations: options.maxImplementations ?? DEFAULT_FLOW_EVIDENCE_BUDGET.maxImplementations,
    maxChars: options.maxChars ?? DEFAULT_FLOW_EVIDENCE_BUDGET.maxChars,
    maxMs: options.maxMs ?? DEFAULT_FLOW_EVIDENCE_BUDGET.maxMs,
  };
  const deadline = startedAt + budget.maxMs;
  const context: EvidenceBuildContext = {
    abstractDeclarations: new Map(),
    fileLines: new Map(),
  };
  const prior = options.priorEvidenceKeys ?? new Set<string>();
  const allEvidence: FlowEvidence[] = [];
  const allBreaks: FlowBreak[] = [];
  const allImplementations: ImplementerExpansion[] = [];
  const seenEvidence = new Set<string>();
  let chars = 0;
  let truncated = false;

  const addEvidence = (item: FlowEvidence): boolean => {
    if (seenEvidence.has(item.id)) return true;
    const cost = evidenceCost(item);
    if (allEvidence.length >= budget.maxEvidence || chars + cost > budget.maxChars || Date.now() > deadline) {
      truncated = true;
      return false;
    }
    seenEvidence.add(item.id);
    allEvidence.push(item);
    chars += cost;
    return true;
  };

  const chain = flow.chains[0]?.steps ?? [];
  for (let i = 1; i < chain.length; i++) {
    const previous = chain[i - 1]!;
    const current = chain[i]!;
    if (current.edge) addEvidence(edgeEvidence(cg, previous.node, current.node, current.edge));
  }

  const pathEdgeIds = new Set(chain.slice(1).map((step) => {
    const edge = step.edge;
    return edge ? `${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? 0}` : '';
  }));
  for (const node of [...flow.named.values(), ...flow.dynNamed.values()]) {
    let incident: Edge[] = [];
    try {
      incident = [...cg.getIncomingEdges(node.id), ...cg.getOutgoingEdges(node.id)];
    } catch {
      continue;
    }
    for (const edge of incident) {
      if (edge.provenance !== 'heuristic') continue;
      if (pathEdgeIds.has(`${edge.source}:${edge.target}:${edge.kind}:${edge.line ?? 0}`)) continue;
      let from: Node | null;
      let to: Node | null;
      try {
        from = cg.getNode(edge.source);
        to = cg.getNode(edge.target);
      } catch {
        continue;
      }
      if (!from || !to) continue;
      addEvidence(edgeEvidence(cg, from, to, edge));
    }
  }

  for (const boundary of boundaries) {
    for (let index = 0; index < boundary.sites.length; index++) {
      if (allBreaks.length >= budget.maxBreaks || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const site = boundary.sites[index]!;
      const item = boundaryEvidence(boundary, index);
      addEvidence(item);
      const reason: FlowBreakReason = !site.key
        ? 'dynamic_key'
        : site.candidateNote
          ? 'ambiguous_candidates'
          : 'no_syntax_edge';
      allBreaks.push({
        reason,
        at: location(boundary.node, site.line),
        symbol: boundary.node.qualifiedName || boundary.node.name,
        detail: site.candidateNote ?? site.label,
        candidateEvidenceIds: [item.id],
      });
    }
  }

  const resolvedIds = new Set([...flow.named.keys(), ...flow.namedTypes.keys(), ...flow.dynNamed.keys()]);
  for (const token of flow.tokens) {
    if ((flow.tokenResolved.get(token)?.length ?? 0) > 0) continue;
    if (flow.tokens.length > 1 && !(/[._$]|::|[a-z][A-Z]/.test(token) || /^[A-Z]/.test(token))) continue;
    if (allBreaks.length >= budget.maxBreaks) {
      truncated = true;
      break;
    }
    const unsupported = /\.[A-Za-z0-9_-]+$/.test(token)
      && !isSourceFile(token.replace(/\\/g, '/'));
    const reason: FlowBreakReason = unsupported ? 'unsupported' : 'unindexed';
    const detail = unsupported
      ? `${token} 的文件类型不在当前索引支持范围内`
      : `索引中没有名为 ${token} 的符号`;
    const item = breakEvidence(reason, detail, token);
    addEvidence(item);
    allBreaks.push({
      reason,
      at: null,
      symbol: token,
      detail,
      candidateEvidenceIds: [item.id],
    });
  }

  if (chain.length < 2 && resolvedIds.size > 1 && allBreaks.length < budget.maxBreaks
    && (flow.tokens.length <= 2 || flow.preciseNamedIds.size >= 2)) {
    const languages = new Set(
      [...flow.named.values(), ...flow.namedTypes.values(), ...flow.dynNamed.values()].map((node) => node.language),
    );
    const reason: FlowBreakReason = languages.size > 1 ? 'language_boundary' : 'no_syntax_edge';
    const detail = languages.size > 1
      ? '已解析符号跨越语言边界，当前图中没有可确认的连接'
      : '已解析符号之间没有可确认的语法或图关系';
    const item = breakEvidence(reason, detail, null);
    addEvidence(item);
    allBreaks.push({
      reason,
      at: null,
      symbol: null,
      detail,
      candidateEvidenceIds: [item.id],
    });
  }

  if (options.lspUnavailable && allBreaks.length < budget.maxBreaks) {
    const detail = typeof options.lspUnavailable === 'string'
      ? options.lspUnavailable
      : '语言服务器不可用，当前结论仅来自索引图';
    const item = breakEvidence('lsp_unavailable', detail, null);
    addEvidence(item);
    allBreaks.push({
      reason: 'lsp_unavailable',
      at: null,
      symbol: null,
      detail,
      candidateEvidenceIds: [item.id],
    });
  }

  const implementationSeeds = new Map<string, Node>();
  for (const node of flow.namedTypes.values()) implementationSeeds.set(node.id, node);
  for (const node of flow.named.values()) implementationSeeds.set(node.id, node);
  const seenImplementations = new Set<string>();
  for (const node of implementationSeeds.values()) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const built = implementationExpansion(cg, node, budget, deadline, context);
    if (!built) continue;
    const expansionKey = `${built.expansion.contractId}:${built.expansion.symbol}`;
    if (seenImplementations.has(expansionKey)) continue;
    seenImplementations.add(expansionKey);
    for (const item of built.evidence) addEvidence(item);
    allImplementations.push(built.expansion);
  }

  const visibleEvidence = allEvidence.filter((item) => !prior.has(item.id));
  const visibleIds = new Set(visibleEvidence.map((item) => item.id));
  const visibleBreaks = allBreaks.filter(
    (item) => item.candidateEvidenceIds.length === 0
      || item.candidateEvidenceIds.some((id) => visibleIds.has(id)),
  );
  const visibleImplementations = allImplementations
    .map((item) => ({
      ...item,
      candidates: item.candidates.filter((candidate) => visibleIds.has(candidate.evidenceId)),
    }))
    .filter((item) => item.candidates.length > 0);

  const status = chain.length >= 2
    ? (allBreaks.length > 0 ? 'partial' : 'connected')
    : (resolvedIds.size > 0 ? 'partial' : 'unconnected');
  return {
    report: {
      schemaVersion: FLOW_EVIDENCE_SCHEMA_VERSION,
      status,
      evidence: visibleEvidence,
      breaks: visibleBreaks,
      implementations: visibleImplementations,
      deduplicatedEvidence: allEvidence.length - visibleEvidence.length,
      truncated,
      elapsedMs: Date.now() - startedAt,
      budget,
    },
    observedEvidenceKeys: allEvidence.map((item) => item.id),
  };
}
