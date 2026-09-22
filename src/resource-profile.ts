/**
 * 资源档位（`battery` / `balanced` / `performance`）。
 *
 * 背景：CodeGraph 的主要用户是 AI 代理，同一台机器上常同时运行多个窗口和子
 * Agent。此前的资源上限按逻辑核数推导，且进程一旦扩容就不再缩容，电池供电时
 * 会长期占用 CPU。阶段一用显式档位统一给出「查询 worker、解析 worker、LSP
 * 数量、空闲退出、会话缓存」的默认预算，并保留已有的精细环境变量覆盖档位值。
 *
 * 约定：
 *   - 只在显式配置里做取舍，不做不可靠的跨平台电池检测（见开发计划 §4）；
 *   - `CODEGRAPH_RESOURCE_GOVERNANCE=0` 关闭全部治理，回退到旧行为；
 *   - 所有数值都会做区间钳制，非法输入回退档位默认值而不是抛错。
 */

import { logWarn } from './errors';

export type ResourceProfileName = 'battery' | 'balanced' | 'performance';

/** 索引任务等级：普通保存、接口/导出/路由等结构变更、全局配置变更。 */
export type IndexTaskLevel = 'ordinary' | 'interface' | 'global';

/** 深度双索引（阶段四）的档位策略；阶段一只解析与展示，不改变现有行为。 */
export type DeepDualIndexPolicy = 'explicit' | 'onDemand' | 'prewarm';

export interface ResourceProfileSettings {
  /** 档位名（已解析生效的那个）。 */
  name: ResourceProfileName;
  /** 资源治理总开关；false 时所有消费者回退到治理前的行为。 */
  governanceEnabled: boolean;
  /** 查询 worker 初始（预热）数量。 */
  queryWorkersInitial: number;
  /** 查询 worker 缩容后保留的最小数量。 */
  queryWorkersMin: number;
  /** 查询 worker 最大数量（硬上限 16 仍生效）。 */
  queryWorkersMax: number;
  /** 查询 worker 空闲多久后自动缩容；0 表示不缩容。 */
  queryIdleShrinkMs: number;
  /** 全量解析 worker 最大值（对按内存/CPU 推导的结果取上限）。 */
  resolveWorkersMax: number;
  /** 每个项目的 LSP 软目标数量。 */
  lspPerProjectSoftMax: number;
  /** 跨 daemon 的全局 LSP 上限。 */
  lspGlobalMax: number;
  /** LSP 空闲退出时间。 */
  lspIdleTimeoutMs: number;
  /** 每项目会话缓存预算（MB）；由 ExploreSessionState 按 UTF-8 字节执行。 */
  sessionCacheMb: number;
  /** 深度双索引策略。 */
  deepDualIndex: DeepDualIndexPolicy;
  /** 各任务等级允许使用的解析 worker 上限；普通保存不会默认打满机器。 */
  indexWorkers: Record<IndexTaskLevel, number>;
}

/** 查询 worker 的硬上限，任何配置都不能超过。 */
export const MAX_QUERY_WORKERS = 16;

export const DEFAULT_RESOURCE_PROFILE: ResourceProfileName = 'balanced';

/** 档位默认值，与开发计划 §4 的表格一一对应。 */
const PROFILE_TABLE: Record<ResourceProfileName, Omit<ResourceProfileSettings, 'name' | 'governanceEnabled'>> = {
  battery: {
    queryWorkersInitial: 1,
    queryWorkersMin: 1,
    queryWorkersMax: 2,
    // 表格给的是 30～60 秒区间，取中值。
    queryIdleShrinkMs: 45_000,
    resolveWorkersMax: 2,
    lspPerProjectSoftMax: 1,
    lspGlobalMax: 2,
    lspIdleTimeoutMs: 90_000,
    sessionCacheMb: 64,
    deepDualIndex: 'explicit',
    indexWorkers: { ordinary: 1, interface: 2, global: 2 },
  },
  balanced: {
    queryWorkersInitial: 1,
    queryWorkersMin: 1,
    queryWorkersMax: 4,
    queryIdleShrinkMs: 120_000,
    // 表格给的是 4～6，取 5：既高于旧的最小可用值，也不撞旧实现的 6 核上限。
    resolveWorkersMax: 5,
    lspPerProjectSoftMax: 2,
    lspGlobalMax: 3,
    lspIdleTimeoutMs: 300_000,
    sessionCacheMb: 128,
    deepDualIndex: 'onDemand',
    indexWorkers: { ordinary: 1, interface: 3, global: 5 },
  },
  performance: {
    queryWorkersInitial: 2,
    queryWorkersMin: 2,
    queryWorkersMax: 8,
    queryIdleShrinkMs: 300_000,
    resolveWorkersMax: 8,
    lspPerProjectSoftMax: 3,
    lspGlobalMax: 6,
    lspIdleTimeoutMs: 600_000,
    sessionCacheMb: 256,
    deepDualIndex: 'prewarm',
    indexWorkers: { ordinary: 2, interface: 5, global: 8 },
  },
};

