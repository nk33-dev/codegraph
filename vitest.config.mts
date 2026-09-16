import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import * as os from 'node:os';
import * as path from 'node:path';
import { WASM_RUNTIME_FLAGS } from './src/extraction/wasm-runtime-flags';

/**
 * The SHARED base. `vitest.workspace.mts` extends it twice — once for the
 * engine's node-environment suites and once for the viewer package's jsdom
 * one — so the environment, the plugins and the module-resolution conditions
 * a browser test needs cannot leak into the other 200-odd suites.
 */
export default defineConfig({
  test: {
    // 集成测试还会启动解析池和 CLI 子进程，避免按全部逻辑核再次叠加并发。
    maxWorkers: Math.min(4, availableParallelism()),
    minWorkers: 1,
    // 与 CLI 使用相同的 WASM 编译参数，避免 Node 24 的 Turboshaft Zone OOM。
    pool: 'forks',
    poolOptions: { forks: { execArgv: [...WASM_RUNTIME_FLAGS] } },
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    /**
     * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
     * mcp-roots) spawn `dist/bin/codegraph.js serve --mcp` with `process.execPath`
     * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
     * the CLI's hard-block (src/bin/codegraph.ts) would otherwise exit the child
     * before it ever responds, so every spawn-based test times out — see #478.
     *
     * Setting the override here keeps the CLI's runtime guard intact for end
     * users (it's still enforced when `codegraph` is invoked directly) while
     * letting the test suite run on whatever Node the contributor happens to
     * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
     * there, so the variable is a no-op.
     */
    env: {
      CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
      /**
       * The suite spawns real CLI/MCP processes; without this they would write
       * telemetry state into the contributor's real ~/.codegraph and count test
       * tool calls as real usage. The telemetry unit tests are unaffected —
       * they inject their own `env` via the Telemetry constructor.
       */
      CODEGRAPH_TELEMETRY: '0',
      /**
       * LSP 跨 daemon 租约（阶段一资源治理）默认落在真实的 `~/.codegraph/lsp-leases`。
       * 套件里会真实启动语言服务器并写租约，若某次用例异常退出，带本进程 pid 的
       * 陈旧记录会在真实目录里留最多一个心跳窗口，影响开发机上真实 daemon 的全局
       * 预算统计。指到 tmpdir 下的固定测试目录即可隔离；租约注册表本身会清理
       * 死 pid / 过期心跳的记录，所以这个目录不会无限增长。
       */
      CODEGRAPH_LSP_LEASE_DIR: path.join(os.tmpdir(), 'codegraph-test-lsp-leases'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
