# MCP 时延、常驻加载与 Read 回退（P2）

本页是「MCP 上下文与检索效率优化方案」P2 阶段（问题 10–12）的实施与测量记录：**先测量再设计**，所以这里区分三件事——已经落地的测量能力、已经做出的决策、以及还缺外部条件的待补数据。固定表面的压缩与契约修正属于 P0，见 [MCP 表面与缓存稳定性](mcp-surface.md)。

指标口径沿用主方案：固定表面序列化字符数、模型实际 input/output/cache token、总工具调用数、Read/Grep 次数、任务成功率与回答完整性、首次调用与总体 p50/p95 耗时。`字符数 ÷ 4` 只作粗估，不作为收益结论。

## 问题 10：首次调用 catch-up 时延

### 现状与保留的行为

MCP 引擎打开项目后在后台跑一次 catch-up 对账（`MCPEngine.catchUpSync()`），并把该 promise 交给 `ToolHandler.setCatchUpGate()`；首个工具调用会等它，最长 `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS`（默认 3000ms），超时就先返回结果、对账在后台继续（#905）。这条正确性门必须保留：停机期间被删除的文件只存在于磁盘差异里，`getPendingFiles()` 看不到它们，所以不做对账就没有任何东西能证明结果不陈旧。

### 本轮实现（测量，不改行为）

- `ResourceMetrics.catchUp`：门内等待单独计数、单独计量（`count/ready/timeout/failed/wait`），与 `query.run`（检索耗时）各自的序列互不污染；写入 `.codegraph/resource-metrics.json`，`codegraph status` 在有待接调用时多打一行 `Catch-up:`。
- `CODEGRAPH_MCP_TIMINGS=1`：每次工具调用向 stderr 追加一行，把一次调用拆开——`tool=<name> catchUp=<ms>(<ready|timeout|failed|none>) retrieval=<ms> total=<ms> chars=<n>`。默认关闭，关闭时不产生任何输出。`catchUp=none` 表示这次调用没有门（非首个调用）。
- 等待时长只算门内时间；`retrieval` 是本次调用的其余耗时（校验 + 检索 + 渲染），`chars` 是最终返回给模型的文本长度。

### 怎么测

1. 冷启动场景：`codegraph init`（或已有索引的仓库）后启动 MCP 宿主，让首个查询落在对账期间。
2. 逐调用：给宿主进程设 `CODEGRAPH_MCP_TIMINGS=1`，从 stderr 收集 `[CodeGraph MCP timing]` 行，按 `catchUp` 与 `retrieval` 分别算 p50/p95。
3. 跨会话：读 `.codegraph/resource-metrics.json` 的 `catchUp.wait`（`count/totalMs/lastMs/maxMs/p50Ms/p95Ms`）与 `query.run`，或直接看 `codegraph status` 的 `Catch-up:` 行。
4. 对照臂：`CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0`（无界等待）与默认 3000ms 各跑一遍，就能看出超时降级省下多少首调用时延、代价是哪些调用拿到了可能陈旧的数据。

### 决策：暂不实现窄查询快路径

精确单符号查询看起来可以跳过对账直接返回旧索引结果，但本方案的判据是「只有在能对查询结果完成**等价的新鲜度检查**时」才可以，而当前没有这样一条检查：停机期间删除的文件不会出现在 watcher 的 pending 列表里，所以「没有 pending」不等于「索引新鲜」。要开这条快路径，前置条件是先有一个覆盖「停机期间被删除的文件」的等价新鲜度来源；在那之前保留 gate 与超时降级。

若后续要做，通过标准与主方案一致：回答正确性不下降、Read/Grep 不增加、首调用 p95 下降，且必须带一个「停机期间删除文件」的用例作为正确性 gate；不能只用「目标符号仍在输出中」判通过。

## 问题 11：`alwaysLoad` 的固定上下文成本

### 保留现状

server 级 `alwaysLoad`（安装器写入，Claude Code 用它免除 ToolSearch 步进）与 explore 工具的 `_meta['anthropic/alwaysLoad']` 都保留：前者保证启动时就绪，后者兼容旧安装和单工具常驻。两者都不是重复的说明注入，不构成「同一契约写三遍」的问题。

### 固定成本分解（当前构建产物直接序列化，不换算 token）

| 组成 | 字符数 | 什么时候进上下文 |
| --- | ---: | --- |
| MCP 初始化说明（`SERVER_INSTRUCTIONS`） | 2,214 | 总是 |
| 无默认项目变体（`SERVER_INSTRUCTIONS_NO_ROOT_INDEX`） | 468 | 只在没有默认索引项目时替换上面那条 |
| 默认 tools/list（含注解、`_meta`、schema） | 4,932 | always-load 时总是；deferred 时按需载入 |
| 合计（always-load 默认表面） | 7,146 | — |

