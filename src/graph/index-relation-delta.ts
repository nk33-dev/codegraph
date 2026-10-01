import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { Edge } from '../types';
import { describeEdgeEvidence, type RelationEvidence } from './edge-provenance';

export interface IndexRelationChanges {
  added: number;
  removed: number;
  deduplicated: number;
  before: number;
  after: number;
  groups: Array<{ kind: Edge['kind']; evidence: RelationEvidence; added: number; removed: number; deduplicated: number }>;
  examples: Array<{ change: 'added' | 'removed' | 'deduplicated'; kind: Edge['kind']; source: string; target: string; line: number | null; evidence: RelationEvidence }>;
  examplesTruncated: boolean;
}

const SNAPSHOT_SELECT = `
  SELECT json_array(s.file_path, s.qualified_name, s.kind, s.language, s.signature,
    t.file_path, t.qualified_name, t.kind, t.language, t.signature,
    e.kind, e.line, e.col, e.provenance,
    json_extract(e.metadata, '$.resolvedBy'), json_extract(e.metadata, '$.synthesizedBy'),
    json_extract(e.metadata, '$.inferred'), json_extract(e.metadata, '$.confidence'),
    json_extract(e.metadata, '$.registeredAt')) AS relation_key,
    e.kind, e.provenance, e.line,
    json_object('resolvedBy', json_extract(e.metadata, '$.resolvedBy'),
      'synthesizedBy', json_extract(e.metadata, '$.synthesizedBy'),
      'inferred', json_extract(e.metadata, '$.inferred'),
      'confidence', json_extract(e.metadata, '$.confidence')) AS metadata,
    s.file_path || '#' || s.qualified_name AS source,
    t.file_path || '#' || t.qualified_name AS target,
    COUNT(*) AS copies
  FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
  GROUP BY relation_key`;

const DELTA_SELECT = `
  SELECT 'added' AS change, a.*, 1 AS amount FROM relation_upgrade.after_relations a
    LEFT JOIN relation_upgrade.before_relations b USING (relation_key) WHERE b.relation_key IS NULL
  UNION ALL
  SELECT 'removed', b.*, 1 FROM relation_upgrade.before_relations b
    LEFT JOIN relation_upgrade.after_relations a USING (relation_key) WHERE a.relation_key IS NULL
  UNION ALL
  SELECT 'deduplicated', a.*, b.copies - a.copies FROM relation_upgrade.after_relations a
    JOIN relation_upgrade.before_relations b USING (relation_key) WHERE b.copies > a.copies`;

type DeltaRow = {
  change: 'added' | 'removed' | 'deduplicated'; kind: Edge['kind']; provenance: Edge['provenance'];
  metadata: string; source: string; target: string; line: number | null; amount: number;
};

function evidenceOf(row: DeltaRow): RelationEvidence {
  const metadata = JSON.parse(row.metadata);
  metadata.inferred = metadata.inferred === 1 || metadata.inferred === true;
  return describeEdgeEvidence({ source: row.source, target: row.target, kind: row.kind,
    provenance: row.provenance ?? undefined, line: row.line ?? undefined, metadata });
}

/** Keep relation snapshots on disk without changing the main connection's temp_store setting. */
export class IndexRelationSnapshot {
  private directory: string;
  private file: string;
  private attached = false;

  constructor(private db: SqliteDatabase) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-upgrade-relations-'));
    this.file = path.join(this.directory, 'relations.sqlite');
    try {
      this.db.prepare('ATTACH DATABASE ? AS relation_upgrade').run(this.file);
      this.attached = true;
      this.db.exec(`CREATE TABLE relation_upgrade.before_relations AS ${SNAPSHOT_SELECT}`);
      this.db.exec('CREATE UNIQUE INDEX relation_upgrade.before_key ON before_relations(relation_key)');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  compare(): IndexRelationChanges {
    this.db.exec(`CREATE TABLE relation_upgrade.after_relations AS ${SNAPSHOT_SELECT}`);
    this.db.exec('CREATE UNIQUE INDEX relation_upgrade.after_key ON after_relations(relation_key)');
    const report: IndexRelationChanges = {
      added: 0, removed: 0, deduplicated: 0,
      before: this.db.prepare('SELECT COUNT(*) AS count FROM relation_upgrade.before_relations').get().count,
      after: this.db.prepare('SELECT COUNT(*) AS count FROM relation_upgrade.after_relations').get().count,
      groups: [], examples: [], examplesTruncated: false,
    };
    const groups = new Map<string, IndexRelationChanges['groups'][number]>();
    const rows = this.db.prepare(`SELECT change, kind, provenance, metadata, line > 0 AS has_line, SUM(amount) AS amount
      FROM (${DELTA_SELECT}) GROUP BY change, kind, provenance, metadata, has_line ORDER BY kind, change, provenance, metadata`);
    for (const row of rows.iterate()) {
      const evidence = evidenceOf({ ...row, line: row.has_line ? 1 : null });
      const key = JSON.stringify([row.kind, evidence]);
      let group = groups.get(key);
      if (!group) {
        group = { kind: row.kind, evidence, added: 0, removed: 0, deduplicated: 0 };
        groups.set(key, group);
      }
      group[row.change as DeltaRow['change']] += row.amount;
      report[row.change as DeltaRow['change']] += row.amount;
    }
    report.groups = [...groups.values()];
    const examples = this.db.prepare(`SELECT * FROM (${DELTA_SELECT}) ORDER BY kind, change, source, target, line LIMIT 21`).all() as DeltaRow[];
    report.examplesTruncated = examples.length > 20;
    report.examples = examples.slice(0, 20).map((row) => ({ change: row.change, kind: row.kind,
      source: row.source, target: row.target, line: row.line, evidence: evidenceOf(row) }));
    return report;
  }

  close(): void {
    if (this.attached) {
      this.db.exec('DETACH DATABASE relation_upgrade');
      this.attached = false;
    }
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    if (fs.existsSync(this.directory)) fs.rmdirSync(this.directory);
  }
}

export function formatIndexRelationChanges(report: IndexRelationChanges): string {
  return [
    `Relations: +${report.added} added, -${report.removed} removed, ${report.deduplicated} duplicate records removed (${report.before} → ${report.after} unique sites).`,
    ...report.groups.map((group) => `  ${group.kind}: +${group.added} -${group.removed}, deduplicated ${group.deduplicated}; ${group.evidence.classification}, source=${group.evidence.source}, confidence=${group.evidence.confidence}`),
    ...report.examples.map((example) => `  ${example.change} ${example.kind}: ${example.source} → ${example.target}${example.line === null ? '' : ` @ ${example.line}`} [${example.evidence.source}, ${example.evidence.confidence}]`),
    ...(report.examplesTruncated ? ['  Examples truncated at 20; grouped counts cover all changed relationships.'] : []),
    'Identity uses symbol paths, relation kind, site and evidence; changed evidence is reported as a removal and an addition. Deduplication counts only redundant records of retained sites.',
  ].join('\n');
}
