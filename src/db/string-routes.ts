import type { SqliteDatabase } from './sqlite-adapter';
import type { QueryBuilder } from './queries';
import { STRING_BRIDGE_LANGUAGES, STRING_ROUTE_PREFIX, extractStringRoutes } from '../resolution/string-bridge';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { validatePathWithinRoot } from '../utils';
import { createYielder } from '../resolution/cooperative-yield';
import { MAX_SOURCE_FILE_SIZE_BYTES, readBoundedSourceSync } from '../file-limits';
import { logWarn } from '../errors';

export async function refreshStringRoutes(db: SqliteDatabase, queries: QueryBuilder, root: string, paths?: readonly string[]): Promise<boolean> {
  const scope = paths ? new Set(paths) : null;
  const yieldToLoop = createYielder();
  const loaded = new Set<string>();
  let changed = false;
  for (const file of queries.getAllFiles()) {
    if (!STRING_BRIDGE_LANGUAGES.includes(file.language) || (scope && !scope.has(file.path))) continue;
    if (file.size > MAX_SOURCE_FILE_SIZE_BYTES || file.errors?.some(error => error.code === 'size_exceeded')) continue;
    await yieldToLoop();
    // The extraction hash also changes whenever nodes were replaced.
    const retained = queries.getNodesByFile(file.path).filter(node => node.id.startsWith(STRING_ROUTE_PREFIX));
    const previous = queries.getMetadata(`string-routes:${file.path}`);
    if (previous === `${file.contentHash}:${retained.length}`) continue;
    const absolute = validatePathWithinRoot(root, file.path);
    if (!absolute) {
      logWarn('String routes skipped for a symlink outside the project', { file: file.path });
      continue;
    }
    const bounded = readBoundedSourceSync(absolute);
    if (!bounded.bytes) throw new Error(`Bridge source grew beyond the indexing limit: ${file.path}; retry sync.`);
    const source = bounded.bytes.toString('utf8');
    const relevant = /\b(?:match|switch)\b|\[\s*(?:path|route|url)\s*\]/.test(source);
    if ((relevant || source.includes('generate_handler!') || /invoke|bridge/i.test(source)) && !loaded.has(file.language)) {
      await loadGrammarsForLanguages([file.language]);
      loaded.add(file.language);
    }
    const routes = relevant ? extractStringRoutes(file.path, source, file.language, queries.getNodesByFile(file.path)) : [];
    if (!routes) throw new Error(`Bridge grammar is unavailable: ${file.language}`);
    db.transaction(() => {
      for (const node of retained) queries.deleteNode(node.id);
      queries.insertNodes(routes);
      queries.setMetadata(`string-routes:${file.path}`, `${file.contentHash}:${routes.length}`);
    })();
    changed ||= routes.length > 0;
  }
  return changed;
}
