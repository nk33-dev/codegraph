# 个人版功能与维护导航

本目录记录个人 fork 的功能契约、维护流程和开发验证。项目简介与日常命令见[项目首页](../../README.md)。

## 已实现

- 查询可信度：不完整索引显示原因和已知影响范围，提交对应状态单独报告；Vue/React 的 composable、路由别名、props 和 emits 关系及静态边界见[查询契约](query-output-indexing.md)和[索引状态](index-refresh-and-versioning.md)。验证见[开发记录](test-repairs.md)，发布状态见下方。

- [Explore 宽问句与能力判断](mcp-experience-review.md)：清单、比较、能力和存在性问句的首段摘要，以及索引证据与运行时支持的边界。
- [统一证据、置信度与实现者展开](flow-evidence.md)：`codegraph_explore` 的版本化证据、自然语言流程意图区分、关系来源分级与调用点位置、失败优先输出、接口/抽象方法运行时候选、跨轮证据去重与会话字节预算。
- [高价值动态分派补全](dynamic-dispatch.md)：接口/DI、事件与队列、RPC/handler、ORM/repository、状态管理和插件注册的共享桥接，以及不可证明运行时键的诚实 boundary。
- [AI 改动上下文与语义差异](change-context.md)：Git 改动符号、语义边差异、影响入口、关联测试，以及显式深度基准图的隔离与清理。
- [测试与前后端关联](api-correlation.md)：测试类型/证据区分、HTTP 方法路径参数匹配、init 配置和 Vue 推断关系。
- [幂等与事务式结构化编辑](edit-transactions.md)：稳定 operation ID、跨文件暂存/提交/回滚、启动恢复、逐文件恢复清单与 LSP 文件通知。
- [LSP 语义查询与安全自动修复](lsp-semantic-actions.md)：类型提示、位置补全、实现/类型定义、调用/类型层级、全项目诊断，以及补导入和整理导入等 Code Action、整文件格式化的预览与事务写入。
- [依赖边界与循环依赖检查](architecture-boundaries.md)：从已解析的文件依赖推导目录/模块级的禁止方向与模块环，附具体 `file:line` 证据，CLI 与 MCP 共用。
- [Rust 符号的构建上下文](rust-build-context.md)：`codegraph node` 附加 crate 归属、workspace 成员关系与该 crate 声明的 feature 和依赖；查询期现算，并明确声明它不表示条件编译。
- [风险热点报告与阈值门禁](risk-hotspots.md)：把分支复杂度、调用方数量、改动符号与关联测试合成一个排序，供 `codegraph hotspots --strict` 做 CI 门禁；复杂度读时现算，不落库。
- 端到端图基线：索引一份刻意包含反例的 fixture，整图与提交进仓库的 golden 比对，用于发现上游同步或解析器升级后**丢失**的关系；更新流程与行号敏感性见[开发参考](../development.md#end-to-end-graph-baseline)。
- [个人版生产硬化与发布准备](release-readiness.md)：三平台门禁、夜间真实依赖验证、个人安装产物和发布边界。

| 功能 | 文档 |
| --- | --- |
| Graph 定义、同名消歧、关系证据/动态覆盖、引用、调用方、文件符号、全文检索、行范围、文件级影响与启动入口 | [结构化查询](structured-queries.md) |
| C/C++、JS/TS、Java、Rust、Go、Python 的按需语言服务 | [LSP](lsp-mvp.md) |
| Graph/LSP 自动路由、结果合并、影响分析与多窗口共享 | [统一路由与影响分析](unified-routing.md) |
| 符号重命名、正文替换、前后插入、整文件格式化与默认预览 | [结构化编辑](structured-edits.md) |
| 本地入口、doctor、GitHub 安装、版本切换、daemon 版本切换与索引升级 | [个人使用与安装](personal-usage.md) |
| 资源档位、查询池自动缩容与 LSP 预算 | [资源档位与自动回收](resource-governance.md) |
| 索引状态、升级关系差异、内容标记、监听原因与局部刷新 | [索引状态、局部刷新与内容标记](index-refresh-and-versioning.md) |
| 同步幂等、中断恢复、索引增长与查询测量 | [索引可靠性审查](index-reliability.md) |
| 索引期读缓存的生命周期、失效点与框架语言过滤 | [索引读缓存](index-caching.md) |
| MCP 固定表面、缓存稳定性与字符开销边界 | [MCP 表面与缓存稳定性](mcp-surface.md) |
| Explore stale 输出、跨调用去重边界与点名文件的头部保留和续读脚注 | [Explore 响应稳定性](explore-response.md) |
| 查询输出折叠、过滤、新文件状态与失败分类 | [查询输出、过滤与索引状态](query-output-indexing.md) |
| 首调用 catch-up 时延、alwaysLoad 固定成本与 explore→Read 回退比例 | [MCP 时延、常驻加载与 Read 回退](mcp-latency-and-load.md) |
| Git 调用成本、测试选择与 Windows CI 分片 | [测试性能](test-performance.md) |
| 依赖方向规则、模块环与 `codegraph architecture` | [架构边界](architecture-boundaries.md) |
| Rust 符号的 crate 归属、feature 与依赖证据 | [Rust 构建上下文](rust-build-context.md) |
| 复杂度/扇入/改动/测试合成的热点排序与 `codegraph hotspots --strict` 门禁 | [风险热点](risk-hotspots.md) |
| Steps、Windows 清理、WASM 测试运行与性能修复 | [开发验证记录](test-repairs.md) |

CLI/MCP 共用 `src/index.ts` 的公共接口；默认 MCP 工具为 `codegraph_explore` 和 `codegraph_edit`，局部刷新通过 CLI `codegraph refresh <file>` 与公共 API 提供。可视化沿用上游功能；上游 v1.6.1 起 viewer 默认不随发布开放，`codegraph ui` / `web` 需要显式设置 `CODEGRAPH_UI=1` 才会启动，不设置就完全不运行 HTTP 服务。

上游 v1.6.1 同步带来的模块同样遵循单一入口：项目生命周期与 watcher 注册在 `src/mcp/project-lifecycle.ts`（`src/mcp/engine.ts` 只是委托），新鲜度测量在 `src/mcp/index-freshness.ts` 与 `answer-freshness.ts`，viewer 门禁在 `src/bin/viewer-gate.ts`。个人的 `src/sync/file-freshness.ts` 与 `refresh-plan.ts` 负责单文件与局部刷新的判断，和它们不是同一件事。

MCP 状态会同时报告索引 freshness 与当前服务构建身份；`tests` 结构化模式支持只传 `files`，并把文件名主题明确相关的测试排在同置信度候选之前。流程问句中的 `codegraph_*` 工具名只在能唯一映射到真实 handler 和 calls 边时提升为调度主路径。

Explore 的主链请求默认收敛到确认过的调用脊，结构化查询摘要、LSP 索引状态和稳定索引内容标记由同一查询契约返回；安装器写入的 Agent 指令块与 MCP 初始化说明保持同一套用法。这些改动已实现；本机验证范围见[开发验证记录](test-repairs.md)。

本轮 Claude Code 体验报告的逐项处理、性能回归与验证范围见[MCP 体验问题处理记录](mcp-experience-review.md)。

同名消歧、关系来源/动态覆盖与升级关系报告已实现，回归测试与当前验证范围见[开发验证记录](test-repairs.md)。发布状态见下方。

## 验证与发布

当前已发布版本为 [v1.6.0-personal.13](releases/v1.6.0-personal.13.md)（2026-10-01 的 GitHub prerelease），标签指向 `4477e92`。同提交三平台 CI `36870702413` 和 Personal Release `36874630766` 均成功；详细测试数字与资产校验只保留在发行说明。实时状态以[GitHub Releases](https://github.com/nk33-dev/codegraph/releases)为准。

待发布版本为 [v1.6.2-personal.1](releases/v1.6.2-personal.1.md)：上游 v1.6.2 同步之后的第一个个人版本，交付 LSP 工作区配置桥接与 pull/push 诊断合并、依赖边界与模块环检查、端到端图基线。功能提交、版本元数据与发行说明已推送到 `personal`，但**本轮不触发 `Personal Release`**——没有对应标签、资产与 GitHub prerelease，安装地址仍是 `.13`。要发布时在同一提交的三平台 CI 成功后手动触发工作流；此前记录的测试性能改动（减少测试中的 Git 调用、Windows CI 三台 runner 分片）一并进入本版，实测见[测试性能](test-performance.md)。

个人版从 [GitHub Release 安装](personal-usage.md)，不通过上游 npm 包获得个人改动。`personal` 分支的同一提交通过三平台 CI 后，才由 `Personal Release` 在 GitHub runner 构建、隔离验证、打包并创建 prerelease；本机不承担发布构建和上传。

### 上游同步状态

上游 **v1.6.2**（`6560052a`）已在合并提交 `41f23de3` 合入 `personal`，个人基线为 `cc52233`。本次同步保留个人查询、LSP、编辑、资源治理和遥测契约，并接入官方 v1.6.2 的解析、框架路由、Windows、daemon、索引可靠性和测试覆盖。同步提交尚未发布，发布状态仍以 GitHub CI 和 Release 为准。

## 计划与维护

[AI 优先能力与资源治理](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)共六个阶段。复核结论是：阶段一至阶段五的主体能力已经落地；阶段六完成了提交链、自动化、产物验证、三平台 CI 和 GitHub prerelease，但正式效果证明仍未完成，因此不能把“六阶段全部开发完成”表述为完整闭环。`v1.6.0-personal.2` 暴露的跨平台问题已修复，行为基线 `f0fc59b` 的 Windows、Ubuntu 和 macOS CI 全部通过；`v1.6.0-personal.3` 基于该结果重新交付安装包。真实仓库 Agent A/B、工具调用/token 节省、能耗和长时间多窗口资源验证仍待完成。本机验证与外部验证状态见[生产硬化与发布准备](release-readiness.md)。历史上游数字不作为本轮结果。独立的 LSP implementations 查询不再是阶段二前置需求：现有 `codegraph_explore` 会从统一图契约自动展开实现者；更深的 LSP 专用实现查询仍可后续评估。Serena 仅供参考，本项目不在其仓库中开发。

- [分支、上游同步、迁移与个人发行](maintenance.md)
- [开发参考](../development.md)
- [检索质量](../retrieval.md)与[评估方法](../validation.md)

新增个人功能时同步维护对应契约、入口映射、验证结果和发布状态。
