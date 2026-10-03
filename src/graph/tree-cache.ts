/**
 * Parsed tree-sitter trees, cached per file version.
 *
 * Shared by the two features that re-parse a file outside the indexer: the
 * branch-guard reader (a call site's `when`) and the risk-hotspot report's
 * decision count. Both read the same files from the same working tree, so one
 * LRU serves both.
 *
 * The byte cap is a PER-CALL argument, not a shared constant: a Symbol view is
 * budgeted at 100 ms and refuses anything over 256 KB, while the hotspot report
 * wants the bigger files the Symbol view skips. The cap is checked before the
 * cache lookup so a caller can never be handed a tree that is over ITS limit
 * just because another caller with a larger limit parsed it.
 */

import * as fs from 'fs';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Language } from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';

export type { SyntaxNode };

export interface CachedTree<G = unknown> {
  key: string;
  tree: Tree;
  source: string;
  /** Per-feature payload keyed by the file version, e.g. parsed branch guards. */
  guards?: Map<string, G>;
}

const TREE_CACHE_SIZE = 8;
/**
 * One LRU holds every feature's payload type. `Map` is invariant in its value
 * type, so the two accessors below cast — the alternative is a cache per
 * feature, which is what this module exists to avoid.
 */
const treeCache = new Map<string, CachedTree<never>>();

/**
 * Files above this size are not parsed for labels. A 300 KB source file costs
 * tens of milliseconds to parse, and a Symbol view is budgeted at 100 ms end to
 * end; a call site in such a file simply shows no `when`.
 */
export const MAX_PARSE_BYTES = 256 * 1024;

/** The `web-tree-sitter` trees held above are native memory: evict explicitly. */
export function remember<G>(path: string, entry: CachedTree<G>): void {
  const old = treeCache.get(path);
  if (old) old.tree.delete();
  treeCache.delete(path);
  treeCache.set(path, entry as unknown as CachedTree<never>);
  if (treeCache.size > TREE_CACHE_SIZE) {
    const oldest = treeCache.keys().next().value as string;
    treeCache.get(oldest)?.tree.delete();
    treeCache.delete(oldest);
  }
}

/** The cached entry for a path, regardless of version — callers check `key`. */
export function getCachedTree<G>(absPath: string): CachedTree<G> | undefined {
  return treeCache.get(absPath) as unknown as CachedTree<G> | undefined;
}

export async function parse(source: string, language: Language, deadline = Infinity): Promise<Tree | null> {
  try {
    await loadGrammarsForLanguages([language]);
    const parser = getParser(language);
    if (!parser || Date.now() >= deadline) return null;
    // 限时标注可以取消一个大文件的解析；共享 parser 必须重置，不能把半棵树带到下次请求。
    let tree: Tree | null = null;
    try {
      tree = parser.parse(source, null, Number.isFinite(deadline)
        ? { progressCallback: () => Date.now() >= deadline }
        : undefined);
      return tree;
    } finally {
      if (!tree) parser.reset();
    }
  } catch {
    return null;
  }
}

/** Read and parse a file, reusing the cached tree when its version is unchanged. */
export async function treeFor<G = unknown>(
  absPath: string,
  language: Language,
  deadline = Infinity,
  maxBytes = MAX_PARSE_BYTES
): Promise<CachedTree<G> | null> {
  if (Date.now() >= deadline) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  // Before the cache lookup: see the note at the top of the file.
  if (stat.size > maxBytes) return null;
  const key = `${language}:${stat.mtimeMs}:${stat.size}`;
  const hit = treeCache.get(absPath);
  if (hit && hit.key === key) return hit as unknown as CachedTree<G>;
  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const tree = await parse(source, language, deadline);
  if (!tree) return null;
  const entry: CachedTree<G> = { key, tree, source };
  remember(absPath, entry);
  return entry;
}
