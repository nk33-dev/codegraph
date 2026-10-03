import * as path from 'path';
import { readFileSync } from 'fs';
import type { IndexTaskLevel } from '../resource-profile';

export type RefreshScope = 'file' | 'related' | 'project';

export interface RefreshPlan {
  filePath: string;
  taskLevel: IndexTaskLevel;
  scope: RefreshScope;
  reason: string;
  /** `related` only: the changed file plus every file whose resolved edges reach it. */
  files?: string[];
}

/** A symbol as the planner compares it: the index's own identity (qualified name + kind + export flag). */
export interface RefreshSymbol {
  qualifiedName: string;
  kind: string;
  isExported: boolean;
  startLine: number;
}

/**
 * What the planner reads: the index's last snapshot of the file and the extractor the index itself
 * uses. Kept as an interface rather than a CodeGraph argument so the decision stays a pure function
 * a unit test can drive without a database.
 */
export interface RefreshSources {
  /** Text the index last saw for this file; null when the file is not in the text index. */
  indexedText(filePath: string): string | null;
  /** Symbols the index holds for this file (the snapshot the change is compared against). */
  indexedSymbols(filePath: string): RefreshSymbol[];
  /** Symbols the current text produces, through the same extractor the index uses. */
  extractSymbols(filePath: string, source: string): RefreshSymbol[];
  /** Files whose resolved symbol edges reach this one — who imports or calls into it. */
  dependents(filePath: string): string[];
}

const GLOBAL_CONFIG = /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|Cargo\.toml|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|requirements(?:\.txt|\.in)|pyproject\.toml|\.codegraph(?:\.json)?)$/i;

/**
 * Import/include/require lines. A change to one of these moves where a symbol comes from even when
 * no symbol was added or removed, so the dependents' resolution has to run again. This tests
 * whether *these lines changed*, not whether the keywords appear anywhere in the file.
 */
const IMPORT_LINE = /^\s*(?:import\b|from\b|export\s+(?:default\s+)?(?:\*|\{|type\b)|require\s*\(|#include\b|using\b|use\s+\w|source\s+|@import\b)/;

/** A hub file can have thousands of dependents; a refresh plan stays a targeted operation. */
const MAX_RELATED_FILES = 200;

/**
 * Plan the scope and resource level of one targeted refresh.
 *
 * The decision comes from the actual change, not from whether the file mentions interface/export/
 * route keywords anywhere: the index's symbol snapshot is compared with the symbols the same
 * extractor produces from the current text, and only a changed export surface or import block widens
 * the refresh to the dependents the resolved symbol graph names. A body-only edit stays inside the
 * file; an unreadable file is treated as an ordinary one, because the sync itself still treats the
 * filesystem as the source of truth.
 */
export function planRefresh(projectRoot: string, filePath: string, sources: RefreshSources): RefreshPlan {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (GLOBAL_CONFIG.test(normalized)) {
    return { filePath: normalized, taskLevel: 'global', scope: 'project', reason: 'project configuration changed' };
  }

  let next: string;
  try {
    next = readFileSync(path.resolve(projectRoot, normalized), 'utf8');
  } catch {
    return {
      filePath: normalized, taskLevel: 'ordinary', scope: 'file',
      reason: 'the file could not be read; the sync still treats the filesystem as the source of truth',
    };
  }

  const previous = sources.indexedText(normalized);
  const before = sources.indexedSymbols(normalized);
  if (previous === null || before.length === 0) {
    return {
      filePath: normalized, taskLevel: 'ordinary', scope: 'file',
      reason: 'the file has no indexed snapshot to compare against, so only the file itself is reindexed',
    };
  }
  if (previous === next) {
    return { filePath: normalized, taskLevel: 'ordinary', scope: 'file', reason: 'the file already matches the indexed bytes' };
  }

  const previousLines = previous.split(/\r?\n/);
  const nextLines = next.split(/\r?\n/);
  const importsChanged = importSurface(previousLines) !== importSurface(nextLines);

  let exportedChanged: boolean;
  try {
    exportedChanged = exportSurfaceChanged(before, sources.extractSymbols(normalized, next), previousLines, nextLines);
  } catch {
    // The extractor refused the new text (a parse failure, or an unsupported override). Falling
    // back to the narrower scope could drop a real cross-file change, so say "related" instead.
    return relatedPlan(normalized, sources, 'the changed file could not be parsed, so its dependents are re-resolved too');
  }

  if (importsChanged) {
    return relatedPlan(normalized, sources, 'import/export lines changed, so the files that depend on this one are re-resolved');
  }
  if (exportedChanged) {
    return relatedPlan(normalized, sources, "an exported symbol's name, kind or declaration changed, so its dependents are re-resolved");
  }
  return {
    filePath: normalized, taskLevel: 'ordinary', scope: 'file',
    reason: 'only body-level code changed, so the refresh stays inside the file',
  };
}

/** The changed file plus its dependents, deduplicated and capped. */
function relatedPlan(normalized: string, sources: RefreshSources, reason: string): RefreshPlan {
  let dependents: string[] = [];
  try {
    dependents = sources.dependents(normalized).map((file) => file.replace(/\\/g, '/'));
  } catch {
    // No dependent list available: the plan still names the changed file and lets the caller's
    // normal resolution pass fix the edges that point at it.
    dependents = [];
  }
  const files = [...new Set([normalized, ...dependents.filter((file) => file !== normalized)])].slice(0, MAX_RELATED_FILES);
  return { filePath: normalized, taskLevel: 'interface', scope: 'related', reason, files };
}

/** The set of import-ish lines, normalized so a reorder or a whitespace tweak is not a change. */
function importSurface(lines: string[]): string {
  return lines.filter((line) => IMPORT_LINE.test(line)).map((line) => line.replace(/\s+/g, ' ').trim()).sort().join('\n');
}

/**
 * Whether the exported surface moved: a symbol added or removed, a kind change, or a changed
 * declaration line on an exported symbol. The declaration line is the closest a line-oriented
 * comparison gets to a signature; a body-only edit leaves it untouched.
 */
function exportSurfaceChanged(
  before: RefreshSymbol[],
  after: RefreshSymbol[],
  previousLines: string[],
  nextLines: string[],
): boolean {
  const beforeExported = new Map(before.filter((symbol) => symbol.isExported).map((symbol) => [symbol.qualifiedName, symbol]));
  const afterExported = new Map(after.filter((symbol) => symbol.isExported).map((symbol) => [symbol.qualifiedName, symbol]));
  if (beforeExported.size !== afterExported.size) return true;
  for (const [name, symbol] of beforeExported) {
    const next = afterExported.get(name);
    if (!next || next.kind !== symbol.kind) return true;
    if (signatureOf(previousLines, symbol) !== signatureOf(nextLines, next)) return true;
  }
  return false;
}

/**
 * The declaration's signature: its line folded and cut at the first `{` or `=>`, so a one-line
 * body does not read as a signature change. A line with neither keeps its whole text (conservative:
 * the refresh widens rather than missing a cross-file change).
 */
function signatureOf(lines: string[], symbol: RefreshSymbol): string {
  const folded = (lines[symbol.startLine - 1] ?? '').replace(/\s+/g, ' ').trim();
  const cuts = [folded.indexOf('{'), folded.indexOf('=>')].filter((index) => index >= 0);
  return cuts.length === 0 ? folded : folded.slice(0, Math.min(...cuts)).trim();
}
