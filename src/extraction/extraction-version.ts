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
 * 递增时同时在 {@link EXTRACTION_UPGRADES} 登记这次影响的语言范围，`sync --upgrade-index`
 * 才能在提取规则兼容时走增量迁移而不是完整重建。
 */
import type { Language } from '../types';
export const EXTRACTION_VERSION = 26;

/**
 * 每个版本递增影响的提取范围。
 *
 * 用途：`codegraph sync --upgrade-index` 决定能否只重新提取受影响的语言（增量迁移），
 * 还是必须完整重建。表里没有登记的版本一律按“范围未知”处理 —— 保守地走完整重建，
 * 并在计划里明说原因，不假装兼容。
 *
 * 新增一次递增时在这里登记；`scope: 'all'` 表示该次变更可能影响任何语言的提取结果。
 */
export interface ExtractionUpgradeScope {
  version: number;
  /** 'all' 表示任何语言都可能受影响；否则只影响列出的语言。 */
  scope: 'all' | readonly Language[];
  summary: string;
}

/**
 * 从 {@link EXTRACTION_VERSION} **之前一次**开始维护：历史递增没有登记范围，因此任何从旧索引
 * 升级的请求都会被保守地判为“需要完整重建”。这不是缺陷，而是不愿意在没有依据时声称兼容。
 */
export const EXTRACTION_UPGRADES: readonly ExtractionUpgradeScope[] = [];

export interface ExtractionUpgradePlanScope {
  /** 'all' 或需要重新提取的语言集合。 */
  scope: 'all' | Language[];
  /** 每个跨过的版本一行说明（已登记的才有）。 */
  summaries: string[];
  /** true 表示区间里有版本没有登记范围 —— 只能完整重建。 */
  unrecordedHistory: boolean;
}

/**
 * 从 `from` 升到 `to`（默认当前版本）需要重新提取的范围。
 *
 * `from === null`（索引早于打标功能）或区间里存在未登记的版本时返回 `scope: 'all'`，
 * 并置 `unrecordedHistory`，让调用方如实说明“没有依据做增量迁移”。
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
  for (let version = from + 1; version <= to; version += 1) {
    const entry = EXTRACTION_UPGRADES.find((candidate) => candidate.version === version);
    if (!entry) { unrecorded = true; continue; }
    summaries.push(`v${version}: ${entry.summary}`);
    if (entry.scope === 'all') return { scope: 'all', summaries, unrecordedHistory: false };
    for (const language of entry.scope) languages.add(language);
  }
  if (unrecorded || languages.size === 0) {
    return { scope: 'all', summaries, unrecordedHistory: unrecorded };
  }
  return { scope: [...languages], summaries, unrecordedHistory: false };
}
