/**
 * Regression cover for the fork's schema-version collision.
 *
 * This fork authored its `file_text` migration as version 10 before upstream claimed
 * the same number for the synthesis stage. A database written by the fork recorded
 * "10" meaning `file_text`, and `runMigrations` only runs numbers above MAX(version) —
 * so the synthesis stage was skipped silently and `synthesis_inputs` was never created.
 * Version 12 replays it for exactly those databases; this test fakes that state and
 * checks the repair, because a silently incomplete index is not something a later
 * query would report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';

/** What the fork's own schema_versions row says for version 10. */
const FORK_V10_DESCRIPTION = 'Add persisted file content for project-wide text search';

describe('fork schema bridge: file_text at 10, synthesis at 12', () => {
  let dir: string;
  let connection: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fork-bridge-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const db = connection.getDb();

    // Rewind to the state a fork-written database is actually in: file_text recorded
    // as version 10, and none of the synthesis stage present.
    db.exec(`
      DROP INDEX IF EXISTS idx_edges_synthesis_site;
      DROP TABLE IF EXISTS synthesis_inputs;
      DROP INDEX IF EXISTS idx_nodes_kind;
      CREATE INDEX idx_nodes_kind ON nodes(kind);
      DELETE FROM schema_versions WHERE version >= 10;
      INSERT INTO schema_versions(version, applied_at, description)
        VALUES (10, 0, '${FORK_V10_DESCRIPTION}');
    `);
    db.prepare('INSERT INTO file_text(path, content, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?)')
      .run('kept.ts', 'const kept = 1;\n', 17, 0, 0);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sqlOf = (name: string): string | undefined =>
    (connection.getDb().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as
      | { sql: string }
      | undefined)?.sql;

  it('replays the skipped synthesis stage and keeps the fork table and its rows', () => {
    runMigrations(connection.getDb(), 10);

    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(sqlOf('synthesis_inputs')).toBeDefined();
    expect(sqlOf('idx_edges_synthesis_site')).toContain('json_valid');
    // The bridge must widen idx_nodes_kind back to the definition upstream ships.
    expect(sqlOf('idx_nodes_kind')).toContain('file_path');
    // The fork's own table and its contents survive the repair.
    expect(sqlOf('file_text')).toBeDefined();
    expect(connection.getDb().prepare('SELECT content FROM file_text WHERE path = ?').get('kept.ts'))
      .toEqual({ content: 'const kept = 1;\n' });
    // The synthesis stage is queued rather than assumed complete.
    expect(
      connection.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get()
    ).toEqual({ value: '1' });
  });

  it('leaves the edges it found untouched, and is a no-op on a second run', () => {
    const db = connection.getDb();
    new QueryBuilder(db).insertNodes(['n1', 'n2'].map(id => ({
      id, name: id, qualifiedName: id, kind: 'function', language: 'typescript',
      filePath: `${id === 'n1' ? 'a' : 'b'}.ts`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
      updatedAt: 0,
    })));
    db.prepare("INSERT INTO edges(source, target, kind, provenance, line) VALUES ('n1', 'n2', 'calls', NULL, 3)").run();

    const edgesBefore = db.prepare('SELECT * FROM edges ORDER BY id').all();
    runMigrations(db, 10);
    expect(db.prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(edgesBefore);

    const versionAfterFirstRun = getCurrentVersion(db);
    runMigrations(db, versionAfterFirstRun);
    expect(db.prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(edgesBefore);
    expect(getCurrentVersion(db)).toBe(versionAfterFirstRun);
  });
});
