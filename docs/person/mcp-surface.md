# MCP 表面与缓存稳定性

## 目标与取舍

默认 MCP 继续只暴露 `codegraph_explore` 和 `codegraph_edit`。本分支不拆分新工具，也不删除结构化查询、LSP、变更分析或事务编辑能力。优化重点是减少每个会话固定携带的说明和 schema，并让固定字节只由配置决定——既不随已索引项目规模变化，也不随索引新鲜度或时间变化，为宿主或模型供应商的前缀缓存创造条件。

缓存是否实际命中仍由宿主、模型和请求前缀策略决定。查询返回的源码和证据是动态内容，不能也不应为了缓存而省略。

## 实现（P0：固定表面与契约修正）

- 工具定义保持静态，不含 `fileCount`、调用预算或时间。`getTools()` 不再读取 `getStats()`，因此默认两工具表面既不调用规模接口，也不可能随索引变化。仓库规模建议仍只在具体 explore 结果中按需出现（P0 问题 1）。
- 初始化说明只保留工具选择、源码完整性边界、编辑安全和未索引项目处理；参数行为只写在 schema 里，响应只描述本次调用事实（P0 问题 2）。
- 结构化能力不靠新增默认工具暴露：`codegraph_explore.mode` 的枚举与描述逐一列出 `definitions`、`references`、`symbols`、`diagnostics`、`impact`、`tests`、`status`，初始化说明同步点名（P0 问题 3）。
- `maxFiles` 的 schema 不再声明 `default: 12`（与实际分档 4/5/8 矛盾），改为说明"未指定时按项目规模分档选择"，`getExploreOutputBudget()` 是唯一事实来源（P0 问题 4）。
- 显式 `CODEGRAPH_MCP_TOOLS` 严格按白名单返回。默认表面只有 explore + edit，两者本就在小仓库核心集里，所以旧的小仓库过滤对默认路径完全无效，唯一效果是删掉白名单显式启用的工具；该规模判断连同它的注释一起删除（P0 问题 5）。
  被删注释记录的是一份 n=2 审计：把工具总数砍到 5 个以下（3 工具、1 工具）都让成本回退，所以结论是"工具总数不能低于 5"。它讨论的是**总数**，而本轮的默认表面固定为 2 个工具、不按规模裁剪，两者不冲突；审计原文可从删除前的提交里找回，这里不再以注释形式复述已不存在的代码路径。
- 每个工具的 `inputSchema` 顶层不得出现 `anyOf`/`oneOf`/`allOf`：Anthropic API 会以 400 拒绝，Claude Code 随之丢弃该工具。`.11` 曾因 `codegraph_explore` 带顶层 `anyOf`，在 Claude Code 里只剩 `codegraph_edit`；条件性要求只写进参数描述并在运行时校验，`mcp-fixed-surface` 测试遍历全部工具和三种表面防止回归。
- 握手协议版本按 MCP 生命周期规范协商：客户端请求的版本在 `SUPPORTED_PROTOCOL_VERSIONS`（`2024-11-05` 至 `2025-11-25`）内就原样返回，否则回落到最新受支持版本。此前无论客户端请求什么都固定返回 `2024-11-05`，新客户端会按旧协议降级。服务端发送的注解、`_meta` 和纯文本结果都是旧协议之上的增量，所以各版本没有分支代码。
- 无默认项目时，schema 仍把 `projectPath` 标为必填；白名单仍按用户配置改变表面——这是用户配置，不要求跨配置保持一致。
- `codegraph_edit` 的写入契约（预览、`canApply`/`blockers`、`expectPreviewHash`/`operationId`、重命名只用语言服务器加已核实引用）只在初始化说明声明一次，工具描述回到"一句话定位 + 何时使用"。

## 固定表面测量

按当前工作区源码直接序列化测量，不换算或声称模型 token 数。下表把压缩前、P0+P2 合并态，与当前基线并列；「本分支」是那次压缩的成品快照，不是当前值：

| 固定表面 | 优化前 | 本分支 | 当前基线 | 变化（对优化前） |
| --- | ---: | ---: | ---: | ---: |
| MCP 初始化说明 | 11,386 | 2,214 | 2,214 | -80.6% |
| 默认 tools/list | 8,952 | 4,810 | 4,932 | -44.9% |
| 合计 | 20,338 | 7,024 | 7,146 | -64.9% |

「本分支」为最终合并态：P0 收敛工具 schema 与描述，P2 再从初始化说明删除一处重复的「不要重新读取」句子。字符数只描述固定表面，不换算或声称模型 token 数。

当前基线（2,214 / 4,932 / 7,146，2026-09-18 实测）比该快照多 122 个字符，来自 `codegraph_explore` 新增的 `includeTestSource` 选项（可选布尔，描述 101 字符）—— 这是固定表面第一次有意增长：测试摘要默认生效，参数只用于显式取回测试全文，因此写进 schema 让它对 agent 可发现，比藏在环境变量或初始化说明里便宜。

