# 索引状态、局部刷新与生成版本

## 当前契约

- `CodeGraph.getIndexStatus()` 是 CLI、MCP 和 UI 共用的状态入口，包含生成版本、最后更新时间、落后文件数、阶段、任务等级和失败原因。
- `codegraph refresh <file>` 与 `CodeGraph.refresh()` 只刷新指定文件；普通正文变更保持 `file` 范围，接口、导出、路由等结构变更扩大到 `related`，项目配置变更使用 `project` 范围。
- 文件 watcher 继续使用尾沿防抖，把连续保存合并成一次同步。局部刷新不会绕过已有 writer lock 或引用解析流程。
- 每次成功取得写锁的索引任务生成一个 `index_generation` 版本。结构化响应的状态块以及 explore/node 的符号、源码和调用链都声明该版本；文件漂移时禁止按旧行号切当前源码，改为整文件或省略正文。

## 资源调度

`CODEGRAPH_RESOURCE_PROFILE` 只接受显式的 `battery`、`balanced`、`performance`。解析 worker 还按 `ordinary`、`interface`、`global` 任务等级限流。默认普通保存只启用一个解析 worker，不检测充电状态，也不默认把机器打满；现有 `CODEGRAPH_PARSE_WORKERS` 等显式覆盖仍然有效。

## 验证

类型检查使用 `npm run typecheck`。局部刷新和状态字段应通过 `CodeGraph.refresh()`、`codegraph status --json`、`codegraph_explore` 的 `mode: "status"` 共同核对，确保所有入口读取同一版本状态。
