import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite-adapter';
import type { QueryBuilder } from './queries';
import { extractFieldContracts, FIELD_CONTRACT_LANGUAGES, type FieldContract } from '../graph/field-contracts';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { validatePathWithinRoot } from '../utils';
import { createYielder } from '../resolution/cooperative-yield';

export const FIELD_CONTRACT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS field_contracts (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, field_name TEXT NOT NULL, external_name TEXT NOT NULL,
    direction TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (node_id, external_name, direction)
  );
  CREATE INDEX IF NOT EXISTS idx_field_contract_external ON field_contracts(external_name, node_id);
  CREATE INDEX IF NOT EXISTS idx_field_contract_name ON field_contracts(field_name, node_id);
  CREATE INDEX IF NOT EXISTS idx_field_contract_file ON field_contracts(file_path);
  CREATE TABLE IF NOT EXISTS field_contract_files (
    path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
    content_hash TEXT NOT NULL, contract_count INTEGER NOT NULL
  );
`;

export function getFieldContracts(db: SqliteDatabase, nodeId?: string): FieldContract[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'field_contracts'").get()) return [];
  const rows = db.prepare(`SELECT data FROM field_contracts${nodeId ? ' WHERE node_id = ?' : ''} ORDER BY file_path, field_name, external_name, direction`)
    .all(...(nodeId ? [nodeId] : [])) as Array<{ data: string }>;
  return rows.map(row => JSON.parse(row.data) as FieldContract);
}

export function fieldContractNodeIds(db: SqliteDatabase, name: string): string[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'field_contracts'").get()) return [];
  return (db.prepare('SELECT DISTINCT node_id FROM field_contracts WHERE external_name = ? OR field_name = ? ORDER BY node_id')
    .all(name, name) as Array<{ node_id: string }>).map(row => row.node_id);
}

/** Reparse declarations only when bytes or the retained contract rows changed. */
export async function refreshFieldContracts(db: SqliteDatabase, queries: QueryBuilder, root: string, paths?: readonly string[]): Promise<boolean> {
  const yieldToLoop = createYielder();
  const scope = paths ? new Set(paths.map(file => file.replace(/\\/g, '/'))) : null;
  const stamps = db.prepare('SELECT content_hash, contract_count FROM field_contract_files WHERE path = ?');
  const count = db.prepare('SELECT count(*) AS count FROM field_contracts WHERE file_path = ?');
  const insert = db.prepare('INSERT OR REPLACE INTO field_contracts VALUES (?, ?, ?, ?, ?, ?, ?)');
  const stamp = db.prepare('INSERT OR REPLACE INTO field_contract_files VALUES (?, ?, ?)');
  const loaded = new Set<string>();
  let changed = false;
  for (const file of queries.getAllFiles()) {
    if (!FIELD_CONTRACT_LANGUAGES.includes(file.language) || (scope && !scope.has(file.path))) continue;
    await yieldToLoop();
    const previous = stamps.get(file.path) as { content_hash: string; contract_count: number } | undefined;
    const retained = (count.get(file.path) as { count: number }).count;
    if (previous?.content_hash === file.contentHash && retained === previous.contract_count) continue;
    const absolute = validatePathWithinRoot(root, file.path);
    if (!absolute) throw new Error(`Contract source is outside the project: ${file.path}`);
    const source = fs.readFileSync(absolute, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    if (hash !== file.contentHash) throw new Error(`Serialization source changed during indexing: ${file.path}; retry sync.`);
    const hasMarker = /serde\s*\(|json:"|\b(?:Field|JsonProperty|JsonPropertyName)\s*\(/.test(source);
    if (hasMarker && !loaded.has(file.language)) {
      await loadGrammarsForLanguages([file.language]);
      loaded.add(file.language);
    }
    const existing = queries.getNodesByFile(file.path).filter(node => !node.id.startsWith('contract-field:'));
    const result = hasMarker ? extractFieldContracts(file.path, source, file.language, existing) : { contracts: [], nodes: [] };
    if (!result) throw new Error(`Serialization contract grammar is unavailable: ${file.language}`);
    db.transaction(() => {
      for (const node of queries.getNodesByFile(file.path)) if (node.id.startsWith('contract-field:')) queries.deleteNode(node.id);
      db.prepare('DELETE FROM field_contracts WHERE file_path = ?').run(file.path);
      queries.insertNodes(result.nodes);
      for (const contract of result.contracts) {
        insert.run(contract.nodeId, contract.ownerId, contract.filePath, contract.fieldName,
          contract.externalName, contract.direction, JSON.stringify(contract));
      }
      queries.insertEdges(result.nodes.map(node => ({
        source: result.contracts.find(contract => contract.nodeId === node.id)!.ownerId,
        target: node.id, kind: 'contains', provenance: 'tree-sitter',
      })));
      stamp.run(file.path, hash, (count.get(file.path) as { count: number }).count);
    })();
    changed = true;
  }
  return changed;
}
