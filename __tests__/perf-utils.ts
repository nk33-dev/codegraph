/**
 * 计时断言的预算工具。
 *
 * 背景：`npm test` 用 `pool: 'forks'`、4 路 worker 并发跑全部套件，而 100ms
 * 级别的计时断言在那种负载下由机器有多忙决定——同一段代码空闲时十几毫秒，
 * 4 个 worker 抢 CPU 时可能就超过 100ms。于是普通全量测试的红绿成了"当时机器
 * 负载"的函数，而不是代码有没有性能回归。
 *
 * 处理方式：普通运行把预算放宽 `PERF_RELAX_FACTOR` 倍，只保留数量级级别的回归
 * 保护（拦住"慢了一个数量级"的真回归）；严格预算只在串行性能门禁
 * （`npm run test:perf`，见 `vitest.workspace.mts` 的 `perf` 项目）里生效，那里
 * 单进程串行、没有别的套件抢 CPU，计时才有可比性。
 */

import { expect } from 'vitest';

/** 非严格模式下预算的放宽系数。 */
export const PERF_RELAX_FACTOR = 10;

/**
 * 是否启用严格计时预算。
 *
 * 只有串行性能门禁会设置 `CODEGRAPH_PERF_ASSERT=1`（`npm run test:perf`）；
 * 普通 `npm test` 下为 false，计时断言走放宽后的预算。
 */
export const PERF_STRICT: boolean = process.env.CODEGRAPH_PERF_ASSERT === '1';

/**
 * 返回本次运行实际生效的耗时预算（毫秒）。
 *
 * 严格模式返回调用方给的原始预算；非严格模式返回 `ms * PERF_RELAX_FACTOR`，
 * 这样并发全量测试不会因为机器负载抖动而误报，同时仍能抓住数量级级别的回归。
 */
export function perfBudget(ms: number): number {
  return PERF_STRICT ? ms : ms * PERF_RELAX_FACTOR;
}

/**
 * 断言 `elapsedMs` 落在 `budgetMs` 的预算内。
 *
 * 失败信息里带上 label、实际耗时、当前生效的预算，以及当前是不是严格模式，
 * 这样在普通运行里看到失败时能立刻判断是"真回归"还是"该跑 test:perf 复核"。
 */
export function expectWithinBudget(elapsedMs: number, budgetMs: number, label: string): void {
  const budget = perfBudget(budgetMs);
  const mode = PERF_STRICT
    ? '严格模式（CODEGRAPH_PERF_ASSERT=1，串行性能门禁）'
    : `非严格模式（并发全量测试，原始预算 ${budgetMs}ms 已按 ${PERF_RELAX_FACTOR} 倍放宽到 ${budget}ms）`;
  expect(
    elapsedMs,
    `${label}：实际耗时 ${elapsedMs.toFixed(1)}ms，当前预算 ${budget}ms —— ${mode}`,
  ).toBeLessThan(budget);
}
