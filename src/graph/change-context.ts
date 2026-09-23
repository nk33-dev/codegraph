/**
 * 工作区改动上下文：把 Git 差异、语义符号、图影响和关联测试收敛为一份共享契约。
 * 普通分析只读取当前索引和改动文件；完整基准图仅在调用方显式要求时临时创建。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type CodeGraph from '../index';
import type { EdgeKind, ExtractionResult, Node, NodeKind, UnresolvedReference } from '../types';
import { detectLanguage } from '../extraction';
import { materializeKernelResult } from '../extraction/kernel';
import { isCodeGraphDataDir } from '../directory';
import { analyzeImpact, findAffectedTests } from './change-impact';
import type { TestType } from './change-impact';

export const CHANGE_CONTEXT_SCHEMA_VERSION = 1;
export const DEFAULT_CHANGE_CONTEXT_DEPTH = 2;

const MAX_CHANGED_FILES = 80;
const MAX_CHANGED_SYMBOLS = 40;
const MAX_CHANGED_EDGES = 40;
const MAX_AFFECTED_ENTRIES = 30;
const MAX_AFFECTED_TESTS = 20;
const HIGH_FAN_IN = 5;
const GIT_TIMEOUT_MS = 15_000;
const TEMP_PREFIX = 'codegraph-change-baseline-';
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SEMANTIC_EDGE_KINDS = new Set<EdgeKind>([
  'calls', 'extends', 'implements', 'overrides', 'navigates',
]);
const SYMBOL_KINDS_TO_SKIP = new Set<NodeKind>(['file', 'import', 'export', 'parameter']);

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';
export type SemanticDeltaKind = 'added' | 'modified' | 'deleted';

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface ChangedFileContext {
  change: ChangeKind;
  path: string;
  previousPath: string | null;
  oldRanges: ChangedLineRange[];
  newRanges: ChangedLineRange[];
}

export interface ChangedSymbolContext {
  change: SemanticDeltaKind;
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  filePath: string;
  line: number;
  previousFilePath: string | null;
  previousLine: number | null;
}

export interface ChangedEdgeContext {
  change: 'added' | 'deleted';
  kind: EdgeKind;
  source: string;
  target: string;
  filePath: string;
  line: number | null;
  evidence: 'syntax' | 'resolved';
}

export interface AffectedEntryContext {
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  filePath: string;
  line: number;
  distance: number;
  via: EdgeKind[];
}

export interface MissingTestRisk {
  symbol: string;
  filePath: string;
  fanIn: number;
}

export interface ChangeContext {
  schemaVersion: 1;
  kind: 'change-context';
  baseRef: string;
  files: ChangedFileContext[];
  symbols: ChangedSymbolContext[];
  edges: ChangedEdgeContext[];
  affectedEntries: AffectedEntryContext[];
  affectedTests: Array<{
    filePath: string;
    distance: number;
    reason: 'changed' | 'dependent';
    confidence: 'direct' | 'high' | 'indirect';
    priority: 'focused' | 'related';
    testTypes: TestType[];
    via: string[];
  }>;
  missingTestRisks: MissingTestRisk[];
  warnings: string[];
  deep: boolean;
  truncated: boolean;
}

export interface AnalyzeChangeContextOptions {
  baseRef?: string;
  depth?: number;
  deep?: boolean;
  /** 非改动意图的查询可传入结果文件，只在这些文件确有变化时才继续完整分析。 */
  candidateFiles?: readonly string[];
}

/** 只有明确表达审查、差异或改动影响时才主动扫描整个工作区。 */
export function queryRequestsChangeContext(query: string): boolean {
  return /\b(review|changes?|changed|diff|regression|impact|refactor|pull request|\bpr\b)\b|审查|评审|改动|变更|差异|影响|重构/i.test(query);
}

interface GitFileChange {
  change: ChangeKind;
  path: string;
  previousPath: string | null;
}

interface SemanticEdge {
  kind: EdgeKind;
  source: string;
  target: string;
  filePath: string;
  line: number | null;
  evidence: 'syntax' | 'resolved';
}

interface FileSemanticSnapshot {
  nodes: Node[];
  edges: SemanticEdge[];
}

