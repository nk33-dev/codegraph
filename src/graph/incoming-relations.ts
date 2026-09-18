import type CodeGraph from '../index';
import type { Edge, Node } from '../types';

export interface IncomingGraphRelation {
  edge: Edge;
  source: Node;
  target: Node;
}

/**
 * 统一解析指向目标符号的 Graph 关系，供查询、自然语言探索和编辑覆盖检查复用。
 * 这里只做关系解析与稳定排序；各入口仍按自身契约筛选边类型和安全条件。
 */
export function collectIncomingRelations(
  cg: CodeGraph,
  targets: readonly Node[],
  kinds?: Edge['kind'][],
): IncomingGraphRelation[] {
  const targetsById = new Map(targets.map((node) => [node.id, node]));
  return cg.getIncomingEdgesTo([...targetsById.keys()], kinds)
    .map((edge) => {
      const source = cg.getNode(edge.source);
      const target = targetsById.get(edge.target);
      return source && target ? { edge, source, target } : null;
    })
    .filter((relation): relation is IncomingGraphRelation => relation !== null)
    .sort((a, b) => a.source.filePath.localeCompare(b.source.filePath)
      || a.source.startLine - b.source.startLine
      || (a.edge.line ?? 0) - (b.edge.line ?? 0)
      || (a.edge.column ?? 0) - (b.edge.column ?? 0)
      || a.edge.kind.localeCompare(b.edge.kind));
}
