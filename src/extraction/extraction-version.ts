/**
 * Extraction version
 *
 * A monotonically-increasing integer that identifies the *shape and depth* of
 * what the extractor writes into the graph. Unlike `CURRENT_SCHEMA_VERSION`
 * (which tracks the SQLite table layout and is migrated in place), this tracks
 * the EXTRACTED CONTENT — node kinds, edges, synthesizers, resolver coverage.
 *
 * When an index was built by an older engine whose `EXTRACTION_VERSION` is
 * below the running engine's, the data on disk is structurally fine but
 * *stale*: it's missing whatever a newer extractor would now produce. A schema
 * migration can't backfill that — only a re-index can. So this is the signal
 * `codegraph status` uses to recommend a re-index, and the reason `codegraph
 * upgrade` reminds users to refresh their projects.
 *
 * BUMP THIS when a release changes extraction output enough that existing
 * indexes should be rebuilt to benefit — e.g. a new language/framework
 * extractor, a new dynamic-dispatch synthesizer, a new node/edge kind, or a
 * resolver fix that materially changes which edges exist. Do NOT bump for
 * pure bug fixes, CLI/UX changes, or schema-only migrations. Over-bumping
 * turns the re-index hint into noise — keep it honest (see CLAUDE.md, "Honesty
 * in the product is load-bearing").
 *
 * When incrementing this value, also record the affected language scope in
 * {@link EXTRACTION_UPGRADES}. `sync --upgrade-index` can migrate incrementally
 * only when every crossed extraction change has a compatible recorded scope.
 */
import type { Language } from '../types';
export const EXTRACTION_VERSION = 30;

/**
 * Extraction scope affected by each version increment.
 *
 * `codegraph sync --upgrade-index` uses this registry to decide whether it can
 * re-extract only affected languages or must rebuild everything. Missing versions
 * have unknown scope and conservatively force a full rebuild with an explicit reason.
 *
 * Register each new increment here. `scope: 'all'` means any language may be affected.
 */
export interface ExtractionUpgradeScope {
  version: number;
  /** `all` means any language may be affected; otherwise only the listed languages are affected. */
  scope: 'all' | readonly Language[];
  summary: string;
}

/**
 * Tracking starts at extraction version 27.
 * Earlier increments have no recorded scope, so upgrading an older index conservatively
 * requires a full rebuild instead of claiming compatibility without evidence.
 */
export const EXTRACTION_UPGRADES: readonly ExtractionUpgradeScope[] = [
  {
    version: 27,
    // Two changes landed under this number: the fork's own v27 (namespace imports
    // and identifier-anchored call/constructor edges) and upstream's v27
    // (method-value receivers). An index stamped 27 by either lineage has one of
    // them, so the crossed set is only honest if it names both.
    scope: 'all',
    summary:
      'Map dynamic namespace imports, anchor call and constructor edges to the identifier '
      + 'column, and preserve receivers for method values',
  },
  {
    version: 28,
    // The fork spent 27 on its own change, so an index it stamped 27 never extracted
    // upstream v1.6.1's method-value receivers. This increment is what makes
    // `isIndexStale()` report that index and `sync --upgrade-index` rebuild it.
    scope: 'all',
    summary:
      'Re-extract for upstream v1.6.1: method-value receivers, call-graph and Steps coverage '
      + 'restored by the regression audit, and the v1.6.1 extraction fixes',
  },
  {
    version: 29,
    scope: ['csharp', 'vbnet'],
    summary: 'Bridge the upstream v28 C# and VB.NET extraction changes for personal indexes that already crossed v29',
  },
  {
    version: 30,
    scope: 'all',
    summary: 'Re-extract for upstream language fixes, recover cross-file relationships and synthesize Vue/React composable, router, props and emits bindings',
  },
];

export interface ExtractionUpgradePlanScope {
  /** `all` or the set of languages that must be re-extracted. */
  scope: 'all' | Language[];
  /** One explanation per crossed version that has a registry entry. */
  summaries: string[];
  /** True when any crossed version lacks a recorded scope and therefore forces a full rebuild. */
  unrecordedHistory: boolean;
}

/**
 * Return the re-extraction scope required to upgrade from `from` to `to` (current by default).
 *
 * `from === null` or any unrecorded crossed version returns `scope: 'all'` with
 * `unrecordedHistory`, allowing callers to state that incremental migration lacks evidence.
 */
export function extractionUpgradeScope(
  from: number | null,
  to: number = EXTRACTION_VERSION,
): ExtractionUpgradePlanScope {
  if (from === null || !Number.isFinite(from) || from >= to) {
    return { scope: 'all', summaries: [], unrecordedHistory: from === null };
  }
  const summaries: string[] = [];
  const languages = new Set<Language>();
  let unrecorded = false;
  let allLanguages = false;
  for (let version = from + 1; version <= to; version += 1) {
    const entry = EXTRACTION_UPGRADES.find((candidate) => candidate.version === version);
    if (!entry) { unrecorded = true; continue; }
    summaries.push(`v${version}: ${entry.summary}`);
    if (entry.scope === 'all') { allLanguages = true; continue; }
    for (const language of entry.scope) languages.add(language);
  }
  if (unrecorded || allLanguages || languages.size === 0) {
    return { scope: 'all', summaries, unrecordedHistory: unrecorded };
  }
  return { scope: [...languages], summaries, unrecordedHistory: false };
}