function git(projectRoot: string, args: string[], maxBuffer = 50 * 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isInternalPath(filePath: string): boolean {
  return isCodeGraphDataDir(normalizePath(filePath).split('/')[0] ?? '');
}

function validateBaseRef(value: string | undefined): string {
  const ref = value?.trim() || 'HEAD';
  if (ref.length > 256 || ref.startsWith('-') || !/^[A-Za-z0-9._/@{}~^:+-]+$/.test(ref)) {
    throw new Error(`Invalid Git base ref: ${ref}`);
  }
  return ref;
}

function resolveCommit(projectRoot: string, baseRef: string): string | null {
  try {
    return git(projectRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

function parseNameStatus(output: string): GitFileChange[] {
  const fields = output.split('\0');
  const changes: GitFileChange[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (!status) continue;
    const code = status[0];
    const first = fields[i++] ?? '';
    if (!first) continue;
    if (code === 'R' || code === 'C') {
      const next = fields[i++] ?? '';
      if (!next) continue;
      changes.push({ change: 'renamed', path: normalizePath(next), previousPath: normalizePath(first) });
    } else {
      changes.push({
        change: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
        path: normalizePath(first),
        previousPath: null,
      });
    }
  }
  return changes;
}

function listGitChanges(projectRoot: string, commit: string | null): GitFileChange[] {
  const tracked = commit
    ? parseNameStatus(git(projectRoot, [
      'diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACDMRTUXB', commit, '--',
    ]))
    : [];
  const known = new Set(tracked.flatMap((item) => [item.path, item.previousPath ?? '']));
  const untracked = git(projectRoot, ['ls-files', '-z', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
    .filter((filePath) => !known.has(filePath))
    .map((filePath): GitFileChange => ({ change: 'added', path: filePath, previousPath: null }));

  if (!commit) {
    const staged = git(projectRoot, ['ls-files', '-z', '--cached'])
      .split('\0')
      .filter(Boolean)
      .map(normalizePath)
      .filter((filePath) => !known.has(filePath))
      .map((filePath): GitFileChange => ({ change: 'added', path: filePath, previousPath: null }));
    return [...staged, ...untracked].filter((change) => !isInternalPath(change.path));
  }
  return coalesceExactRenames(
    projectRoot,
    commit,
    [...tracked, ...untracked].filter((change) => !isInternalPath(change.path)),
  );
}

/** Git 不会把“未暂存删除 + 内容相同的未跟踪文件”识别为 rename；在本地补齐这一种确定形状。 */
function coalesceExactRenames(
  projectRoot: string,
  commit: string,
  changes: GitFileChange[],
): GitFileChange[] {
  const added = changes.filter((change) => change.change === 'added');
  const consumed = new Set<GitFileChange>();
  const replacements = new Map<GitFileChange, GitFileChange>();
  for (const deleted of changes.filter((change) => change.change === 'deleted')) {
    const before = readBaseFile(projectRoot, commit, deleted.path);
    if (before === null) continue;
    for (const candidate of added) {
      if (consumed.has(candidate)) continue;
      let current: string;
      try { current = fs.readFileSync(path.join(projectRoot, candidate.path), 'utf8'); } catch { continue; }
      if (current !== before) continue;
      consumed.add(candidate);
      replacements.set(deleted, {
        change: 'renamed',
        path: candidate.path,
        previousPath: deleted.path,
      });
      break;
    }
  }
  return changes
    .filter((change) => !consumed.has(change))
    .map((change) => replacements.get(change) ?? change);
}

function candidateFilesChanged(
  projectRoot: string,
  commit: string | null,
  candidateFiles: readonly string[],
): boolean {
  const candidates = [...new Set(candidateFiles.map(normalizePath).filter(Boolean))].slice(0, 200);
  if (candidates.length === 0) return false;
  try {
    const tracked = commit
      ? git(projectRoot, ['diff', '--name-only', '-z', commit, '--', ...candidates])
      : '';
    if (tracked.length > 0) return true;
    return git(projectRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...candidates]).length > 0;
  } catch {
    return false;
  }
}

function parseDiffRanges(diff: string): { oldRanges: ChangedLineRange[]; newRanges: ChangedLineRange[] } {
  const oldRanges: ChangedLineRange[] = [];
  const newRanges: ChangedLineRange[] = [];
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunk.exec(diff)) !== null) {
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount > 0) oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
    if (newCount > 0) newRanges.push({ start: newStart, end: newStart + newCount - 1 });
  }
  return { oldRanges, newRanges };
}

function rangesForChange(
  projectRoot: string,
  commit: string | null,
  change: GitFileChange,
): { oldRanges: ChangedLineRange[]; newRanges: ChangedLineRange[] } {
  if (!commit || change.change === 'added') {
    try {
      const lineCount = fs.readFileSync(path.join(projectRoot, change.path), 'utf8').split(/\r?\n/).length;
      return { oldRanges: [], newRanges: lineCount > 0 ? [{ start: 1, end: lineCount }] : [] };
    } catch {
      return { oldRanges: [], newRanges: [] };
    }
  }
  const paths = change.previousPath ? [change.previousPath, change.path] : [change.path];
  try {
    return parseDiffRanges(git(projectRoot, [
      'diff', '--no-ext-diff', '--unified=0', '--no-color', '--find-renames', commit, '--', ...paths,
    ]));
  } catch {
    return { oldRanges: [], newRanges: [] };
  }
}

function rangesOverlap(start: number, end: number, ranges: readonly ChangedLineRange[]): boolean {
  return ranges.some((range) => start <= range.end && end >= range.start);
}

function readBaseFile(projectRoot: string, commit: string | null, filePath: string): string | null {
  if (!commit) return null;
  try {
    return git(projectRoot, ['show', `${commit}:${filePath}`]);
  } catch {
    return null;
  }
}

function materializedExtraction(cg: CodeGraph, filePath: string, source: string): ExtractionResult {
  const language = detectLanguage(filePath, source);
  return materializeKernelResult(cg.extractFromSource(filePath, source), filePath, language);
}

function semanticName(node: Node, filePath: string): string {
  const normalized = normalizePath(filePath);
  const qualified = node.qualifiedName || node.name;
  const prefixes = [`${normalized}::`, `${normalized}:`, `${normalized}/`];
  for (const prefix of prefixes) {
    if (qualified.startsWith(prefix)) return qualified.slice(prefix.length);
  }
  return qualified;
}

function symbolKey(node: Node, filePath: string): string {
  return `${node.kind}:${semanticName(node, filePath)}`;
}

function meaningfulNodes(result: ExtractionResult): Node[] {
  return result.nodes.filter((node) => !SYMBOL_KINDS_TO_SKIP.has(node.kind));
}

function edgeKey(edge: SemanticEdge): string {
  return `${edge.kind}:${edge.source}->${edge.target}`;
}

function snapshotFromExtraction(
  cg: CodeGraph,
  filePath: string,
  source: string | null,
): FileSemanticSnapshot {
  if (source === null) return { nodes: [], edges: [] };
  const result = materializedExtraction(cg, filePath, source);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const edges: SemanticEdge[] = [];
  for (const edge of result.edges) {
    if (!SEMANTIC_EDGE_KINDS.has(edge.kind)) continue;
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    edges.push({
      kind: edge.kind,
      source: semanticName(from, filePath),
      target: semanticName(to, filePath),
      filePath,
      line: edge.line ?? null,
      evidence: 'syntax',
    });
  }
  for (const ref of result.unresolvedReferences) {
    const edge = edgeFromReference(ref, byId, filePath);
    if (edge) edges.push(edge);
  }
  return { nodes: meaningfulNodes(result), edges };
}

function edgeFromReference(
  ref: UnresolvedReference,
  byId: ReadonlyMap<string, Node>,
  filePath: string,
): SemanticEdge | null {
  if (ref.referenceKind === 'function_ref' || !SEMANTIC_EDGE_KINDS.has(ref.referenceKind)) return null;
  const from = byId.get(ref.fromNodeId);
  if (!from) return null;
  return {
    kind: ref.referenceKind,
    source: semanticName(from, filePath),
    target: ref.referenceName,
    filePath,
    line: ref.line || null,
    evidence: 'syntax',
  };
}

function compareFileSnapshots(
  change: ChangedFileContext,
  before: FileSemanticSnapshot,
  after: FileSemanticSnapshot,
): { symbols: ChangedSymbolContext[]; edges: ChangedEdgeContext[] } {
  const beforeByKey = new Map(before.nodes.map((node) => [symbolKey(node, change.previousPath ?? change.path), node]));
  const afterByKey = new Map(after.nodes.map((node) => [symbolKey(node, change.path), node]));
  const symbols: ChangedSymbolContext[] = [];

  for (const [key, node] of afterByKey) {
    const previous = beforeByKey.get(key);
    if (!previous) {
      symbols.push({
        change: 'added', name: node.name, qualifiedName: node.qualifiedName, kind: node.kind,
        filePath: change.path, line: node.startLine, previousFilePath: null, previousLine: null,
      });
      continue;
    }
    const touched = change.change === 'renamed'
      || rangesOverlap(node.startLine, node.endLine, change.newRanges)
      || rangesOverlap(previous.startLine, previous.endLine, change.oldRanges)
      || node.signature !== previous.signature;
    if (touched) {
      symbols.push({
        change: 'modified', name: node.name, qualifiedName: node.qualifiedName, kind: node.kind,
        filePath: change.path, line: node.startLine,
        previousFilePath: change.previousPath ?? change.path, previousLine: previous.startLine,
      });
    }
  }
  for (const [key, node] of beforeByKey) {
    if (afterByKey.has(key)) continue;
    symbols.push({
      change: 'deleted', name: node.name, qualifiedName: node.qualifiedName, kind: node.kind,
      filePath: change.previousPath ?? change.path, line: node.startLine,
      previousFilePath: change.previousPath ?? change.path, previousLine: node.startLine,
    });
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  const edges: ChangedEdgeContext[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) edges.push({ change: 'added', ...edge });
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) edges.push({ change: 'deleted', ...edge });
  }
  return { symbols, edges };
}

function graphNodeForSymbol(cg: CodeGraph, symbol: ChangedSymbolContext): Node | null {
  const candidates = cg.getNodesInFile(symbol.filePath);
  return candidates.find((node) => node.kind === symbol.kind && node.qualifiedName === symbol.qualifiedName)
    ?? candidates.find((node) => node.kind === symbol.kind && node.name === symbol.name && node.startLine === symbol.line)
    ?? null;
}

function affectedEntries(cg: CodeGraph, roots: Node[], depth: number): AffectedEntryContext[] {
  if (roots.length === 0) return [];
  const analysis = analyzeImpact(cg, roots, depth);
  const records = [...analysis.entries.values()].filter((entry) => entry.distance > 0);
  const preferred = records.filter(({ node }) =>
    node.kind === 'route' || node.kind === 'component' || node.kind === 'file' || node.isExported === true,
  );
  const chosen = preferred.length > 0 ? preferred : records;
  return chosen
    .sort((a, b) => a.distance - b.distance || a.node.filePath.localeCompare(b.node.filePath) || a.node.startLine - b.node.startLine)
    .slice(0, MAX_AFFECTED_ENTRIES)
    .map(({ node, distance, via }) => ({
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      filePath: node.filePath,
      line: node.startLine,
      distance,
      via,
    }));
}

function resolvedEdgesFor(cg: CodeGraph, nodes: readonly Node[]): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  for (const node of nodes) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (!SEMANTIC_EDGE_KINDS.has(edge.kind)) continue;
      const target = cg.getNode(edge.target);
      if (!target) continue;
      edges.push({
        kind: edge.kind,
        source: node.qualifiedName || node.name,
        target: target.qualifiedName || target.name,
        filePath: node.filePath,
        line: edge.line ?? null,
        evidence: 'resolved',
      });
    }
  }
  return edges;
}

