/**
 * Graph Module
 *
 * Provides graph traversal and query functionality for the code knowledge graph.
 */

export { GraphTraverser } from './traversal';
export { GraphQueryManager } from './queries';
export {
  buildTypeHierarchy,
  canHaveHierarchy,
  countImplementers,
  DISPATCH_MIN_IMPLEMENTERS,
  HIERARCHY_EDGE_KINDS,
  HIERARCHY_KINDS,
  MAX_DESCENDANTS,
} from './type-hierarchy';
export type {
  HierarchyEntry,
  HierarchyRelation,
  OverrideMatch,
  TypeHierarchy,
} from './type-hierarchy';
export {
  buildDeadCodeReport,
  isImplicitEntryName,
  DEAD_CODE_ALLOWED_KINDS,
  DEAD_CODE_KINDS,
  MAX_DEAD_CODE_CANDIDATES,
  MAX_OVERRIDE_ANCESTOR_DEPTH,
} from './dead-code';
export {
  buildFlowEvidenceReport,
  DEFAULT_FLOW_EVIDENCE_BUDGET,
  FLOW_EVIDENCE_SCHEMA_VERSION,
} from './flow-evidence';
export {
  analyzeChangeContext,
  formatChangeContext,
  queryRequestsChangeContext,
  CHANGE_CONTEXT_SCHEMA_VERSION,
  DEFAULT_CHANGE_CONTEXT_DEPTH,
} from './change-context';
export type {
  AffectedEntryContext,
  AnalyzeChangeContextOptions,
  ChangeContext,
  ChangedEdgeContext,
  ChangedFileContext,
  ChangedLineRange,
  ChangedSymbolContext,
  ChangeKind,
  MissingTestRisk,
  SemanticDeltaKind,
} from './change-context';
export type {
  BuildFlowEvidenceOptions,
  BuiltFlowEvidence,
  FlowBreak,
  FlowBreakReason,
  FlowConfidence,
  FlowEvidence,
  FlowEvidenceBudget,
  FlowEvidenceKind,
  FlowEvidenceReport,
  FlowEvidenceSource,
  FlowLocation,
  ImplementerExpansion,
  RuntimeCandidate,
} from './flow-evidence';
export type {
  DeadCodeEntry,
  DeadCodeExclusions,
  DeadCodeQuery,
  DeadCodeReport,
} from './dead-code';
