# 个人版功能与维护导航

本目录记录个人 fork 的功能契约、维护流程和开发验证。项目简介与日常命令见[项目首页](../../README.md)。

## 已实现

- [统一证据、置信度与实现者展开](flow-evidence.md)：`codegraph_explore` 的版本化证据、自然语言流程意图区分、失败优先输出、接口/抽象方法运行时候选、跨轮证据去重与会话字节预算。
- [高价值动态分派补全](dynamic-dispatch.md)：接口/DI、事件与队列、RPC/handler、ORM/repository、状态管理和插件注册的共享桥接，以及不可证明运行时键的诚实 boundary。
- [AI 改动上下文与语义差异](change-context.md)：Git 改动符号、语义边差异、影响入口、关联测试，以及显式深度基准图的隔离与清理。
- [测试与前后端关联](api-correlation.md)：测试类型/证据区分、HTTP 方法路径参数匹配、init 配置和 Vue 推断关系。
- [幂等与事务式结构化编辑](edit-transactions.md)：稳定 operation ID、跨文件暂存/提交/回滚、启动恢复、逐文件恢复清单与 LSP 文件通知。
- [个人版生产硬化与发布准备](release-readiness.md)：三平台门禁、夜间真实依赖验证、个人安装产物和发布边界。

| 功能 | 文档 |
| --- | --- |
| Graph 定义、引用、调用方、文件符号、全文检索、行范围、文件级影响与启动入口 | [结构化查询](structured-queries.md) |
| C/C++、JS/TS、Java、Rust、Go、Python 的按需语言服务 | [LSP](lsp-mvp.md) |
| Graph/LSP 自动路由、结果合并、影响分析与多窗口共享 | [统一路由与影响分析](unified-routing.md) |
| 符号重命名、正文替换、前后插入与默认预览 | [结构化编辑](structured-edits.md) |
| 本地入口、doctor、GitHub 安装、版本切换、daemon 版本切换与索引升级 | [个人使用与安装](personal-usage.md) |
| 资源档位、查询池自动缩容与 LSP 预算 | [资源档位与自动回收](resource-governance.md) |
| 索引状态、生成版本与局部刷新 | [索引状态、局部刷新与生成版本](index-refresh-and-versioning.md) |
| MCP 固定表面、缓存稳定性与字符开销边界 | [MCP 表面与缓存稳定性](mcp-surface.md) |
| Explore stale 输出稳定性与跨调用去重边界 | [Explore 响应稳定性](explore-response.md) |
| 查询输出折叠、过滤、新文件状态与失败分类 | [查询输出、过滤与索引状态](query-output-indexing.md) |
| 首调用 catch-up 时延、alwaysLoad 固定成本与 explore→Read 回退比例 | [MCP 时延、常驻加载与 Read 回退](mcp-latency-and-load.md) |
| Steps、Windows 清理、WASM 测试运行与性能修复 | [开发验证记录](test-repairs.md) |

CLI/MCP 共用 `src/index.ts` 的公共接口；默认 MCP 工具为 `codegraph_explore` 和 `codegraph_edit`，局部刷新通过 CLI `codegraph refresh <file>` 与公共 API 提供。可视化沿用上游功能，只有显式启动 `codegraph ui` / `web` 才运行 HTTP 服务。

MCP 状态会同时报告索引 freshness 与当前服务构建身份；`tests` 结构化模式支持只传 `files`，并把文件名主题明确相关的测试排在同置信度候选之前。流程问句中的 `codegraph_*` 工具名只在能唯一映射到真实 handler 和 calls 边时提升为调度主路径。

本轮 Claude Code 体验报告的逐项处理、性能回归与验证范围见[MCP 体验问题处理记录](mcp-experience-review.md)。

## 验证与发布

当前已发布版本为 [v1.6.0-personal.10](releases/v1.6.0-personal.10.md)。版本内容与验证边界分别见发行说明和[开发验证记录](test-repairs.md)。

个人版从 [GitHub Release 安装](personal-usage.md)，不通过上游 npm 包获得个人改动。`personal` 分支的同一提交通过三平台 CI 后，才由 `Personal Release` 在 GitHub runner 构建、隔离验证、打包并创建 prerelease；本机不承担发布构建和上传。

## 计划与维护

[AI 优先能力与资源治理](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)共六个阶段。复核结论是：阶段一至阶段五的主体能力已经落地；阶段六完成了提交链、自动化、产物验证、三平台 CI 和 GitHub prerelease，但正式效果证明仍未完成，因此不能把“六阶段全部开发完成”表述为完整闭环。`v1.6.0-personal.2` 暴露的跨平台问题已修复，行为基线 `f0fc59b` 的 Windows、Ubuntu 和 macOS CI 全部通过；`v1.6.0-personal.3` 基于该结果重新交付安装包。真实仓库 Agent A/B、工具调用/token 节省、能耗和长时间多窗口资源验证仍待完成。本机验证与外部验证状态见[生产硬化与发布准备](release-readiness.md)。历史上游数字不作为本轮结果。独立的 LSP implementations 查询不再是阶段二前置需求：现有 `codegraph_explore` 会从统一图契约自动展开实现者；更深的 LSP 专用实现查询仍可后续评估。Serena 仅供参考，本项目不在其仓库中开发。

- [分支、上游同步、迁移与个人发行](maintenance.md)
- [开发参考](../development.md)
- [检索质量](../retrieval.md)与[评估方法](../validation.md)

新增个人功能时同步维护对应契约、入口映射、验证结果和发布状态。