function safeRemoveBaselineDir(tempRoot: string): void {
  const parent = path.resolve(os.tmpdir());
  const target = path.resolve(tempRoot);
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(TEMP_PREFIX)) return;
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function cleanupStaleBaselineDirs(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
    const candidate = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(candidate).mtimeMs > TEMP_MAX_AGE_MS) safeRemoveBaselineDir(candidate);
    } catch {
      // 清理是尽力而为；分析结果不能因旧临时目录被占用而失败。
    }
  }
}

async function addDeepResolvedEdgeDelta(
  cg: CodeGraph,
  projectRoot: string,
  commit: string,
  files: readonly ChangedFileContext[],
  edges: ChangedEdgeContext[],
): Promise<void> {
  cleanupStaleBaselineDirs();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const checkout = path.join(tempRoot, 'checkout');
  let baseline: CodeGraph | null = null;
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', projectRoot, checkout], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024, windowsHide: true,
    });
    git(checkout, ['checkout', '--quiet', '--detach', commit]);
    const { default: CodeGraphClass } = await import('../index');
    baseline = await CodeGraphClass.init(checkout, { index: true });

    const currentPaths = files.filter((file) => file.change !== 'deleted').map((file) => file.path);
    const baselinePaths = files.filter((file) => file.change !== 'added').map((file) => file.previousPath ?? file.path);
    const currentEdges = resolvedEdgesFor(cg, currentPaths.flatMap((filePath) => cg.getNodesInFile(filePath)));
    const baselineEdges = resolvedEdgesFor(baseline, baselinePaths.flatMap((filePath) => baseline!.getNodesInFile(filePath)));
    const currentByKey = new Map(currentEdges.map((edge) => [edgeKey(edge), edge]));
    const baselineByKey = new Map(baselineEdges.map((edge) => [edgeKey(edge), edge]));
    const known = new Set(edges.map((edge) => `${edge.change}:${edgeKey(edge)}`));
    for (const [key, edge] of currentByKey) {
      const marker = `added:${key}`;
      if (!baselineByKey.has(key)) {
        const existing = edges.find((candidate) => `added:${edgeKey(candidate)}` === marker);
        if (existing) existing.evidence = 'resolved';
        else if (!known.has(marker)) edges.push({ change: 'added', ...edge });
      }
    }
    for (const [key, edge] of baselineByKey) {
      const marker = `deleted:${key}`;
      if (!currentByKey.has(key)) {
        const existing = edges.find((candidate) => `deleted:${edgeKey(candidate)}` === marker);
        if (existing) existing.evidence = 'resolved';
        else if (!known.has(marker)) edges.push({ change: 'deleted', ...edge });
      }
    }
  } finally {
    try { baseline?.destroy(); } catch { /* 继续清理临时目录 */ }
    try { safeRemoveBaselineDir(tempRoot); } catch { /* 下次深度分析会清理过期目录 */ }
  }
}

