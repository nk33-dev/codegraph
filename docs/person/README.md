# 个人版功能与维护导航

本目录记录个人 fork 的功能契约、维护流程和开发验证。项目简介与日常命令见[项目首页](../../README.md)。

## 已实现

- [统一证据、置信度与实现者展开](flow-evidence.md)：`codegraph_explore` 的版本化证据、规范化断链、接口/抽象方法运行时候选、跨轮证据去重与会话字节预算。
- [高价值动态分派补全](dynamic-dispatch.md)：接口/DI、事件与队列、RPC/handler、ORM/repository、状态管理和插件注册的共享桥接，以及不可证明运行时键的诚实 boundary。
- [AI 改动上下文与语义差异](change-context.md)：Git 改动符号、语义边差异、影响入口、关联测试，以及显式深度基准图的隔离与清理。
- [幂等与事务式结构化编辑](edit-transactions.md)：稳定 operation ID、跨文件暂存/提交/回滚、启动恢复、逐文件恢复清单与 LSP 文件通知。
- [个人版生产硬化与发布准备](release-readiness.md)：三平台门禁、夜间真实依赖验证、个人安装产物和发布边界。

| 功能 | 文档 |
| --- | --- |
| Graph 定义、引用、文件符号与索引状态 | [结构化查询](structured-queries.md) |
| C/C++、JS/TS、Java、Rust、Go、Python 的按需语言服务 | [LSP](lsp-mvp.md) |
| Graph/LSP 自动路由、结果合并、影响分析与多窗口共享 | [统一路由与影响分析](unified-routing.md) |
| 符号重命名、正文替换、前后插入与默认预览 | [结构化编辑](structured-edits.md) |
| 本地入口、doctor、GitHub 安装、版本切换、daemon 版本切换与索引升级 | [个人使用与安装](personal-usage.md) |
| 资源档位、查询池自动缩容与 LSP 预算 | [资源档位与自动回收](resource-governance.md) |
| Steps、Windows 清理、WASM 测试运行与性能修复 | [开发验证记录](test-repairs.md) |

CLI/MCP 共用 `src/index.ts` 的公共接口；默认 MCP 工具为 `codegraph_explore` 和 `codegraph_edit`。可视化沿用上游功能，只有显式启动 `codegraph ui` / `web` 才运行 HTTP 服务。

## 验证与发布

本轮发行版本为 [v1.6.0-personal.5](releases/v1.6.0-personal.5.md)，汇总 personal.4 后续修复及新增升级功能。四并发基线 CI `35217505615` 已三平台通过；随后功能的本地验证仍有一项 daemon 接管偶发失败，具体边界见发行说明。

personal.5 的 CI `35222050320` 暴露 Unix socket 测试目录创建顺序、macOS 重命名路径别名和 Windows 测试超时清理问题；后续补修与本地 31 项定向验证见[开发验证记录](test-repairs.md)。修复位于 personal 分支，不改写既有发行资产。

本机构建与全量测试已通过；具体环境、结果和验证范围集中记录在[开发验证记录](test-repairs.md)。语言服务文档中的历史数字只对应当时的测试环境。资源档位的实测数字、重新建立的性能基线和保留的限制见[资源档位与自动回收](resource-governance.md)。

2026-09-17 的复审与补修见[静态复核记录](release-readiness.md#本轮静态复核)，本批归入 [v1.6.0-personal.4](releases/v1.6.0-personal.4.md)。开发复审未运行测试或构建；发行阶段单独生成安装包，以上历史验证不覆盖本批差异。

发行后 CI `35213690657` 暴露 UI 版本同步、精确检索预算和升级提示契约问题；修复已完成 Windows 本地 4 文件、90 项定向回归，详见[开发验证记录](test-repairs.md)。这些后续修复尚未纳入 personal.4 已发布资产，不改写原标签。

随后三平台 CI `35214833215` 通过；进一步修复 Windows 索引超时后的连接泄漏、后台任务串扰和数据库线程提前返回，并恢复四并发。本机定向 10 文件、77 项通过；本批远端四并发结果待确认，详见[资源清理记录](test-repairs.md#2026-09-17windows-四并发与资源清理)。

个人扩展通过 `personal` 分支维护；首个 GitHub prerelease 为 `v1.6.0-personal.1`，本批发行版本为 `v1.6.0-personal.4`。向 npm registry 安装上游包不会获得个人改动；个人版按[安装说明](personal-usage.md)从 GitHub Release `.tgz` 或固定标签安装。

## 本批未发布改动（2026-09-17）

四项用户报告问题的实现，**未提交、未发布，也不在 personal.4 安装包里**：

- 跨文件重命名由“只报缺口”改为“LSP 优先、索引补全、补不了就拒绝”（AST 确认的位置才补编辑，结果标 `plannedBy`），契约见[结构化编辑](structured-edits.md#rename-completeness-guard)。
- 唯一精确符号查询的意图词（定义/所有/调用方/相关测试）不再参与模糊匹配，契约见[结构化查询](structured-queries.md#意图词收束explore)。
- 升级后旧 daemon 自动切换，并新增 `codegraph daemon --restart`；索引升级新增 `codegraph sync --upgrade-index`（先给估算再确认，范围有登记时才增量迁移），用法与边界见[个人使用与安装](personal-usage.md#升级后的-daemon-版本切换)。
- 实现范围、验证结果与未验证边界见[开发验证记录](test-repairs.md#2026-09-17跨文件重命名补全意图词收束daemon-版本切换与索引升级)。

## 计划与维护

[AI 优先能力与资源治理](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)共六个阶段。复核结论是：阶段一至阶段五的主体能力已经落地；阶段六完成了提交链、自动化、产物验证、三平台 CI 和 GitHub prerelease，但正式效果证明仍未完成，因此不能把“六阶段全部开发完成”表述为完整闭环。`v1.6.0-personal.2` 暴露的跨平台问题已修复，行为基线 `f0fc59b` 的 Windows、Ubuntu 和 macOS CI 全部通过；`v1.6.0-personal.3` 基于该结果重新交付安装包。真实仓库 Agent A/B、工具调用/token 节省、能耗和长时间多窗口资源验证仍待完成。本机验证与外部验证状态见[生产硬化与发布准备](release-readiness.md)。历史上游数字不作为本轮结果。独立的 LSP implementations 查询不再是阶段二前置需求：现有 `codegraph_explore` 会从统一图契约自动展开实现者；更深的 LSP 专用实现查询仍可后续评估。Serena 仅供参考，本项目不在其仓库中开发。

- [分支、上游同步、迁移与个人发行](maintenance.md)
- [开发参考](../development.md)
- [检索质量](../retrieval.md)与[评估方法](../validation.md)

新增个人功能时同步维护对应契约、入口映射、验证结果和发布状态。
