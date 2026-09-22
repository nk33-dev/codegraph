# 阶段一：资源档位与自动回收

本页对应[开发计划](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)阶段一「基线、资源档位和自动回收」的契约与实现记录。目的不是给普通用户加开关，而是让后续功能的 CPU、内存、磁盘和耗电增长**可测、可限制、可回退**。

## 档位表

显式配置 `CODEGRAPH_RESOURCE_PROFILE=battery|balanced|performance`（默认 `balanced`），不使用不可靠的跨平台电池检测。

索引任务另分为 `ordinary`（普通正文保存）、`interface`（接口/导出/路由结构变化）和 `global`（项目配置变化）。普通任务默认只启用一个解析 worker，接口任务和全局任务才按档位逐级放宽；不会检测充电状态或默认满载。

| 项目 | battery | balanced | performance |
| --- | ---: | ---: | ---: |
| 查询 worker 初始值 | 1 | 1 | 2 |
| 查询 worker 最大值 | 2 | 4 | 8 |
| 查询 worker 空闲缩容 | 45 秒缩到 1 | 120 秒缩到 1 | 300 秒缩到 2 |
| 全量解析 worker 最大值 | 2 | 5 | 8 |
| 每项目 LSP 软目标 | 1 | 2 | 3 |
| 全局 LSP 上限 | 2 | 3 | 6 |
| LSP 空闲退出 | 90 秒 | 300 秒 | 600 秒 |
| 每项目会话缓存预算 | 64MB | 128MB | 256MB |
| 深度双索引 | 仅显式请求 | 按需临时创建 | 可预热 |

`battery` 的「只保留一个 LSP」是软目标：一个语言服务器服务同一语言家族的全部文件、窗口和子 Agent；不关闭有活跃请求的服务器；TypeScript/Python 这类短时交替的语言可以临时保留两个，避免反复冷启动更耗电；超出全局上限时按最久未使用且无活跃请求的顺序退出；Graph 始终可用，不会为了精度偏好强制启动 LSP。

## 环境变量

精细环境变量继续有效，并且**覆盖**档位默认值：

| 变量 | 作用 |
| --- | --- |
| `CODEGRAPH_RESOURCE_PROFILE` | 选择档位（非法值告警一次并回退 `balanced`） |
| `CODEGRAPH_RESOURCE_GOVERNANCE` | `0`/`false`/`off` 关闭全部治理，回退治理前行为 |
| `CODEGRAPH_QUERY_POOL_SIZE` | 查询 worker 上限（`0` 关闭查询池），仍受硬上限 16 约束 |
| `CODEGRAPH_QUERY_WORKERS_INITIAL` | 预热 worker 数 |
| `CODEGRAPH_QUERY_WORKERS_MIN` | 缩容保留数 |
| `CODEGRAPH_QUERY_IDLE_SHRINK_MS` | 空闲缩容时间（`0` 关闭缩容） |
| `CODEGRAPH_RESOLVE_WORKERS` | 全量解析 worker 数（显式值完全覆盖档位） |
| `CODEGRAPH_LSP_PER_PROJECT_MAX` | 每项目 LSP 软上限 |
| `CODEGRAPH_LSP_GLOBAL_MAX` | 跨 daemon 全局 LSP 上限 |
| `CODEGRAPH_LSP_IDLE_TIMEOUT_MS` | LSP 空闲退出（`0` 从不退出） |
| `CODEGRAPH_LSP_GLOBAL_LEASE` | `0` 关闭跨 daemon 租约（保留每项目软上限） |
| `CODEGRAPH_LSP_LEASE_DIR` | 租约目录覆盖（测试与多用户环境） |

优先级：**显式环境变量 > `.codegraph/lsp.json` 里的同名字段 > 档位默认值**。注意这继承自既有的 `loadLspConfig`（先读文件、再套环境变量覆盖），因此 `CODEGRAPH_LSP_IDLE_TIMEOUT_MS` 会覆盖 `lsp.json` 的 `idleTimeoutMs`，而不是相反；本轮只把第三档「档位默认值」接上，没有翻转既有优先级。

关闭开关的边界：显式把空闲退出设为 `0`（`CODEGRAPH_LSP_IDLE_TIMEOUT_MS=0` 或 `lsp.json` 的 `idleTimeoutMs: 0`）表示「语言服务器常驻不退」，此时全局预算的自动协作回收也不会启动（手动调用仍然可用）——这是显式配置优先于自动回收的取舍。

## 查询池的空闲缩容

`src/mcp/query-pool.ts` 从「只扩容不缩容」改为有界扩缩：