/**
 * 先用候选文件做路径限定；候选均未变化时返回 null，避免构造完整改动上下文和输出噪声。
 */
export async function analyzeChangeContext(
  cg: CodeGraph,
  options: AnalyzeChangeContextOptions = {},
): Promise<ChangeContext | null> {
  const projectRoot = cg.getProjectRoot();
  const baseRef = validateBaseRef(options.baseRef);
  const commit = resolveCommit(projectRoot, baseRef);
  if (baseRef !== 'HEAD' && !commit) throw new Error(`Git base ref not found: ${baseRef}`);

  if (
    options.candidateFiles
    && options.candidateFiles.length > 0
    && !candidateFilesChanged(projectRoot, commit, options.candidateFiles)
  ) {
    return null;
  }

  let gitChanges: GitFileChange[];
  try {
    gitChanges = listGitChanges(projectRoot, commit);
  } catch {
    return null;
  }
  if (options.candidateFiles && options.candidateFiles.length > 0) {
    const candidates = new Set(options.candidateFiles.map(normalizePath));
    gitChanges = gitChanges.filter((change) => candidates.has(change.path) || (change.previousPath && candidates.has(change.previousPath)));
  }
  if (gitChanges.length === 0) return null;

  let truncated = gitChanges.length > MAX_CHANGED_FILES;
  gitChanges = gitChanges.slice(0, MAX_CHANGED_FILES);
  const files: ChangedFileContext[] = [];
  const symbols: ChangedSymbolContext[] = [];
  const edges: ChangedEdgeContext[] = [];
  const warnings: string[] = [];

  for (const gitChange of gitChanges) {
    const ranges = rangesForChange(projectRoot, commit, gitChange);
    const file: ChangedFileContext = { ...gitChange, ...ranges };
    files.push(file);
    const oldPath = gitChange.previousPath ?? gitChange.path;
    const before = snapshotFromExtraction(cg, oldPath, readBaseFile(projectRoot, commit, oldPath));
    let currentSource: string | null = null;
    if (gitChange.change !== 'deleted') {
      try { currentSource = fs.readFileSync(path.join(projectRoot, gitChange.path), 'utf8'); } catch { currentSource = null; }
    }
    const after = snapshotFromExtraction(cg, gitChange.path, currentSource);
    const delta = compareFileSnapshots(file, before, after);
    symbols.push(...delta.symbols);
    edges.push(...delta.edges);
  }

  const currentSymbols = symbols.filter((symbol) => symbol.change !== 'deleted');
  const roots = new Map<string, Node>();
  for (const symbol of currentSymbols) {
    const node = graphNodeForSymbol(cg, symbol);
    if (node) roots.set(node.id, node);
  }
  const rootNodes = [...roots.values()];
  const depth = Math.max(1, Math.min(10, options.depth ?? DEFAULT_CHANGE_CONTEXT_DEPTH));
  const entries = affectedEntries(cg, rootNodes, depth);
  const currentFiles = files.filter((file) => file.change !== 'deleted').map((file) => file.path);
  const testAnalysis = findAffectedTests(cg, currentFiles, { depth: 5 });
  const tests = testAnalysis.tests.slice(0, MAX_AFFECTED_TESTS);
  if (testAnalysis.indirectCandidates.length > 0) {
    warnings.push(
      `${testAnalysis.indirectCandidates.length} 个经公共模块或较长依赖链命中的测试仅作为间接候选，未混入默认关联测试。`,
    );
  }

  const fanIn = cg.getFanIn(rootNodes.map((node) => node.id));
  const missingTestRisks = tests.length === 0
    ? rootNodes
      .filter((node) => (fanIn.get(node.id) ?? 0) >= HIGH_FAN_IN)
      .map((node) => ({ symbol: node.qualifiedName || node.name, filePath: node.filePath, fanIn: fanIn.get(node.id) ?? 0 }))
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 10)
    : [];
  if (files.some((file) => file.change === 'deleted')) {
    warnings.push('删除符号在当前图中已无节点；影响范围可能漏掉动态调用、未解析引用以及仅指向已删除节点的旧边。');
  }
  if (missingTestRisks.length > 0) {
    warnings.push('高扇入改动：图中未发现覆盖；这不代表项目没有测试或影响。');
  }

  if (options.deep && commit) {
    await addDeepResolvedEdgeDelta(cg, projectRoot, commit, files, edges);
  }

  if (symbols.length > MAX_CHANGED_SYMBOLS || edges.length > MAX_CHANGED_EDGES || testAnalysis.tests.length > MAX_AFFECTED_TESTS) {
    truncated = true;
  }
  return {
    schemaVersion: CHANGE_CONTEXT_SCHEMA_VERSION,
    kind: 'change-context',
    baseRef,
    files,
    symbols: symbols.slice(0, MAX_CHANGED_SYMBOLS),
    edges: edges.slice(0, MAX_CHANGED_EDGES),
    affectedEntries: entries,
    affectedTests: tests,
    missingTestRisks,
    warnings,
    deep: options.deep === true,
    truncated,
  };
}

