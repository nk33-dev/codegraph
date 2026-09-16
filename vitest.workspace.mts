import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineWorkspace } from 'vitest/config';
import baseConfig from './vitest.config.mts';

/**
 * 计时敏感套件清单：这些文件里的断言用 `expectWithinBudget`
 * （`__tests__/perf-utils.ts`）把实测耗时和毫秒预算比较。逐个列出，perf 项目才
 * 只跑这些、不跑别的。
 *
 * 它们都是 node 环境的 engine 套件：`ui-highlight`、`ui-server-api` 测的是
 * viewer 的**服务端**，不是组件，所以归 engine 而不是 jsdom 的 ui 项目（真正决定
 * 归属的是 engine 上的 exclude 规则）。`ui-filecode-model.test.ts` 故意不在列表里：
 * 它的 `toBeLessThan(150)` 量的是视口行数而不是耗时，放宽它会改变断言含义。
 */
const PERF_SUITES = [
  '__tests__/ui-server-api.test.ts',
  '__tests__/ui-highlight.test.ts',
  '__tests__/frameworks.test.ts',
  '__tests__/mcp-catchup-gate.test.ts',
  '__tests__/telemetry.test.ts',
  '__tests__/concurrent-locking.test.ts',
  '__tests__/flow-evidence.test.ts',
];

/** 共享 base 的 `test` 块：pool、execArgv、env、globals、environment。 */
const BASE_TEST = baseConfig.test ?? {};

/**
 * 三个项目、两条命令：`npm test` 跑 `engine` + `ui`，`npm run test:perf` 串行跑
 * 严格预算的 `perf`。
 *
 * perf 单独成项目的理由：4 路 worker 抢 CPU 时，100ms 预算量到的是机器有多忙，
 * 而不是代码有没有性能回归。普通全量测试因此让 `expectWithinBudget` 把预算放宽
 * 10 倍（只留数量级级别的保护），真实数字只在串行的性能门禁
 * （CODEGRAPH_PERF_ASSERT=1）里判定。
 *
 * The split exists because of exactly one suite. `ui-package.test.ts` mounts
 * `@colbymchenry/codegraph-ui`'s components against a mock adapter (task
 * CG-61), and to do that it needs three things the engine's suites must never
 * see:
 *
 *   - the **Svelte plugin**, to compile `.svelte` and `.svelte.ts` modules;
 *   - **jsdom**, because a component without a document is not a render;
 *   - `resolve.conditions: ['browser']`, so `svelte` resolves to its client
 *     build rather than its server one (`mount()` throws on the server).
 *
 * That last one is why this is a workspace rather than one config with a
 * couple of extra fields. `browser` is a package-resolution condition, not a
 * test setting: applied globally it would also hand the engine's suites the
 * browser builds of `web-tree-sitter` and friends, and the failures that
 * causes look nothing like their cause.
 *
 * The engine project `extends` the shared base, so the env vars and Node guard
 * in `vitest.config.mts` still apply to every engine test. The ui project does
 * not — see the note on it. The perf project does not either, for the reason
 * spelled out on it below.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.mts',
    test: {
      name: 'engine',
      include: ['__tests__/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '__tests__/ui-package.test.ts'],
    },
  },
  {
    // 这里不能写 `extends`（和下面 ui 项目同一个原因）：extend 的项目会**拼接**
    // 数组字段（Vite 的 mergeConfig 把 include 追加在一起），于是
    // `extends: './vitest.config.mts'` 会把 200 多个 engine 套件——含
    // `ui-package.test.ts`——悄悄拖进性能门禁。改为展开 base 的 test 块，再覆盖
    // 必须不同的字段：include，以及让它串行的那几个 worker/pool 设置。
    test: {
      ...BASE_TEST,
      name: 'perf',
      include: PERF_SUITES,
      exclude: ['**/node_modules/**', '**/dist/**'],
      // CODEGRAPH_PERF_ASSERT=1 是 100ms 预算和 1000ms 预算的唯一区别：它让
      // expectWithinBudget 用回真实数字。
      env: { ...BASE_TEST.env, CODEGRAPH_PERF_ASSERT: '1' },
      // 所有文件共用一个 fork 进程、一个接一个跑：只有没有别的套件抢 CPU 时，
      // 计时断言才有可比性。
      poolOptions: { ...BASE_TEST.poolOptions, forks: { ...BASE_TEST.poolOptions?.forks, singleFork: true } },
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
    },
  },
  {
    // Deliberately NOT `extends`: a workspace project CONCATENATES the base's
    // `include` with its own, so extending here would run all 200-odd engine
    // suites a second time inside jsdom (and two of them fail there, for
    // reasons that have nothing to do with anything). This project stands
    // alone, and it needs none of the base's spawn-related env anyway.
    plugins: [
      // The same preprocessor `ui/svelte.config.js` builds with, so the test
      // compiles what the package ships.
      svelte({ preprocess: vitePreprocess() }),
    ],
    resolve: { conditions: ['browser'] },
    test: {
      name: 'ui',
      globals: true,
      include: ['__tests__/ui-package.test.ts'],
      environment: 'jsdom',
      server: {
        deps: {
          // `@xyflow/svelte` ships uncompiled `.svelte` files, so it has to go
          // through the plugin above rather than be externalised to Node,
          // which has no idea what a `.svelte` file is.
          inline: [/@xyflow\/svelte/],
        },
      },
    },
  },
]);