- 构造时按档位预热 `initial` 个 worker（`performance` 为 2，其余为 1），并发突发时最多扩到档位上限（仍受硬上限 16 与 `cores-1` 收紧），队列清空后经过空闲窗口缩回 `min`；
- 只回收 **idle** worker：在途调用不在 idle 集合里，所以「缩容不关闭活跃 worker」由数据结构保证；有排队任务时不缩容；
- 缩容定时器 `unref()`，不拖住 daemon 退出；daemon 销毁时清理；
- `CODEGRAPH_RESOURCE_GOVERNANCE=0` 时回到旧的 `clamp(cores-1,1,16)` 且不缩容。

## LSP 每项目软上限与跨 daemon 全局 lease

- 软上限：启动新语言家族前，若本项目的 live 服务器已达档位软目标，先按最久未使用关闭一个**空闲**家族；没有可关闭的空闲服务器时不阻塞查询（允许临时超出，只记一条日志）。
- 全局预算：`~/.codegraph/lsp-leases/`（可用 `CODEGRAPH_LSP_LEASE_DIR` 覆盖）按 `(项目, 语言家族)` 写一条带 `pid`、`startedAt`、`updatedAt`、`activeQueries` 的租约。存活判定同时要求 **pid 存活** 和 **心跳未过期**（默认 60 秒），OS 复用 pid 不会让僵尸租约永久占用预算；读取时顺带清理死记录。
- 协作式回收：每个 daemon 的 30 秒巡检发现全局租约数超过 `lspGlobalMax` 时，只关闭**自己**最久未使用且无活跃请求的服务器，使总数回到预算内。不跨进程 kill 别人的语言服务器，也不引入常驻中央服务。
- 同一项目的多个客户端继续共享同一个 daemon，因此仍然只有一套 LSP。

## 指标与基线

`src/resource-metrics.ts` 在进程内记录：查询队列长度、live/idle worker、单次查询等待与执行耗时（保留窗口内 p50/p95）、节点 LRU 缓存命中、全量/增量索引耗时与文件数、LSP 启动耗时与按原因分类的退出次数。

- daemon 每 10 秒把快照原子写入 `<项目>/.codegraph/resource-metrics.json`，退出前再写一次；
- `codegraph index` / `codegraph sync` 完成后也写一次，所以没跑 daemon 时也能留下基线；
- `codegraph status`（文本与 `--json` 的 `resources` 字段）以及 MCP `codegraph_status` 展示生效档位与实际状态；**status 只读配置与快照，不启动 LSP、不启动 daemon**；
- CLI status 只有在 pid 存活、项目注册表或 `daemon.pid` 身份匹配且快照不超过 60 秒时才用现在时显示 daemon。退出或过期快照标成 `LAST DAEMON SNAPSHOT`；JSON 通过 `reportedState`（`live/exited/stale`）和 `reportedAgeMs` 区分；
- 分位数使用每个序列最多 256 个样本的环形缓冲，长时间运行不会无限占用内存。

## 代码归属

| 入口 | 职责 |
| --- | --- |
| `src/resource-profile.ts` | 档位表、环境变量覆盖与钳制、`describeResourceProfile`、查询池尺寸推导 |
| `src/resource-metrics.ts` | 计数器与分位数、快照结构、原子读写，以及快照 live/exited/stale 判定 |
| `src/mcp/query-pool.ts` | worker 扩缩容状态机与队列、缩容定时器 |
| `src/mcp/engine.ts` | 按档位创建查询池、启动日志、周期快照写入 |
| `src/lsp/lease-registry.ts` | 跨 daemon 租约注册表（pid + 心跳 + 过期清理） |
| `src/lsp/manager.ts` | 每项目软上限驱逐、全局预算协作回收、租约生命周期、LSP 指标 |
| `src/index.ts` | 全量/增量索引基线记录、`resourceStatus()`（不启动 LSP） |
| `src/bin/codegraph.ts` | `status` 的资源段、`index`/`sync` 的基线落盘 |
| `src/mcp/tools.ts` | MCP `codegraph_status` 的档位与查询池状态、内联路径的查询指标 |

## 验证

环境：Windows、Node 24.16.0、npm 11.13.0。完整日志保存在本机 `.codegraph/verification/`，不提交生成的日志与安装产物。