export function formatChangeContext(context: ChangeContext): string {
  const lines: string[] = ['**Change context**', ''];
  const fileCounts = new Map<ChangeKind, number>();
  for (const file of context.files) fileCounts.set(file.change, (fileCounts.get(file.change) ?? 0) + 1);
  lines.push(`- Base: \`${context.baseRef}\`${context.deep ? ' (deep semantic comparison)' : ''}`);
  lines.push(`- Files: ${[...fileCounts].map(([kind, count]) => `${kind} ${count}`).join(', ')}`);

  if (context.symbols.length > 0) {
    lines.push('', '**Changed symbols**');
    for (const symbol of context.symbols.slice(0, 12)) {
      lines.push(`- ${symbol.change}: ${symbol.qualifiedName || symbol.name} (${symbol.kind}, ${symbol.filePath}:${symbol.line})`);
    }
    if (context.symbols.length > 12) lines.push(`- ... and ${context.symbols.length - 12} more symbols`);
  }
  if (context.edges.length > 0) {
    lines.push('', '**Changed semantic edges**');
    for (const edge of context.edges.slice(0, 12)) {
      lines.push(`- ${edge.change}: ${edge.source} -[${edge.kind}]-> ${edge.target} (${edge.filePath}${edge.line ? `:${edge.line}` : ''}, ${edge.evidence})`);
    }
    if (context.edges.length > 12) lines.push(`- ... and ${context.edges.length - 12} more edges`);
  }
  if (context.affectedEntries.length > 0) {
    lines.push('', '**Affected entries**');
    for (const entry of context.affectedEntries.slice(0, 10)) {
      lines.push(`- distance ${entry.distance}: ${entry.qualifiedName || entry.name} (${entry.filePath}:${entry.line}; via ${entry.via.join(', ') || 'graph'})`);
    }
    if (context.affectedEntries.length > 10) lines.push(`- ... and ${context.affectedEntries.length - 10} more entries`);
  }
  if (context.affectedTests.length > 0) {
    lines.push('', '**Related tests**');
    for (const test of context.affectedTests.slice(0, 10)) {
      lines.push(`- ${test.filePath} (${test.priority}, ${test.confidence}, ${test.testTypes.join('/')}, distance ${test.distance}, ${test.reason})`);
    }
    if (context.affectedTests.length > 10) lines.push(`- ... and ${context.affectedTests.length - 10} more tests`);
  }
  for (const warning of context.warnings) lines.push('', `> ${warning}`);
  if (context.truncated) lines.push('', '> 改动上下文已按预算裁剪；structured content 也只包含有界结果。');
  return lines.join('\n');
}
