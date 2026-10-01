# 索引状态、局部刷新与内容标记

## 当前契约

- `CodeGraph.getIndexStatus()` 是 CLI、MCP 和 UI 共用的状态入口，包含生成版本、最后更新时间、落后文件数、阶段、任务等级和失败原因。`indexedCommit` 是上次索引/同步时的 HEAD，`currentCommit` 在各查询模式都读取 HEAD，普通查询共用最长 1 秒的进程内缓存；显式状态查询和索引写入读取最新 HEAD。非 Git 项目的 HEAD 可以为 `null`，旧索引的 `indexedCommit` 可以为 `null`。两者不同时警告，但相同也不意味着工作区无改动。
- `checkFiles: true` 同时检查源图文件与文本索引中的配置、脚本和文档：`textChanges` 分别列出新增、修改、移除路径，`laggingFileCount` 去重汇总两者与待同步队列；未扫描时 `textChanges: null`。文件检查依据大小和修改时间，不是原子快照；`lastUpdatedAt` 是最近源文件索引时间，不是 Git 提交时间。
- 结构化查询的 `index` 带有 `freshness` 和 `freshnessReason`：`current` 表示没有已知漂移（未扫描文件时不保证磁盘一致），`syncing` 表示索引任务或待处理文件/引用未完成，`stale` 表示提交、工作区文件已漂移或索引任务未成功完成，`degraded` 表示 watcher 已停止。原始 `state` 即使为 `complete`，`laggingFileCount` 非零且无待处理队列也会标成 `stale`；这些字段只是风险摘要，按文件编辑仍以磁盘内容核验为准。
- `codegraph refresh <file>` 与 `CodeGraph.refresh()` 只刷新指定文件；普通正文变更保持 `file` 范围，接口、导出、路由等结构变更扩大到 `related`，项目配置变更使用 `project` 范围。
- 文件 watcher 继续使用尾沿防抖，把连续保存合并成一次同步。局部刷新不会绕过已有 writer lock 或引用解析流程。
- 每次成功取得写锁的索引任务有独立 task ID；对外结果使用由索引文件内容、节点/边计数和提取版本计算的稳定 content marker。无变更同步不会改变 marker，内容或提取结果改变才会改变它。结构化响应的状态块以及 explore/node 的符号、源码和调用链都声明该 marker；文件漂移时禁止按旧行号切当前源码，改为整文件或省略正文。
- `watching: false` 必须带上原因：`watchPolicy` 与 `watchPolicyReason` 只在未监听时出现，取值为 `disabled-env`（`CODEGRAPH_NO_WATCH=1`）、`disabled-wsl`（WSL2 `/mnt/`，判定见 `src/sync/watch-policy.ts`）、`start-failed`（watcher 起不来）、`disabled-lock`（别的 CodeGraph 进程持写锁）、`unwatched-projectPath`（只读、`--no-watch`，或一次性 CLI/库 handler）、`never-started`（尚未启动）。原因记录在同一 `CodeGraph` 实例上；环境判定由 `watchDisabledPolicy()` 单点给出，写锁判定由 `src/mcp/project-lifecycle.ts` 的 `activate()` 在握手前给出。
- 结构化 `warnings`、`codegraph_status` 的 `**Watch:**` 行和 explore 文本横幅共用 `watchInactiveWarning()` 一句文案。`disabled-lock` 不等于索引会变旧：持锁进程仍在同步，本会话在其退出后接管，因此这一条只说“本会话未监听、由对方维护”，不提示 `codegraph sync`——否则会引导 agent 去和持锁进程抢写；其余策略才明确要求手工同步。没有 project lifecycle 的一次性 handler 不在文本响应里重复这条（结构化状态块仍然报告）。
- explore/node 的文件漂移提示按是否真在监听改写结尾句（`staleRecoveryNote()`），不再无条件承诺改动“会在下次索引同步时自动被拾取”。

## 数据库与提取版本

- schema 版本由 `CURRENT_SCHEMA_VERSION` 单点声明，**v1.6.1 同步后为 13**。上游用 10 表示 synthesis、11 表示它的索引守卫；个人自己的 `file_text` 迁移让位到 13，12 是桥接迁移，只在 `synthesis_inputs` 缺失时重放上游 v10，所以对上游库和全新库都是 no-op。编号纪律见[维护流程](maintenance.md)的「迁移编号纪律」。
- 迁移在**打开索引库时**自动执行：任何命令（含 `codegraph sync`）打开旧库都会把它升到 13。个人库从记录 10 升上来会依次跑 11、12、13，补齐 `synthesis_inputs`、宽版 `idx_nodes_kind` 与合成回填；不需要删除索引重建，也不需要手工操作。
- 提取版本为 **28**。个人库此前记为 27，与上游同号但含义不同（上游 27 = 保留 method value 接收者），因此记 27 的个人库会被判定落后：`codegraph status` 给出 `reindexRecommended`，`codegraph sync --upgrade-index` 先打印范围、文件数、预计耗时与峰值磁盘再执行。这一步是重抽取，与上面的表结构补齐是两件事。
- 桥接迁移会置 `project_metadata.synthesis_pending = '1'`，下一次同步据此重建合成边并把它清回 0；迁移本身不重建，所以升级后要跑一次 `codegraph sync`（或 `--upgrade-index`）才算真正补齐。
- 旧构建读新库的推演：旧版看到的 `MAX(schema_versions)` 大于自己的 `CURRENT_SCHEMA_VERSION`，因此不迁移也能打开，且不认识新表新列。这是按代码推演的结论，**本轮未在旧产物上实测**；回滚仍以备份恢复为准，不是 `git checkout`。

## 资源调度

`CODEGRAPH_RESOURCE_PROFILE` 只接受显式的 `battery`、`balanced`、`performance`。解析 worker 还按 `ordinary`、`interface`、`global` 任务等级限流。默认普通保存只启用一个解析 worker，不检测充电状态，也不默认把机器打满；现有 `CODEGRAPH_PARSE_WORKERS` 等显式覆盖仍然有效。

## 验证

类型检查使用 `npm run typecheck`。局部刷新和状态字段应通过 `CodeGraph.refresh()`、`codegraph status --json`、`codegraph_explore` 的 `mode: "status"` 共同核对，确保所有入口读取同一版本状态。

监听原因的文案与分类由 `__tests__/watch-inactive-notice.test.ts` 固定（含“持锁时不出现 `codegraph sync`”这一条）；真实生命周期下的取值由 `__tests__/mcp-projectpath-lifecycle.test.ts` 覆盖：外部持锁进程 → `disabled-lock`，`CODEGRAPH_NO_WATCH=1` → `disabled-env`，并核对 `codegraph_status` 文本里的 `**Watch:**` 行。
