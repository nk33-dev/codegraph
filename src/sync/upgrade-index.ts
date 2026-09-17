/**
 * `codegraph sync --upgrade-index` 的规划逻辑（个人版）。
 *
 * 背景：提示（status / sync / upgrade 都会提醒 “reindexRecommended”）已经修好，但用户能做的
 * 仍然只有手工 `codegraph index -f .` —— 大仓库上那是一次没有预告、没有确认的完整重建。
 *
 * 本模块把“要不要升级、要升级多少、大概多久、大概占多少磁盘”算清楚，交给 CLI 展示与确认：
 *   - 提取版本只影响部分语言（{@link extractionUpgradeScope} 里有登记）时，可以只重新提取
 *     那些语言的文件（增量迁移）；
 *   - 范围未知或含未登记版本时，如实说明“没有依据做增量迁移”，按完整重建处理。
 *
 * 估算刻意保守并标注依据：耗时优先用本项目的全量索引基线（resource-metrics.json），没有
 * 基线时退化为每文件启发式；磁盘按“现有 DB + WAL × 系数”估计峰值，而不是承诺一个精确数字。
 */
import type CodeGraph from '../index';
import { EXTRACTION_VERSION, extractionUpgradeScope } from '../extraction/extraction-version';
import { readResourceMetricsSnapshot } from '../resource-metrics';
import type { Language } from '../types';

/**
 * 没有基线时的每文件耗时启发式（毫秒）。取自个人版在 8 核/16 线程机器上对约 900 文件仓库的
 * 全量索引实测区间（约 45s，即 ~50ms/文件），再留出余量。它只用于“让用户判断是否现在做”，
 * 一旦有真实基线就会被替换。
 */
const HEURISTIC_MS_PER_FILE = 60;

/** 重建期间的峰值磁盘系数：旧行不会立刻回收，叠加 WAL 后按现有占用的一倍半估计。 */
const PEAK_DISK_FACTOR = 1.5;

export interface IndexUpgradePlan {
  /** 需要重新提取的范围。 */
  scope: 'all' | Language[];
  /** 区间内有未登记的提取版本 —— 只能完整重建（如实告知）。 */
  unrecordedHistory: boolean;
  /** 每个跨过的版本一行说明。 */
  reasons: string[];
  /** 受影响文件数。 */
  affectedFiles: number;
  /** 索引里的文件总数。 */
  totalFiles: number;
  /** 受影响的语言（scope 为 all 时是索引里出现的全部语言）。 */
  affectedLanguages: string[];
  /** 预计耗时（毫秒）。 */
  estimatedDurationMs: number;
  /** 估算耗时的依据：'baseline' 用本项目全量索引基线，'heuristic' 用每文件经验值。 */
  durationBasis: 'baseline' | 'heuristic';
  currentDbBytes: number;
  walBytes: number;
  /** 预计峰值磁盘占用（字节）。 */
  estimatedPeakDiskBytes: number;
  /** 预计相对当前的额外占用（字节）。 */
  estimatedGrowthBytes: number;
}

export interface IndexUpgradeAssessment {
  /** 当前索引是否需要按新的提取版本升级。 */
  needed: boolean;
  builtWith: number | null;
  current: number;
  /** 需要升级时的计划；不需要时为 null。 */
  plan: IndexUpgradePlan | null;
}

/**
 * 判断是否需要升级，并给出预估计划。
 *
 * 只读查询：不启动索引、不写任何文件，因此可以安全地先展示给用户再决定。
 */
export function planIndexUpgrade(cg: CodeGraph): IndexUpgradeAssessment {
  const builtWith = cg.getIndexBuildInfo().extractionVersion;
  const needed = cg.isIndexStale();
  if (!needed) {
    return { needed: false, builtWith, current: EXTRACTION_VERSION, plan: null };
  }

  const stats = cg.getStats();
  const files = cg.getFiles();
  const scopeInfo = extractionUpgradeScope(builtWith, EXTRACTION_VERSION);
  const affected = scopeInfo.scope === 'all'
    ? files
    : files.filter((file) => (scopeInfo.scope as Language[]).includes(file.language));

  const affectedFiles = affected.length;
  const base = stats.dbSizeBytes + stats.walSizeBytes;
  const snapshot = readResourceMetricsSnapshot(cg.getProjectRoot());
  const baselineMs = snapshot?.index.fullLastMs ?? 0;
  const baselineFiles = snapshot?.index.fullLastFiles ?? 0;
  const useBaseline = baselineMs > 0 && baselineFiles > 0;
  const estimatedDurationMs = useBaseline
    ? Math.max(1, Math.round(baselineMs * (affectedFiles / baselineFiles)))
    : Math.max(1, affectedFiles * HEURISTIC_MS_PER_FILE);

  return {
    needed: true,
    builtWith,
    current: EXTRACTION_VERSION,
    plan: {
      scope: scopeInfo.scope,
      unrecordedHistory: scopeInfo.unrecordedHistory,
      reasons: scopeInfo.summaries,
      affectedFiles,
      totalFiles: files.length,
      affectedLanguages: scopeInfo.scope === 'all'
        ? Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([language]) => language)
        : [...scopeInfo.scope],
      estimatedDurationMs,
      durationBasis: useBaseline ? 'baseline' : 'heuristic',
      currentDbBytes: stats.dbSizeBytes,
      walBytes: stats.walSizeBytes,
      estimatedPeakDiskBytes: Math.round(base * PEAK_DISK_FACTOR),
      estimatedGrowthBytes: Math.max(0, Math.round(base * PEAK_DISK_FACTOR) - base),
    },
  };
}

/** 人类可读的耗时：`850ms`、`12s`、`1m 05s`。 */
export function formatUpgradeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** 人类可读的字节数（十进制 MB/GB，与 status 的展示口径一致）。 */
export function formatUpgradeBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
