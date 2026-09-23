import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqliteDatabase } from './sqlite-adapter';
import { scanTextFiles } from '../extraction';
import { validatePathWithinRoot } from '../utils';

const MAX_FILE_BYTES = 256 * 1024;

function textFileStat(root: string, filePath: string): fs.Stats | null {
  if (filePath.split('/').some((part) => part === '.git' || part === '.codegraph' || part === 'node_modules')
    || /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(filePath)) return null;
  const absolute = validatePathWithinRoot(root, filePath);
  if (!absolute) return null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const descriptor = fs.openSync(absolute, 'r');
    try {
      const sample = Buffer.alloc(Math.min(stat.size, 1024));
      fs.readSync(descriptor, sample, 0, sample.length, 0);
      return sample.includes(0) ? null : stat;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

export interface TextIndexChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export function getFileTextChanges(db: SqliteDatabase, root: string): TextIndexChanges {
  const records = new Map<string, { size: number; modified_at: number }>(
    (db.prepare('SELECT path, size, modified_at FROM file_text').all() as Array<{ path: string; size: number; modified_at: number }>)
      .map((record) => [record.path, record]),
  );
  const changes: TextIndexChanges = { added: [], modified: [], removed: [] };
  for (const rawPath of scanTextFiles(root)) {
    const filePath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const stat = textFileStat(root, filePath);
    if (!stat) continue;
    const record = records.get(filePath);
    if (!record) changes.added.push(filePath);
    else if (record.size !== stat.size || record.modified_at !== stat.mtimeMs) changes.modified.push(filePath);
    records.delete(filePath);
  }
  changes.removed.push(...records.keys());
  for (const paths of Object.values(changes)) paths.sort();
  return changes;
}

export interface TextHit {
  filePath: string;
  lines: Array<{ line: number; text: string }>;
  occurrences: number;
  indexedAt: number;
  freshness: 'current' | 'changed' | 'missing';
}

export function ensureFileTextIndex(db: SqliteDatabase): void {
  try {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE name = 'file_text_fts'").get();
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS file_text_fts USING fts5(content, content='file_text', content_rowid='rowid')");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS file_text_ai AFTER INSERT ON file_text BEGIN
        INSERT INTO file_text_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS file_text_ad AFTER DELETE ON file_text BEGIN
        INSERT INTO file_text_fts(file_text_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS file_text_au AFTER UPDATE ON file_text BEGIN
        INSERT INTO file_text_fts(file_text_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO file_text_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    if (!existing) db.exec("INSERT INTO file_text_fts(file_text_fts) VALUES ('rebuild')");
  } catch {
    db.exec('DROP TRIGGER IF EXISTS file_text_ai; DROP TRIGGER IF EXISTS file_text_ad; DROP TRIGGER IF EXISTS file_text_au');
  }
}

export async function refreshFileTextIndex(
  db: SqliteDatabase,
  root: string,
  paths?: readonly string[],
): Promise<void> {
  const candidates = paths ? [...paths] : scanTextFiles(root);
  const existing = new Map<string, { size: number; modified_at: number }>(
    (db.prepare('SELECT path, size, modified_at FROM file_text').all() as Array<{ path: string; size: number; modified_at: number }>)
      .map((record) => [record.path, record]),
  );
  const upsert = db.prepare(`INSERT INTO file_text(path, content, size, modified_at, indexed_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET
    content = excluded.content, size = excluded.size, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at`);
  const remove = db.prepare('DELETE FROM file_text WHERE path = ?');
  const seen = new Set<string>();
  for (let index = 0; index < candidates.length; index++) {
    const rawPath = candidates[index]!;
    const filePath = (path.isAbsolute(rawPath) ? path.relative(root, rawPath) : rawPath)
      .replace(/\\/g, '/').replace(/^\.\//, '');
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const stat = textFileStat(root, filePath);
    if (!stat) { remove.run(filePath); continue; }
    const absolute = validatePathWithinRoot(root, filePath);
    if (!absolute) continue;
    try {
      const previous = existing.get(filePath);
      if (previous?.size === stat.size && previous.modified_at === stat.mtimeMs) continue;
      const bytes = fs.readFileSync(absolute);
      if (bytes.includes(0)) { remove.run(filePath); continue; }
      upsert.run(filePath, bytes.toString('utf8'), stat.size, stat.mtimeMs, Date.now());
    } catch {
      remove.run(filePath);
    }
    if (index % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!paths) {
    for (const filePath of existing.keys()) if (!seen.has(filePath)) remove.run(filePath);
  }
}

export function searchFileText(
  db: SqliteDatabase,
  root: string,
  query: string,
  options: { offset: number; limit: number; file?: string },
): { items: TextHit[]; total: number; nextOffset: number | null } {
  const fileFilter = options.file ? ' AND file_text.path = ?' : '';
  const hasFts = query.length >= 3 && Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = 'file_text_fts'").get());
  const source = hasFts
    ? "file_text_fts JOIN file_text ON file_text.rowid = file_text_fts.rowid WHERE file_text_fts MATCH ? AND instr(lower(file_text.content), lower(?)) > 0"
    : 'file_text WHERE instr(lower(file_text.content), lower(?)) > 0';
  const params = hasFts ? [`"${query.replace(/"/g, '""')}"`, query] : [query];
  if (options.file) params.push(options.file);
  const total = (db.prepare(`SELECT count(*) AS count FROM ${source}${fileFilter}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT file_text.path, file_text.content, file_text.indexed_at, file_text.size, file_text.modified_at FROM ${source}${fileFilter}
    ORDER BY file_text.path LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset) as Array<{
    path: string; content: string; indexed_at: number; size: number; modified_at: number;
  }>;
  const items = rows.map((row) => {
    const absolute = validatePathWithinRoot(root, row.path);
    let freshness: TextHit['freshness'] = 'missing';
    if (absolute) {
      try {
        const stat = fs.statSync(absolute);
        freshness = stat.isFile() && stat.size === row.size && stat.mtimeMs === row.modified_at ? 'current' : 'changed';
      } catch { /* 文件已删除或不可访问。 */ }
    }
    const lines: TextHit['lines'] = [];
    let occurrences = 0;
    const configFile = /\.(?:json|jsonc|ya?ml|toml|properties|ini|conf|config|xml)$/i.test(row.path);
    for (const [index, text] of (freshness === 'current' ? row.content : '').split(/\r?\n/).entries()) {
      if (!text.toLowerCase().includes(query.toLowerCase())) continue;
      occurrences++;
      if (lines.length < 5) lines.push({
        line: index + 1, text: configFile ? '[configuration value omitted]' : text.trim().slice(0, 240),
      });
    }
    return { filePath: row.path, lines, occurrences, indexedAt: row.indexed_at, freshness };
  });
  return { items, total, nextOffset: options.offset + items.length < total ? options.offset + items.length : null };
}
