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
| 本地入口、doctor、GitHub 安装和版本切换 | [个人使用与安装](personal-usage.md) |
| 资源档位、查询池自动缩容与 LSP 预算 | [资源档位与自动回收](resource-governance.md) |
| Steps、Windows 清理、WASM 测试运行与性能修复 | [开发验证记录](test-repairs.md) |

CLI/MCP 共用 `src/index.ts` 的公共接口；默认 MCP 工具为 `codegraph_explore` 和 `codegraph_edit`。可视化沿用上游功能，只有显式启动 `codegraph ui` / `web` 才运行 HTTP 服务。

## 验证与发布

本机构建与全量测试已通过；具体环境、结果和验证范围集中记录在[开发验证记录](test-repairs.md)。语言服务文档中的历史数字只对应当时的测试环境。资源档位的实测数字、重新建立的性能基线和保留的限制见[资源档位与自动回收](resource-governance.md)。

个人扩展通过 `personal` 分支维护；首个 GitHub prerelease 为 `v1.6.0-personal.1`，当前修订版为 `v1.6.0-personal.2`。向 npm registry 安装上游包不会获得个人改动；个人版按[安装说明](personal-usage.md)从 GitHub Release `.tgz` 或固定标签安装。

## 计划与维护

[AI 优先能力与资源治理](../plans/2026-09-16-ai-first-capabilities-and-resource-governance.md)共六个阶段，阶段一至阶段五已实现并完成本地验证；阶段六的提交链、自动化、产物验证和首个 GitHub prerelease 已纳入本轮交付。`v1.6.0-personal.2` 的三平台复跑仍有 macOS 路径/事务测试和 Linux/macOS LSP fixture 隔离失败，不能记为跨平台通过；修复先进入 `personal`，后续发布不再用本机全量通过替代三平台结论。真实仓库 Agent A/B 和能耗测量仍待完成。本机验证与外部验证状态见[生产硬化与发布准备](release-readiness.md)。历史上游数字不作为本轮结果。独立的 LSP implementations 查询不再是阶段二前置需求：现有 `codegraph_explore` 会从统一图契约自动展开实现者；更深的 LSP 专用实现查询仍可后续评估。Serena 仅供参考，本项目不在其仓库中开发。

- [分支、上游同步、迁移与个人发行](maintenance.md)
- [开发参考](../development.md)
- [检索质量](../retrieval.md)与[评估方法](../validation.md)

新增个人功能时同步维护对应契约、入口映射、验证结果和发布状态。