```text
npm run build
node node_modules/vitest/vitest.mjs run __tests__/resource-profile.test.ts __tests__/resource-metrics.test.ts \
  __tests__/query-pool.test.ts __tests__/query-pool-daemon.test.ts __tests__/resource-status.test.ts \
  __tests__/status-json.test.ts __tests__/lsp-lease-registry.test.ts __tests__/lsp-resource-budget.test.ts \
  __tests__/lsp-config.test.ts __tests__/lsp-manager.test.ts --project engine
npm run test:perf
npm test
```

### 数字（本轮实测）

| 项目 | 结果 |
| --- | --- |
| 单个 AI 串行查询时的查询 worker | 预热 1 个（`Profile: balanced`，`Query pool: 1..4`） |
| 8 个并发只读调用后的缩容 | 空闲窗口后 `liveWorkers=1`，8 个调用全部成功返回，缩容后再查一次仍成功（`__tests__/query-pool-daemon.test.ts`，真实 daemon + 真实 worker） |
| 缩容窗口的测试值 | 集成测试用 3 秒（档位默认 120 秒），档位语义不变 |
| 同一项目多客户端 | 仍只有一套 daemon/LSP（`cli-shared-service.test.ts` 的「language server starts only once」继续通过） |
| status 是否启动 LSP/daemon | 否：只做 `kill(pid, 0)` 与文件读取；无快照诚实降级，历史快照通过 `reportedState` 标明不是当前状态 |
| 串行性能门禁 | `npm run test:perf`：6 个文件、267 项通过，26.75 秒 |
| 并发全量测试 | `npm test`：266～267 个文件通过、0～2 个偶发失败（负载相关，单独运行均通过）；逐次结果见[开发验证记录](test-repairs.md) |
| 节点 LRU 命中路径的指标开销 | 微基准三次交替测量均值约 5%，两次测量为 0～3%（首次有 JIT 预热偏差） |

在临时项目（60 个 TS 文件、300 节点、480 边、DB 0.50MB）上实测的基线：

| 项目 | 结果 |
| --- | --- |
| 全量索引 | 1532ms / 60 文件（`codegraph init` 墙钟 4.3 秒，含 Node 启动与交互输出） |
| 增量同步 | 1161ms / 5 文件（墙钟 2.7 秒） |
| daemon 空闲 | RSS 123.6MB、11 线程 |
| 8 个并发 explore 之后 | 全部成功返回；RSS 105.6MB、8 线程（RSS 受 GC 影响，线程数下降对应 worker 回收） |

这些数字来自**本机、小项目**，用来验证「记录机制 + 量级」；换机器或换仓库需要重新记录，不能当成其他项目的预算。

### 重新建立的基线

- `__tests__/ui-server-api.test.ts` 里「本仓库自身索引上的 `/api/node` 热路径」预算从 100ms 改为 250ms：该断言的成本随本仓库索引规模变化（当前 892 文件、`LRUCache.get` 有 1035 条入边），串行实测 139～177ms；旧的 100ms 是入边约 500 条时定的。其余计时预算（合成 fixture 的 100ms、250ms、400ms、1000ms、2000ms）保持不变。
- `__tests__/sync-rebuild-convergence.test.ts` 最重的一条串行已 4.9 秒、贴着默认 5 秒超时，显式改为 30 秒：并发全量测试下它测的是机器负载而不是收敛性。
- `__tests__/mcp-daemon.test.ts` 的 #1553 用例改为等 pidfile 真的换成新 daemon 再断言：原来在「Listening on」日志与 pidfile 原子替换之间的窗口里读一次，负载高时读到旧 pid。
- 个人版全量索引/增量索引、LSP 启动与查询耗时的基线由 `codegraph status` 的 `Baselines`/`Daemon` 段和 `.codegraph/resource-metrics.json` 持续记录。

## 限制与尚未实现

- 每项目会话缓存的 **字节级** 预算已在阶段二接入 `ExploreSessionState`：按实际 JSON UTF-8 字节淘汰最旧调用明细，累计调用数与响应字节不会被重置；
- 深度双索引策略（`deepDualIndex`）只解析和展示，双索引本身属于阶段四；
- 自动电池检测故意不做：第一版只用显式档位，避免误限速；
- 全局租约是协作式的：极端情况下（最旧租约的持有者全部有活跃请求）预算会被临时突破，这是「活跃任务优先」的取舍，不是漏回收；
- manager 关闭时的兜底清理按 **PID + 项目根** 限定，不会删除同一 daemon 中其它项目仍存活的租约；
- 跨进程协调目前用「同一 pid、不同项目根的租约记录」模拟另一个 daemon 验证，没有起第二个真实 daemon 进程；30 秒心跳定时器本身由直接调用 `heartbeatLeases(now)` 覆盖，未在测试里等满 30 秒。