tools/list 的当前值比本页最初记录的 4,810 多 122 个字符，来自 `codegraph_explore` 的 `includeTestSource` 选项；拆分与理由见 [MCP 表面与缓存稳定性](mcp-surface.md#固定表面测量)。

由此得到分宿主的固定成本口径：

| 宿主 | 工具定义是否常驻 | 每会话固定表面 |
| --- | --- | ---: |
| Claude Code，server `alwaysLoad`（安装器默认） | 是 | 7,146 |
| Claude Code，deferred（无 alwaysLoad） | 否，ToolSearch 载入后才进上下文 | 2,214 |
| Copilot CLI（同一豁免机制） | 是 | 7,146 |
| 无该机制的宿主（Codex / Cursor / Gemini / OpenCode） | 是 | 7,146（部分宿主另有 AGENTS.md 段落，不计入此处） |

字符预算测试钉住了这些上限（初始化说明 2,300、默认 tools/list 5,050、合计 7,300，并限制单工具完整定义），所以任何一侧悄悄变胖都会失败。

### 本机实测的启动耗时（2026-09-17，Windows、Node 24.16.0）

用 `node scripts/measure-mcp-handshake.mjs` 对着本仓库与一个 1 文件临时项目各跑 2 次，读数是「子进程启动 → `initialize` / `tools/list` 应答」的毫秒数：

| 路径 | initialize | tools/list | 工具定义 |
| --- | ---: | ---: | --- |
| 默认路径（已有共享 daemon，走代理） | 392–409ms | 与 initialize 同毫秒应答 | 测量时构建：2 个工具，4,977 字符 / 4,983 字节 |
| `CODEGRAPH_NO_DAEMON=1`（in-process 冷启动） | 535–546ms | 955–1,017ms（initialize 之后约 0.42–0.47s） | 同上 |

两点结论：

- `tools/list` 与「有没有打开项目、项目多大」无关：两条路径返回的都是同一份静态表面。上表测量时是 4,977 字符，P0 合并态缩为 4,810，当前基线 4,932（见上）；所以 always-load 与 deferred 的差别不在「工具列表要等多久」，而在这份定义是否从首轮就在上下文里。
- 代理路径上 `tools/list` 紧跟着 `initialize` 应答（同毫秒），说明静态表面没有等 daemon 的工具列表；in-process 冷启动那约 0.45s 是打开项目/启动 watcher 的代价，不是枚举工具定义的代价。

### 待补测量（需要宿主，不在本机范围内）

- 首次采用率：always-loaded 与 deferred 各跑一遍同一批任务，统计首个工具调用前是否有 ToolSearch 步进、首个 explore 何时发生；冷启动里 `init` 报 `connected` 且 tools > 0 的次数也算（不要用单次 `pending` 快照下结论）。现有 harness 参考 `scripts/agent-eval/ab-new-vs-baseline.sh`、`run-all.sh` 与 `parse-run.mjs` 的 `codegraph tools exposed` 行，procedure 见[采用问题文档的验证章节](../design/agent-codegraph-adoption.md#how-to-validate-anything-here)（该文的 P2 指「启动时服务器还没连上」，与本方案的 P2 编号无关）。
- 固定上下文的实际影响：deferred 宿主的 ToolSearch 是否真的抵消了 4,932 字符的节省。
- 真实冷启动（没有 daemon 时走默认路径，需要现拉起共享 daemon）的启动耗时。

变更判据：只有当分宿主数据显示 deferred 的首次采用率与首调用时延都不劣于 always-load，才会考虑去掉 server 级 `alwaysLoad`；在此之前保留。

## 问题 12：`explore` 命名与 Read 等价语义

### 不改名，只在固定表面声明一次

工具不重命名（避免破坏配置、权限和既有客户端）。「已展示源码视为已读取」这条契约现在只在初始化说明里声明一次；工具描述只做「一句话定位 + 何时使用」，响应尾注只讲本次调用事实（源码范围、截断、未展示文件）。`__tests__/server-instructions.test.ts` 断言模型可见固定表面里这条声明**恰好出现一次**，避免再次重复或两处措辞漂移。

### 回退比例怎么统计

MCP 服务端看不到宿主的 Read 调用，所以这个比例只能从会话 transcript 统计：`scripts/agent-eval/parse-run.mjs` 把每个被回答的 explore 调用按「智能体下一步做了什么」分桶，并在 sufficiency 块顶部给出回退比例：

```
Explore sufficiency — what the agent did NEXT (N answered calls):
  Fallback after explore: <r>/N re-read a returned file (<p>%), <m> read a file we never returned, <s> grep/glob
```

- `re-read a returned file`（`read_returned`）：explore 已经给出了该文件，智能体仍去读盘——就是「explore 返回文件后又被 Read」的比例，属分配问题（选对了文件、给错了字节）。
- `read a file we never returned`（`read_missed`）：文件从未被返回，属召回问题。
- `grep/glob`（`search`）：仍在找文件，较弱的召回信号。

用法：`node scripts/agent-eval/parse-run.mjs <run.jsonl>`（默认就打印 sufficiency 块，多臂比较用 `--brief`）。

判据：只有分桶比例显示 `read_returned` 明显偏高（说明是分配而非召回问题）时，才考虑加强提示；本轮不做，因为 A/B 数据（每臂至少两次，覆盖窄符号、跨文件流程、测试影响和大型函数四种场景）尚未采集。

## 配套修正

- `docs/retrieval.md` 的 explore 预算表此前仍写着上游的 28K/35K/38K，已按当前 `getExploreOutputBudget` 的 13K/18K/24K 档位更正，并把旧值标注为历史。
- 删除了仍声称 `getTools()` 会按仓库规模生成动态描述的过期注释（`getStaticTools()` 与已加载项目的表面现在一致，只有 `projectPath` 是否必填随状态变化）。
- 新增/修改的代码注释使用中文。

## 验证与未验证边界

已运行的定向测试与结果见[开发验证记录](test-repairs.md)。仍未验证的部分：真实仓库上的 agent A/B（首次采用率、工具调用/token、p50/p95、Read/Grep 是否增加）需要宿主与 API 额度，本批不执行，也不把它实现成生产预算开关；这里只交付观测能力与保守决策，不声称收益。
