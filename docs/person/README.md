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
| MCP 固定表面、缓存稳定性与字符开销边界 | [MCP 表面与缓存稳定性](mcp-surface.md) |
| Explore stale 输出稳定性与跨调用去重边界 | [Explore 响应稳定性](explore-response.md) |
| 首调用 catch-up 时延、alwaysLoad 固定成本与 explore→Read 回退比例 | [MCP 时延、常驻加载与 Read 回退](mcp-latency-and-load.md) |
| Steps、Windows 清理、WASM 测试运行与性能修复 | [开发验证记录](test-repairs.md) |

CLI/MCP 共用 `src/index.ts` 的公共接口；默认 MCP 工具为 `codegraph_explore` 和 `codegraph_edit`。可视化沿用上游功能，只有显式启动 `codegraph ui` / `web` 才运行 HTTP 服务。

## 验证与发布

本轮发行版本为 [v1.6.0-personal.7](releases/v1.6.0-personal.7.md)，修复精确自然语言查询的直接调用方覆盖、旧索引重命名安全门和大型编辑预览的默认上下文开销。最终本地验证边界与远端发行门禁见发行说明。

personal.5 的 CI `35222050320` 暴露 Unix socket 测试目录创建顺序、macOS 重命名路径别名和 Windows 测试超时清理问题；后续补修与本地 31 项定向验证见[开发验证记录](test-repairs.md)。修复位于 personal 分支，不改写既有发行资产。

个人发布完全由 GitHub Actions 完成：`personal` 是 fork 的默认分支，三平台 CI 通过后触发 `Personal Release`，由 runner 构建、隔离验证、打包并创建 prerelease；开发机不承担发布构建或资产上传。

本机构建与全量测试已通过；具体环境、结果和验证范围集中记录在[开发验证记录](test-repairs.md)。语言服务文档中的历史数字只对应当时的测试环境。资源档位的实测数字、重新建立的性能基线和保留的限制见[资源档位与自动回收](resource-governance.md)。

2026-09-17 的复审与补修见[静态复核记录](release-readiness.md#本轮静态复核)，本批归入 [v1.6.0-personal.4](releases/v1.6.0-personal.4.md)。开发复审未运行测试或构建；发行阶段单独生成安装包，以上历史验证不覆盖本批差异。

发行后 CI `35213690657` 暴露 UI 版本同步、精确检索预算和升级提示契约问题；修复已完成 Windows 本地 4 文件、90 项定向回归，详见[开发验证记录](test-repairs.md)。这些后续修复尚未纳入 personal.4 已发布资产，不改写原标签。

随后三平台 CI `35214833215` 通过；进一步修复 Windows 索引超时后的连接泄漏、后台任务串扰和数据库线程提前返回，并恢复四并发。本机定向 10 文件、77 项通过；本批远端四并发结果待确认，详见[资源清理记录](test-repairs.md#2026-09-17windows-四并发与资源清理)。

个人扩展通过 `personal` 分支维护；首个 GitHub prerelease 为 `v1.6.0-personal.1`，当前发行版本为 `v1.6.0-personal.6`。向 npm registry 安装上游包不会获得个人改动；个人版按[安装说明](personal-usage.md)从 GitHub Release `.tgz` 或固定标签安装。

## personal.6 发行内容（2026-09-18）

以下用户报告问题纳入 `v1.6.0-personal.6`；实际发布状态以 GitHub Release 页面为准：

- 默认 MCP 固定表面从 `20,338` 个字符压缩到 `7,024`，并移除随项目规模变化的工具描述；默认表面、白名单、`maxFiles` 和结构化模式契约见 [MCP 表面与缓存稳定性](mcp-surface.md)。
- 首调用时延拆成「catch-up 等待」与「检索」两段分别记账（`CODEGRAPH_MCP_TIMINGS=1` 可逐调用输出，`codegraph status` 显示 p95），并保留对账门与超时降级；alwaysLoad 固定成本与 explore→Read 回退比例的测量口径和决策见 [MCP 时延、常驻加载与 Read 回退](mcp-latency-and-load.md)。
- stale 文本改为稳定状态并按路径排序，结构化 status 保持原字段兼容；未加入未经模型级 A/B 验证的预算实验逻辑，见 [Explore 响应稳定性](explore-response.md)。
- 匿名使用统计改为默认关闭；安装器默认不勾选，只有保存选择、`codegraph telemetry on` 或 `CODEGRAPH_TELEMETRY=1` 会开启。
- 编辑后索引刷新补齐 grammar 预加载与引用解析，新符号和调用边在 `indexSynced:true` 前均可查询；直接 `apply:true` 与可选预览绑定的说明已统一。
- `status` 区分 live/exited/stale daemon 快照；未知目标的意图词不再参与模糊检索；blast radius 分开统计 callers、importers 和 references。

- 跨文件重命名由“只报缺口”改为“LSP 优先、索引补全、补不了就拒绝”（AST 确认的位置才补编辑，结果标 `plannedBy`），契约见[结构化编辑](structured-edits.md#rename-completeness-guard)。
- 唯一精确符号查询的意图词（定义/所有/调用方/相关测试）不再参与模糊匹配，契约见[结构化查询](structured-queries.md#意图词收束explore)。
- 后续体验补修：动态 namespace import 成为可解析引用，调用/构造边记录准确标识符列；自然语言关系词改为结构化意图并复用统一入边推导，大型精确类查询保留自身定义；旧索引阻止依赖 Graph 覆盖的 rename，编辑预览增加 `canApply/blockers` 并默认输出紧凑摘要；MCP 常驻说明去重压缩。以上仍未提交、未发布，验证边界见[开发验证记录](test-repairs.md#2026-09-17mcp-体验复审与补修)。
- 升级后旧 daemon 自动切换，并新增 `codegraph daemon --restart`；索引升级新增 `codegraph sync --upgrade-index`（先给估算再确认，范围有登记时才增量迁移），用法与边界见[个人使用与安装](personal-usage.md#升级后的-daemon-版本切换)。
- 实现范围、验证结果与未验证边界见[开发验证记录](test-repairs.md#2026-09-17跨文件重命名补全意图词收束daemon-版本切换与索引升级)。

## 计划与维护

[AI 优先能力与资源治理](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)共六个阶段。复核结论是：阶段一至阶段五的主体能力已经落地；阶段六完成了提交链、自动化、产物验证、三平台 CI 和 GitHub prerelease，但正式效果证明仍未完成，因此不能把“六阶段全部开发完成”表述为完整闭环。`v1.6.0-personal.2` 暴露的跨平台问题已修复，行为基线 `f0fc59b` 的 Windows、Ubuntu 和 macOS CI 全部通过；`v1.6.0-personal.3` 基于该结果重新交付安装包。真实仓库 Agent A/B、工具调用/token 节省、能耗和长时间多窗口资源验证仍待完成。本机验证与外部验证状态见[生产硬化与发布准备](release-readiness.md)。历史上游数字不作为本轮结果。独立的 LSP implementations 查询不再是阶段二前置需求：现有 `codegraph_explore` 会从统一图契约自动展开实现者；更深的 LSP 专用实现查询仍可后续评估。Serena 仅供参考，本项目不在其仓库中开发。

- [分支、上游同步、迁移与个人发行](maintenance.md)
- [开发参考](../development.md)
- [检索质量](../retrieval.md)与[评估方法](../validation.md)

新增个人功能时同步维护对应契约、入口映射、验证结果和发布状态。