合并上游 v1.6.1 后的实测（2026-09-30）：初始化说明 2,488、默认 tools/list 4,662、合计 7,150。初始化说明的上限相应从 2,300 调到 2,500，因为上游带来两条必须常驻的读答事实——基于漂移索引的拒答（点名文件，以及 `changed on disk after the last index sync` 标记）和空结果给出词法匹配与候选名；两条都已压到最短，其余段落未改。tools/list 比上一基线更小（上游重排后 explore 3,206→2,898），所以合计上限当时维持 7,300 不变。完整性说明的文案随上游改为「是否真的逐字完整」两种措辞，个人版不再使用旧的「Shown source spans N files」句式。

补声明 explore 的显示过滤参数后的实测（2026-09-30）：初始化说明 2,488、默认 tools/list 5,304、合计 7,792，上限调整为 explore 3,610、toolsList 5,410、combined 7,950。这是固定表面第二次有意增长，理由与上一次同类——**参数原本不可达**：`handleExplore` 一直在读 `directory` / `languages` / `frameworks` / `symbolTypes` / `excludeTypes`，但工具 schema 从未声明它们，按 schema 校验的客户端发不出去，过滤功能在 MCP 上等于不存在。五个参数共 642 字符，描述已压到一句；单数别名（`language`、`symbolType`、`excludeType`、`framework`）刻意不声明，省下的正是它们的份额。

重排常驻说明后的实测（2026-09-30）：初始化说明 2,635、默认 tools/list 5,304、合计 7,939，上限调整为 instructions 2,700、combined 8,050。这次不是纯新增，是**把选择规则挪到截断打不到的位置**：真实客户端会截断过长的 MCP `instructions`（本轮在 Claude Code 里实测到 codegraph 说明的结尾被截掉，尾部整段 Boundaries 没送到模型），而「项目没有 `.codegraph/` 就别用 Codegraph」原本压在最后一段——被截掉就等于没写，已前移到 How to use。同时补上 LSP 的**选择**依据：原文只有「diagnostics 自动走 LSP」和「LSP 是语言正确性的权威」，没有任何一句告诉模型该主动索要 LSP，于是 `backend:"lsp"` 事实上不可发现。Boundaries 里压缩了一句冗余以抵消部分增量，净增 147 字符。

`codegraph_explore` 现有 25 个字段（`includeTestSource`，以及 `directory` / `languages` / `frameworks` / `symbolTypes` / `excludeTypes`），`codegraph_edit` 有 12 个字段（`verbosePreview` 只控制文本展示）。字符预算测试固定初始化说明、无根说明、默认 tools/list、合计，以及 explore/edit 单个工具定义的序列化上限；同一个量在不同用例里共用同一组常量，避免只撞破其中一个阈值；工具注解测试同时固定已索引项目的 explore 描述与静态定义一致。

## 验证

`__tests__/mcp-fixed-surface.test.ts`（13 项，确定性，不需要 A/B）：

- 149 / 499 / 500 / 4999 / 5000 文件数下默认 `tools/list` 字节与静态表面完全一致，且默认路径不触发 `getStats()`。
- 已索引项目（真实索引）的默认表面与无引擎静态代理表面字节一致。
- 小仓库里显式启用 `callers,node,search` 时三者原样出现；白名单结果与规模无关；默认表面在 500 阈值两侧一致。
- `maxFiles` 的 schema 不再有 `default`，描述说明按规模分档；运行时默认值为 4/5/8。
- `mode` 枚举与描述列出全部结构化模式，初始化说明同步点名且默认工具数仍为 2。
- explore 响应不再逐次重复通用教程（"Numbered lines are current source excerpts…"），本次调用的"逐字、当前"声明与完整性说明仍在。

`__tests__/server-instructions.test.ts` 固定初始化说明、无根说明、默认 `tools/list`、合计、单工具描述与单工具完整定义的字符上限，并用语义断言守住压缩时不能删掉的约束（缺口说明、`canApply`/`blockers`、未索引项目处理）。

未做：agent 级 A/B（测试影响、诊断、引用查询的 Read/Grep 次数对比）。本轮不改变默认检索范围或预算，因此 A/B 不作为固定表面契约修复的合并门槛；同时不据此声称模型 token、工具调用或检索质量收益。

## 遥测

匿名使用统计默认关闭。未显式开启时不记录、不创建遥测文件、不联网；安装器默认不勾选。`codegraph telemetry on` 保存开启选择，`CODEGRAPH_TELEMETRY=1` 仅临时开启当前环境并保存稳定机器 ID，不会把全局状态永久改为开启。

安装器或 CLI 保存的选择继续生效。旧版本自动生成的 `consent_source: "default-notice"` 与环境临时生成的 `env` 记录都不视为显式同意，移除环境变量或升级后回到默认关闭。

## 发布状态

以上改动纳入 `v1.6.0-personal.6`。已运行的 MCP 进程不会自动热更新，安装或切换版本后需要完整重启宿主进程。

时延、`alwaysLoad` 固定成本和 explore→Read 回退比例的测量与决策见 [MCP 时延、常驻加载与 Read 回退](mcp-latency-and-load.md)。
