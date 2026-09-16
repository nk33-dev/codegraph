/**
 * Change impact analysis: the impact scope (with propagation distance) and related tests.
 *
 * This derivation used to be scattered across the `impact` / `affected` commands in
 * `src/bin/codegraph.ts`; phase 3 moved it into `src/graph/`, so the CLI and the unified query entry
 * point (`codegraph_explore`) share one implementation — otherwise the same question would get two answers.
 *
 * Two boundaries must be treated honestly:
 *   1. **Distance is the graph's propagation step count**, not "this will definitely break"; dynamic
 *      calls, reflection, and unresolved references have no edges, so they are invisible.
 *   2. **Related tests come from file dependency edges**; a missing edge (dynamic require, unindexed
 *      file) means a missed test.
 */
import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { isTestPath } from '../search/query-utils';

/** The default depth for mode=impact (same as the CLI `codegraph impact` default). */
export const DEFAULT_IMPACT_DEPTH = 2;
/** The default depth for mode=tests (same as the CLI `codegraph affected` default). */
export const DEFAULT_TESTS_DEPTH = 5;

export interface ImpactedSymbol {
  node: Node;
  /** 0 = the changed definition itself; a container's `contains` children have the same distance as their container. */
  distance: number;
  /** The edge kinds by which this symbol points at nodes no farther than itself (deduplicated, sorted). */
  via: Edge['kind'][];
  /** The root definition ID that produced this record (the shortest distance). */
  rootId: string;
}

export interface ImpactAnalysis {
  /** node.id → affected symbol; when several roots hit the same node, the shortest distance is kept. */
  entries: Map<string, ImpactedSymbol>;
  /** The dependency edges seen in each root's subgraph (deduplicated by `source->target:kind`, in discovery order). */
  edges: Edge[];
  /**
   * The number of nodes present in the graph but not reverse-attributable to a root definition.
   * `getImpactRadius` only collects reverse-reachable nodes, so this should normally be 0; when it is
   * non-zero the caller should warn rather than pass a guess off as a distance.
   */
  unattributed: number;
}

/**
 * One impact analysis: take `getImpactRadius` for each root definition, then derive distances back
 * from the edges in the subgraph.
 *
 * Distances are not taken from the traverser's internal state but derived from the subgraph itself:
 *   - dependency edge `source → target` (source depends on target): target is closer, source = target + 1;
 *   - container `contains` edge: the child has the same distance as its container (weight 0).
 * A 0-1 BFS finds the shortest path, giving the minimum distance without changing `GraphTraverser`'s existing semantics.
 */
export function analyzeImpact(cg: CodeGraph, roots: Node[], depth: number): ImpactAnalysis {
  const entries = new Map<string, ImpactedSymbol>();
  const edges = new Map<string, Edge>();
  let unattributed = 0;

  const record = (node: Node, distance: number, via: Edge['kind'][], rootId: string): void => {
    const existing = entries.get(node.id);
    if (!existing) {
      entries.set(node.id, { node, distance, via, rootId });
      return;
    }
    if (distance < existing.distance) {
      entries.set(node.id, { node, distance, via, rootId });
      return;
    }
    if (distance === existing.distance) {
      // Different paths at the same distance: merge via, keep the first root (the root ID is only for attribution, not merged semantics).
      const merged = new Set([...existing.via, ...via]);
      entries.set(node.id, { ...existing, via: [...merged].sort() });
    }
  };

  for (const root of roots) {
    const subgraph = cg.getImpactRadius(root.id, depth > 0 ? depth : DEFAULT_IMPACT_DEPTH);
    for (const edge of subgraph.edges) edges.set(`${edge.source}->${edge.target}:${edge.kind}`, edge);
    const distances = reverseDistances(subgraph.edges, root.id);
    for (const [id, node] of subgraph.nodes) {
      const distance = id === root.id ? 0 : distances.get(id);
      if (distance === undefined) {
        // When it cannot be attributed, no number is invented: recording some farthest distance other
        // than 0 would make "how deep the impact goes" lie, so this only counts them and the caller warns.
        unattributed += 1;
        continue;
      }
      record(node, distance, viaKinds(subgraph.edges, id, distances, distance), root.id);
    }
  }

  return { entries, edges: [...edges.values()], unattributed };
}

