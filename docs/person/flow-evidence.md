# 阶段二：统一证据、置信度与实现者展开

本页对应[开发计划](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)阶段二。目标是让 `codegraph_explore` 说明路径为何成立、哪里断开，以及接口调用可能落到哪些实现，同时不新增 MCP 工具。

## 契约

共享推导位于 `src/graph/flow-evidence.ts`，`schemaVersion` 当前为 `1`。证据分为：

| `kind` | 含义 |
| --- | --- |
| `static` | 语法或既有图关系确认 |
| `lsp` | SCIP/LSP 关系确认 |
| `corroborated` | 静态图与 LSP 对同一关系相互印证 |
| `heuristic` | synthesizer 推导，保留 `synthesizedBy` 与注册位置 |
| `boundary` | 静态路径在运行时分派点终止 |

每条证据包含稳定 ID、置信度、来源、定义位置、调用位置、注册位置与说明。断链原因统一为 `unindexed`、`no_syntax_edge`、`dynamic_key`、`ambiguous_candidates`、`language_boundary`、`lsp_unavailable`。运行时候选始终标为候选，不表述为已确认调用。

## 实现者展开与预算

- 精确查询 interface、trait、protocol、抽象类或其抽象方法时，自动沿现有 `extends`/`implements` 图展开实现者；方法查询返回具体实现方法，而不只返回容器类型。
- 实现者总数复用 `countImplementers`，动态断点复用 `findDynamicBoundaries`，边来源复用现有 provenance，不另做全图扫描。
- 默认预算为 16 条证据、6 个断点、每个展开 6 个候选、2400 字符与 25ms。超预算时先裁剪解释和候选，不裁剪源码主干。
- `codegraph_explore` 文本只显示紧凑摘要；完整稳定字段放在 `structuredContent.evidence`。工具名和输入保持兼容。

## 跨轮状态

`ExploreSessionState` 同时记录源码范围和证据 ID。仅当 `CODEGRAPH_EXPLORE_DEDUP=1` 时，后续调用省略已返回的证据文本，并继续补充新证据和缺失源码。不同 MCP 会话互不共享历史。

会话缓存现在执行资源档位的 `sessionCacheMb` 字节预算：按实际序列化后的 UTF-8 字节淘汰最旧调用明细，但保留累计调用数和响应字节。

## 代码归属

| 入口 | 职责 |
| --- | --- |
| `src/graph/flow-evidence.ts` | 证据分类、断链归一、实现者展开、数量/字符/时间预算 |
| `src/graph/named-symbol-flow.ts` | 单符号类型解析、命名方法与类型种子 |
| `src/mcp/tools.ts` | 文本渲染与 `structuredContent` 适配 |
| `src/mcp/explore-session-state.ts` | 证据跨轮去重与会话字节预算 |

## 验证

阶段专项测试覆盖五类证据、六类断链、接口与抽象方法展开、候选裁剪、跨轮去重、字节预算和 MCP structured content。`npm run build`、103 项专项测试、279 项严格性能测试与 4641 项全量测试均通过；完整数字记录在开发计划的阶段二实施记录中。