/** 已警告过的档位取值，避免每次读取都刷同一条 stderr。 */
const warnedProfileValues = new Set<string>();

function warnProfileOnce(raw: string): void {
  if (warnedProfileValues.has(raw)) return;
  warnedProfileValues.add(raw);
  logWarn(`Ignoring CODEGRAPH_RESOURCE_PROFILE="${raw}": expected battery, balanced or performance`, {
    fallback: DEFAULT_RESOURCE_PROFILE,
  });
}

/** 解析档位名；无法识别时返回 null（调用方回退默认档位并告警）。 */
export function parseResourceProfileName(raw: string | undefined): ResourceProfileName | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === 'battery' || value === 'balanced' || value === 'performance') return value;
  return null;
}

/** 资源治理总开关：`0` / `false` / `off` 关闭，其余（含未设置）开启。 */
export function resourceGovernanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEGRAPH_RESOURCE_GOVERNANCE;
  if (raw === undefined || raw.trim() === '') return true;
  const value = raw.trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * 读取整数环境变量。`min`/`max` 做区间钳制；空值、非数字回退 `fallback`。
 * `allowZero` 用于「0 = 关闭该行为」的开关型变量。
 */
function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  allowZero = false,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (value < 0) return fallback;
  if (value === 0) return allowZero ? 0 : Math.max(min, fallback);
  return Math.min(Math.max(value, min), max);
}

/**
 * 解析生效的资源档位。环境变量逐个覆盖档位默认值（开发计划 §4：
 * 「现有精细环境变量继续保留并覆盖 profile 默认值」）。
 */
export function resolveResourceProfile(env: NodeJS.ProcessEnv = process.env): ResourceProfileSettings {
  const requested = env.CODEGRAPH_RESOURCE_PROFILE;
  const parsed = parseResourceProfileName(requested);
  if (parsed === null && requested !== undefined && requested.trim() !== '') warnProfileOnce(requested);
  const name = parsed ?? DEFAULT_RESOURCE_PROFILE;
  const base = PROFILE_TABLE[name];

  const settings: ResourceProfileSettings = {
    ...base,
    name,
    governanceEnabled: resourceGovernanceEnabled(env),
  };

  settings.queryWorkersMax = readInt(
    env.CODEGRAPH_QUERY_POOL_SIZE,
    settings.queryWorkersMax,
    1,
    MAX_QUERY_WORKERS,
    true,
  );
  settings.queryWorkersMin = readInt(env.CODEGRAPH_QUERY_WORKERS_MIN, settings.queryWorkersMin, 1, MAX_QUERY_WORKERS);
  settings.queryWorkersInitial = readInt(
    env.CODEGRAPH_QUERY_WORKERS_INITIAL,
    settings.queryWorkersInitial,
    1,
    MAX_QUERY_WORKERS,
  );
  settings.queryIdleShrinkMs = readInt(env.CODEGRAPH_QUERY_IDLE_SHRINK_MS, settings.queryIdleShrinkMs, 1_000, 3_600_000, true);
  settings.resolveWorkersMax = readInt(env.CODEGRAPH_RESOLVE_WORKERS, settings.resolveWorkersMax, 2, MAX_QUERY_WORKERS);
  settings.lspPerProjectSoftMax = readInt(env.CODEGRAPH_LSP_PER_PROJECT_MAX, settings.lspPerProjectSoftMax, 1, 8);
  settings.lspGlobalMax = readInt(env.CODEGRAPH_LSP_GLOBAL_MAX, settings.lspGlobalMax, 1, 16);
  settings.lspIdleTimeoutMs = readInt(env.CODEGRAPH_LSP_IDLE_TIMEOUT_MS, settings.lspIdleTimeoutMs, 1_000, 3_600_000, true);

  // 最小/初始都必须落在 [1, max] 内，否则缩容或预热会与上限自相矛盾。
  const max = Math.max(1, settings.queryWorkersMax);
  settings.queryWorkersMin = Math.min(Math.max(1, settings.queryWorkersMin), max);
  settings.queryWorkersInitial = Math.min(Math.max(settings.queryWorkersInitial, 1), Math.max(max, 1));

  return settings;
}