/** Minimum distances from the root along reversed edges (target → source); `contains` has weight 0. */
function reverseDistances(edges: Edge[], rootId: string): Map<string, number> {
  const outgoing = new Map<string, Array<{ to: string; weight: number }>>();
  for (const edge of edges) {
    // Reverse edge: source is reachable from target (target is closer to the root).
    const from = edge.target;
    const list = outgoing.get(from) ?? [];
    list.push({ to: edge.source, weight: 1 });
    outgoing.set(from, list);
    if (edge.kind === 'contains') {
      // contains is container → child: the container is closer to the root, and the child has the same distance as its container.
      const childList = outgoing.get(edge.source) ?? [];
      childList.push({ to: edge.target, weight: 0 });
      outgoing.set(edge.source, childList);
    }
  }

  const distances = new Map<string, number>([[rootId, 0]]);
  // 0-1 BFS: weight 0 goes to the front of the deque, weight 1 to the back, so the first finalization is the shortest.
  const deque: string[] = [rootId];
  while (deque.length > 0) {
    const current = deque.shift()!;
    const base = distances.get(current)!;
    for (const next of outgoing.get(current) ?? []) {
      const candidate = base + next.weight;
      const known = distances.get(next.to);
      if (known !== undefined && known <= candidate) continue;
      distances.set(next.to, candidate);
      if (next.weight === 0) deque.unshift(next.to);
      else deque.push(next.to);
    }
  }
  return distances;
}

/** The edge kinds by which this symbol points at nodes no farther than itself. */
function viaKinds(edges: Edge[], id: string, distances: Map<string, number>, own: number): Edge['kind'][] {
  const kinds = new Set<Edge['kind']>();
  for (const edge of edges) {
    if (edge.source !== id) continue;
    const target = distances.get(edge.target);
    if (target !== undefined && target <= own) kinds.add(edge.kind);
  }
  return [...kinds].sort();
}

export interface AffectedTest {
  filePath: string;
  distance: number;
  reason: 'changed' | 'dependent';
  /** The direct dependency files pointing at this test on the shortest dependency path (deduplicated, sorted, at most 10). */
  via: string[];
}

export interface AffectedTestsAnalysis {
  tests: AffectedTest[];
  /** The total number of dependency files discovered during traversal (including tests), matching the CLI `affected` count. */
  dependentsTraversed: number;
}

/**
 * Related tests: a changed file counts as a hit when it is itself a test; otherwise the search walks
 * "who depends on it" layer by layer for test files.
 *
 * `isTest` defaults to the project-wide {@link isTestPath}; when the CLI passes `--filter`, a custom
 * predicate overrides it (consistent with the existing behavior).
 */
export function findAffectedTests(
  cg: CodeGraph,
  changedFiles: string[],
  options: { depth: number; isTest?: (filePath: string) => boolean },
): AffectedTestsAnalysis {
  const isTest = options.isTest ?? isTestPath;
  const maxDepth = options.depth;
  const found = new Map<string, AffectedTest>();
  const dependents = new Set<string>();

  const add = (filePath: string, distance: number, reason: AffectedTest['reason'], via: string): void => {
    const existing = found.get(filePath);
    if (!existing) {
      found.set(filePath, { filePath, distance, reason, via: via ? [via] : [] });
      return;
    }
    if (!via || existing.via.includes(via)) return;
    existing.via.push(via);
    if (distance < existing.distance) {
      existing.distance = distance;
      existing.reason = reason;
    }
  };

  for (const file of changedFiles) {
    if (isTest(file)) {
      add(file, 0, 'changed', '');
      continue;
    }
    const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
    const visited = new Set<string>([file]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      for (const dependent of cg.getFileDependents(current.file)) {
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        dependents.add(dependent);
        if (isTest(dependent)) add(dependent, current.depth + 1, 'dependent', current.file);
        else queue.push({ file: dependent, depth: current.depth + 1 });
      }
    }
  }

  const tests = [...found.values()]
    .map((test) => ({ ...test, via: [...test.via].sort().slice(0, 10) }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { tests, dependentsTraversed: dependents.size };
}
