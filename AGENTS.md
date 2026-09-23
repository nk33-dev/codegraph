# CodeGraph 项目指令

CodeGraph 是本地代码图、CLI 与 MCP 工具的个人 fork。只做用户要求的功能和上游兼容；Serena 仅作参考，未经要求不修改其仓库。

## 协作与分支

- 中文交流；代码标识符和新增、修改的代码注释使用英文。修改前读懂相关文件，技术不确定时查文档。
- 程序报错、日志、诊断、MCP/API 返回及面向 Agent、脚本的提示使用英文；直接面向真人操作的交互文案使用中文，例如 `codegraph init` 的提问、选项和操作引导。
- `main` 只快进同步 `upstream/main`；`personal` 维护个人功能并作为个人 fork 的 GitHub 默认分支，短期分支从它创建并合回。提交用 `type(scope): 中文说明`。
- GitHub 操作指定 `--repo nk33-dev/codegraph`。提交、推送、标签和发布按用户授权执行，不沿用上游维护者的远端、机器或发布配置。
- 修改功能时同步更新[个人文档](docs/person/README.md)，区分计划、实现、验证与发布。
- 代码、命令、版本或发布状态变化必须在同一提交更新其唯一权威文档；修订时合并重复内容、删除过时现状，只把历史结果留在发行说明或验证记录。版本发布前运行 `npm run version:sync` 与 `npm run check:release-metadata`，不要手工漏改版本镜像。

## 必守约束

- 已有 `.codegraph/` 时优先用 CodeGraph 查结构与调用链；索引不覆盖的内容再定向搜索，过期结果核对源码，不擅自建立新索引。
- 公共入口是 `src/index.ts`；多处使用的图推导放 `src/graph/`，避免 CLI/MCP/UI 各算一套。MCP 用法说明只维护 `src/mcp/server-instructions.ts`。
- 同步前读[维护流程](docs/person/maintenance.md)：按旧入口到现模块映射迁移行为，保持单一运行入口；Git 无冲突不能替代语义检查。大版本/重构在同步分支验证，保留合并历史，数据迁移先在副本验证恢复。
- 开发中先运行 `npm run check:quick`，它只做类型检查和受影响测试；也可用 `npm run test:focused -- <test files>` 明确指定。只有共享核心、构建/安装器、跨平台流程或用户明确要求时才在本地运行完整 `npm run build` 与 `npm test`，同一提交内容未变化时不重复跑全量。个人发布的完整构建、全量测试、隔离安装、打包、校验和与 Release 上传全部交给 GitHub CI / `Personal Release`，AI 不在本地执行 `npm run build`、`npm test`、`verify:personal-install`、`npm pack` 或 `gh release create/upload`，除非用户明确要求本地故障回退。安装器变更补契约测试及 CHANGELOG；纯文档检查差异和链接。核对实际产物与平台，未运行或失败的检查不得称为通过。
- 个人发布只从 `personal` 的干净提交触发 GitHub `Personal Release`，并等待同一提交的 CI 成功；不直接运行上游发布流程、不从本地上传资产、不向上游 npm 包名发布。版本和标签只在用户明确授权发布时修改。

## 按任务读取

| 任务 | 文档 |
| --- | --- |
| 构建、架构、数据库、安装器、平台测试 | [开发参考](docs/development.md)，读取相关章节 |
| 提取、解析、图查询、MCP 输出优化 | [检索质量](docs/retrieval.md) |
| 新语言/框架与检索效果评估 | [评估方法](docs/validation.md)；新增路由/WHEN 规则先读[框架覆盖](docs/design/framework-coverage.md) |
| 上游同步、数据迁移、个人发布 | [维护流程](docs/person/maintenance.md) |
| CHANGELOG 或发布工作流修改 | [上游发布参考](docs/upstream-release.md)，遵循个人发行目标 |

保持本文件简短；长案例、实现说明和操作步骤放普通文档，不用 `@import` 全量加载。