/** 供启动日志与 status 使用的一行摘要。 */
export function describeResourceProfile(settings: ResourceProfileSettings): string {
  if (!settings.governanceEnabled) {
    return `profile=${settings.name} (resource governance disabled via CODEGRAPH_RESOURCE_GOVERNANCE)`;
  }
  const shrink = settings.queryIdleShrinkMs > 0
    ? `${Math.round(settings.queryIdleShrinkMs / 1000)}s->${settings.queryWorkersMin}`
    : 'off';
  return [
    `profile=${settings.name}`,
    `queryWorkers=${settings.queryWorkersInitial}..${settings.queryWorkersMax} (idle shrink ${shrink})`,
    `resolveWorkers<=${settings.resolveWorkersMax}`,
    `lsp=${settings.lspPerProjectSoftMax}/project, ${settings.lspGlobalMax}/global (idle exit ${Math.round(settings.lspIdleTimeoutMs / 1000)}s)`,
  ].join(', ');
}

/** 返回当前档位对指定索引任务的解析 worker 上限。 */
export function resolveIndexWorkerLimit(
  level: IndexTaskLevel = 'ordinary',
  settings: ResourceProfileSettings = resolveResourceProfile(),
): number {
  const configured = settings.indexWorkers[level] ?? settings.indexWorkers.ordinary;
  return Math.max(1, Math.min(configured, settings.resolveWorkersMax, MAX_QUERY_WORKERS));
}

/** 查询池的生效尺寸；`max = 0` 表示池被显式关闭。 */
export interface QueryPoolSizing {
  initial: number;
  min: number;
  max: number;
  idleShrinkMs: number;
  /** 尺寸来源，便于启动日志和 status 解释「为什么是这个数」。 */
  source: 'profile' | 'override' | 'legacy';
}

/**
 * 查询池尺寸。治理关闭时回退旧行为：`clamp(cores-1, 1, 16)`、不缩容。
 * 显式 `CODEGRAPH_QUERY_POOL_SIZE` 覆盖档位上限（0 = 关闭池）。
 */
export function resolveQueryPoolSizing(
  env: NodeJS.ProcessEnv = process.env,
  cpuCount: number = 1,
  settings: ResourceProfileSettings = resolveResourceProfile(env),
): QueryPoolSizing {
  const explicit = env.CODEGRAPH_QUERY_POOL_SIZE;
  const explicitValue = explicit !== undefined && explicit.trim() !== '' ? Number(explicit) : undefined;
  const hasExplicit = explicitValue !== undefined && Number.isFinite(explicitValue) && explicitValue >= 0;

  if (!settings.governanceEnabled) {
    const legacy = Math.max(1, Math.min(cpuCount - 1, MAX_QUERY_WORKERS));
    return { initial: Math.min(1, legacy), min: 1, max: legacy, idleShrinkMs: 0, source: 'legacy' };
  }

  const profileMax = Math.max(1, Math.min(settings.queryWorkersMax, Math.max(1, cpuCount - 1)));
  const max = hasExplicit
    ? Math.min(Math.floor(explicitValue as number), MAX_QUERY_WORKERS)
    : profileMax;
  if (max <= 0) return { initial: 0, min: 0, max: 0, idleShrinkMs: 0, source: 'override' };

  const min = Math.min(Math.max(1, settings.queryWorkersMin), max);
  const initial = Math.min(Math.max(settings.queryWorkersInitial, min), max);
  return {
    initial,
    min,
    max,
    idleShrinkMs: settings.queryIdleShrinkMs,
    source: hasExplicit ? 'override' : 'profile',
  };
}

/** 测试钩子：清空档位取值告警去重集合。 */
export function resetResourceProfileWarnings(): void {
  warnedProfileValues.clear();
}
