# 幂等与事务式结构化编辑

阶段五把 `codegraph_edit` 的 apply 从逐文件写入改为持久事务。公共入口仍是
`CodeGraph.editCode()`；CLI 和 MCP 不另算编辑计划，默认仍只返回预览。

## 契约

- 预览同时返回 `previewHash` 和稳定 `operationId`。apply 应回传两者；断线、超时或代理重启后继续使用同一个 `operationId`。
- `previewHash` 约束计划内容，`operationId` 约束请求身份，两者用途不同。相同 operation ID 但请求内容不同会返回 `conflict`。
- 事务记录位于 `.codegraph/edit-transactions/<operationId>/manifest.json`。目标文件全部校验并暂存后才进入提交阶段。
- 暂存区与项目位于同一 `.codegraph` 文件系统。检测到跨卷目标时在提交前拒绝；符号链接目标也拒绝，避免替换链接本身或越过预期边界。
- 后续文件提交失败时，已提交文件按逆序从备份恢复。若恢复也失败，结果的
  `applied.fileStates[]` 给出确定状态、项目相对备份路径和人工恢复动作。
- `CodeGraph.open()` 会检测中断于暂存、部分提交或索引刷新阶段的事务。前两者回滚；完整提交保留源码结果并补做索引同步。
- 创建、移动、删除会通知已运行且声明对应能力的 LSP。服务器不支持文件事件时，CodeGraph 仍关闭旧文档，并在结果中说明降级。
- 删除或移动后的索引同步若遇到其他进程持有写锁，结果明确返回 `indexSynced:false` 并提示运行 `codegraph sync`，不会把未执行的同步误报为成功。

成功提交的 manifest 和结果记录会保留，用于幂等重放和审计；不再需要的 staged/backups 会在终态持久化后清理，只有 `recovery_required` 保留恢复材料。若需要在源码恢复到相同内容后再次执行同一请求，应提供一个新的自定义 `operationId`。

## 代码归属

| 责任 | 位置 |
| --- | --- |
| 请求、结果、operation ID 与逐文件恢复契约 | `src/edits/contract.ts` |
| 暂存、备份、提交、回滚、重放和启动恢复 | `src/edits/transaction.ts` |
| 统一编排、索引刷新与终态记录 | `src/edits/service.ts` |
| LSP 文档关闭和 workspace 文件事件 | `src/lsp/manager.ts` |
| MCP 参数与 AI 使用说明 | `src/mcp/edit-tool.ts`、`src/mcp/server-instructions.ts` |

## 验证范围

`__tests__/edit-transaction.test.ts` 覆盖幂等重放、请求冲突、暂存后中断、提交后中断、符号链接和跨卷预检；`edit-lsp-rename.test.ts` 覆盖第二文件失败回滚、移动失败和 CRLF；`lsp-manager.test.ts` 覆盖支持与不支持文件事件的通知行为。

权限/文件占用错误通过提交失败注入覆盖；索引写锁竞争覆盖结构性编辑已落盘但索引尚未刷新的结果契约。真实 Windows 文件占用、POSIX 权限和各平台文件系统差异由 `.github/workflows/hardening.yml` 的平台任务继续验证，不能用本机结果替代。

本地验证环境为 Windows、Node 24.16.0、npm 11.13.0：阶段五事务专项 7 项通过；包含编辑、LSP 和 MCP 契约的全量 `npm test` 通过（274 个文件、4664 项，21 个文件/234 项按环境跳过）；`npm run build`、`npm run test:perf` 和个人安装产物验证通过。
