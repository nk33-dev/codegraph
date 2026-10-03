# LSP 语义查询与安全自动修复

状态：**2026-09-30 已实现并完成本地聚焦验证，尚未发布。**

## 目标

继续保持默认 MCP 只有 `codegraph_explore` 和 `codegraph_edit`，把常用 LSP 能力并入现有模式，不增加一批零散的 `lsp_*` 工具。实现按通用 LSP 协议完成，不针对 Java 写专用逻辑；Java、TypeScript、C/C++ 等语言能否返回结果，取决于各自语言服务器声明和实现的能力。

## 查询能力

`codegraph_explore` 新增或增强这些结构化模式：

| 模式 | 大白话说明 | 数据来源 |
| --- | --- | --- |
| `hover` | 看变量、函数或类型的说明、签名和类型信息 | LSP |
| `type-definition` | 找变量背后的类、接口或类型定义 | LSP |
| `implementations` | 找接口、抽象类或基类的具体实现/子类 | Graph、LSP 或两者 |
| `callers` / `callees` | 看谁调用它、它调用谁 | 原有 Graph，加 LSP 调用层级 |
| `type-hierarchy` | 看父类型和子类型，并标明方向 | Graph、LSP 或两者 |
| `diagnostics`（不传 `file`） | 请求语言服务器返回整个工作区的错误和警告 | LSP `workspace/diagnostic` |
| `code-actions` | 查看当前位置可用的补导入、整理导入、快速修复等建议 | LSP |
| `completion` | 在 `file` + `line` 位置取语言服务器的候选补全，按 `sortText`（缺失时用 label）排序并分页 | LSP |

`completion` 默认返回服务器声明的 `isIncomplete` 情况，并且在服务器支持 `completionItem/resolve` 时对前若干条补齐 `detail`/`documentation`；单条解析失败只标记该条，不把整次查询变成失败。

Graph 继续负责跨文件静态关系和可回退结果；LSP 负责需要编译器类型信息的答案。`implementations` 的 Graph 结果包含 `extends` 和 `implements` 两种后代关系，不把“继承抽象基类”漏掉。

## 安全写入

`codegraph_edit` 新增 `operation:"code-action"`。典型用法是先预览：

```json
{
  "operation": "code-action",
  "file": "src/example.ts",
  "line": 12,
  "column": 4
}
```

语言服务器收到当前位置范围内的诊断信息，所以“补缺少的 import”这类快速修复可以正常出现。预览通过后，沿用现有 `previewHash`、`operationId` 和事务写入流程执行。

`codegraph_edit` 还有 `operation:"format"`：请求语言服务器做整文件格式化，拿到的文本修改走同一套预览与事务写入，不新增写盘路径。`tabSize`（默认 2）和 `insertSpaces`（默认 true）控制缩进；服务器返回空修改时给出空计划并说明文件已符合格式，不写入相同内容。

安全边界：

- 只接受普通文本修改；创建、删除、重命名文件的 Action 会拒绝。
- 只允许修改项目根目录内的文件；越界修改会在写入前整体拒绝。
- 只有命令、没有文本修改的 Action 不执行，避免运行任意语言服务器命令。
- 默认只预览；`apply:true` 时仍会重新规划、核对文件内容并事务写入。

## 入口

- MCP：仍然只有 `codegraph_explore` 和 `codegraph_edit` 两个默认工具；用 `actionIndex` 选择返回的修复建议。
- CLI：`codegraph explore` 支持新增模式、范围和 Action 类型过滤；`codegraph edit --operation code-action` 还支持范围与类型过滤。
- 公共 API：继续走 `CodeGraph.queryCodeWithBackend()` 和 `CodeGraph.editCode()`，没有另建一套实现。

## 验证

已运行：

```sh
npm run typecheck
npm run test:focused -- __tests__/lsp-manager.test.ts __tests__/lsp-code-query.test.ts __tests__/edit-lsp-code-action.test.ts
```

覆盖协议能力解析、Hover、类型定义、实现、调用/类型层级、工作区诊断、诊断上下文传递、Code Action resolve、预览、事务应用、Action 类型过滤、命令型 Action 拒绝和项目外修改拒绝。完整构建、全量测试、三平台 CI 和真实语言服务器矩阵尚未运行，不把它们记为已通过。
