# 索引状态、局部刷新与内容标记

## 当前契约

- `CodeGraph.getIndexStatus().revision`、CLI 状态与查询响应的 `index.revision` 区分四种状态：`verified` 表示索引提交与 HEAD 相同，未扫描的工作区改动仍可能存在；`files-current` 表示文件检查未发现变化，但 Git 提交信息缺失（包括非 Git 项目）；`stale` 表示已知文件或提交漂移；`unverified` 表示提交信息缺失且未检查文件。提交未知时不再显示笼统的 `up to date`。
- 查询响应的 `index.completeness` 与提交对应状态分开报告。待解析引用、待同步文件及 `indexing`、`partial`、`failed` 任务都会标为 `incomplete`，给出原因、待解析引用来源文件总数和最多 100 个路径；没有完成标记的旧索引为 `unknown`。已尝试但无法解析的外部引用不计入待解析数量。
- CLI 搜索、调用关系、影响分析、文件和上下文查询，以及 MCP 文本和结构化查询都会显示不完整警告；CLI 的数组 JSON 契约保留，警告写入 stderr。文本最多列出五个引用来源文件，强调下游依赖可能超出所列范围；部分或失败任务按项目报告影响范围，无法完整枚举。零 callers 或零 impact 不能证明没有调用者或依赖。

- `CodeGraph.getIndexStatus()` 是 CLI、MCP 和 UI 共用的状态入口，包含生成版本、最后更新时间、落后文件数、阶段、任务等级和失败原因。`indexedCommit` 是上次索引/同步时的 HEAD，`currentCommit` 在各查询模式都读取 HEAD，普通查询共用最长 1 秒的进程内缓存；显式状态查询和索引写入读取最新 HEAD。非 Git 项目的 HEAD 可以为 `null`，旧索引的 `indexedCommit` 可以为 `null`。两者不同时警告，但相同也不意味着工作区无改动。
- `checkFiles: true` 同时检查源图文件与文本索引中的配置、脚本和文档：`textChanges` 分别列出新增、修改、移除路径，`laggingFileCount` 去重汇总两者与待同步队列；未扫描时 `textChanges: null`。文件检查依据大小和修改时间，不是原子快照；`lastUpdatedAt` 是最近源文件索引时间，不是 Git 提交时间。
- 结构化查询的 `index` 带有 `freshness` 和 `freshnessReason`：`current` 表示没有已知漂移（未扫描文件时不保证磁盘一致），`syncing` 表示索引任务或待处理文件/引用未完成，`stale` 表示提交、工作区文件已漂移或索引任务未成功完成，`degraded` 表示 watcher 已停止，`unverified` 表示缺少提交信息且未检查文件。原始 `state` 即使为 `complete`，`laggingFileCount` 非零且无待处理队列也会标成 `stale`；这些字段只是风险摘要，按文件编辑仍以磁盘内容核验为准。
- `codegraph refresh <file>` 与 `CodeGraph.refresh()` 只刷新指定文件；普通正文变更保持 `file` 范围，接口、导出、路由等结构变更扩大到 `related`，项目配置变更使用 `project` 范围。
- 文件 watcher 继续使用尾沿防抖，把连续保存合并成一次同步。局部刷新不会绕过已有 writer lock 或引用解析流程。
- 每次成功取得写锁的索引任务有独立 task ID；对外结果使用由索引文件内容、节点/边计数和提取版本计算的稳定 content marker。无变更同步不会改变 marker，内容或提取结果改变才会改变它。结构化响应的状态块以及 explore/node 的符号、源码和调用链都声明该 marker；文件漂移时禁止按旧行号切当前源码，改为整文件或省略正文。
- `watching: false` 必须带上原因：`watchPolicy` 与 `watchPolicyReason` 只在未监听时出现，取值为 `disabled-env`（`CODEGRAPH_NO_WATCH=1`）、`disabled-wsl`（WSL2 `/mnt/`，判定见 `src/sync/watch-policy.ts`）、`start-failed`（watcher 起不来）、`disabled-lock`（别的 CodeGraph 进程持写锁）、`unwatched-projectPath`（只读、`--no-watch`，或一次性 CLI/库 handler）、`never-started`（尚未启动）。原因记录在同一 `CodeGraph` 实例上；环境判定由 `watchDisabledPolicy()` 单点给出，写锁判定由 `src/mcp/project-lifecycle.ts` 的 `activate()` 在握手前给出。
- 结构化 `warnings`、`codegraph_status` 的 `**Watch:**` 行和 explore 文本横幅共用 `watchInactiveWarning()` 一句文案。`disabled-lock` 不等于索引会变旧：持锁进程仍在同步，本会话在其退出后接管，因此这一条只说“本会话未监听、由对方维护”，不提示 `codegraph sync`——否则会引导 agent 去和持锁进程抢写；其余策略才明确要求手工同步。没有 project lifecycle 的一次性 handler 不在文本响应里重复这条（结构化状态块仍然报告）。
- explore/node 的文件漂移提示按是否真在监听改写结尾句（`staleRecoveryNote()`），不再无条件承诺改动“会在下次索引同步时自动被拾取”。

## 同步一致性与恢复

- 边身份由 `(source, target, kind, IFNULL(line, -1), IFNULL(col, -1))` 唯一约束保证；不同调用点保留为不同边。重复同步验证比较完整节点和边集合，不能仅比较总数。
- 文件替换或删除时，把带 `refName/refKind` 的跨文件入边还原成待解析引用，与删除目标节点放在同一事务。重解析沿用原接收者、限定名和调用位置；无引用印记的边只重挂到唯一的 `(kind, qualifiedName)` 目标。旧边缺少印记时，不能保证中断后重建其原始引用。
- 分块存储未写入文件记录便中断时，下次提取先清除该路径的残留节点；文件在恢复前再次修改，也不会留下上一轮的半成品符号。
- 每个变更文件的定义名称差异先保存在 `project_metadata` 的 `resolution_rebind_pending:<path>`，成功完成同步后删除。进程在提取与重解析之间退出时，下次同步即使没有磁盘变更，也继续重解析其他文件的受影响引用。`CODEGRAPH_NO_REBIND=1` 保留待处理记录。
- 节点缓存用 SQLite `data_version` 识别其他连接提交，在单节点和批量读取前失效；事务内节点不进入缓存，数据库重开后清除连接相关缓存。这适用于 MCP 查询 worker、CLI 与公共 API。
- 结构化编辑的 `indexFiles()` 仍负责提取；后续 `resolveReferencesForFiles()` 委托公共 `sync({ paths })`，同时恢复未修改调用方的引用与历史失败引用。
- 文本索引局部刷新按路径读取旧记录；未变更文本保留路径与文件状态检查，跳过内容采样和重复路径解析。扫描每 100 个候选让出事件循环，未变更或跳过的文件也计入，让 MCP catch-up 可响应并发请求。
- 索引/同步后的数据库维护在 worker 中删除已无有效节点的词表名称，并清空写入端的名称去重缓存，允许名称重新出现。清理是可重试的维护工作：SQL 错误记录英文告警，读端仍验证词表候选；worker 不可用时沿用有界维护降级，清理等待后续正常维护。SQLite 可复用已释放页，物理文件不因清理立即缩小；统计需区分主库、WAL、空闲页和有效记录。

恢复与多连接用例见 `__tests__/index-reliability.test.ts`；规模测量入口见[索引可靠性审查](index-reliability.md)。发布状态见[个人版导航](README.md#验证与发布)。

## 数据库与提取版本

- schema 版本由 `CURRENT_SCHEMA_VERSION` 单点声明，**v1.6.1 同步后为 13**。上游用 10 表示 synthesis、11 表示它的索引守卫；个人自己的 `file_text` 迁移让位到 13，12 是桥接迁移，只在 `synthesis_inputs` 缺失时重放上游 v10，所以对上游库和全新库都是 no-op。编号纪律见[维护流程](maintenance.md)的「迁移编号纪律」。
- 迁移在**打开索引库时**自动执行：任何命令（含 `codegraph sync`）打开旧库都会把它升到 13。个人库从记录 10 升上来会依次跑 11、12、13，补齐 `synthesis_inputs`、宽版 `idx_nodes_kind` 与合成回填；不需要删除索引重建，也不需要手工操作。
- 提取版本为 **29**，全语言范围用于恢复跨文件关系并生成 Vue/React composable、路由别名、props 与 emits 关系。旧索引会被判定落后：`codegraph status` 给出 `reindexRecommended`，`codegraph sync --upgrade-index` 先打印范围、文件数、预计耗时与峰值磁盘再执行。这一步是重抽取，与上面的表结构补齐是两件事。
- 桥接迁移会置 `project_metadata.synthesis_pending = '1'`，下一次同步据此重建合成边并把它清回 0；迁移本身不重建，所以升级后要跑一次 `codegraph sync`（或 `--upgrade-index`）才算真正补齐。
- 旧构建读新库的推演：旧版看到的 `MAX(schema_versions)` 大于自己的 `CURRENT_SCHEMA_VERSION`，因此不迁移也能打开，且不认识新表新列。这是按代码推演的结论，**本轮未在旧产物上实测**；回滚仍以备份恢复为准，不是 `git checkout`。

## 升级关系报告

`codegraph sync --upgrade-index` 调用公共 `CodeGraph.upgradeIndex()`，在同一 writer lock 内完成重抽取、解析与前后比较。升级会强制存储哈希未变的文件，普通索引/同步仍沿用内容哈希跳过规则；提取或同步未完成时保留旧提取版本戳。API 返回 `success`、`assessment`、`relations`、处理文件数、耗时和错误；已是当前版本时 `relations: null`。CLI 非 quiet 模式直接输出关系分类与最多二十个示例。

`relations` 汇总 `added`、`removed`、`deduplicated`，按 calls、references、imports 等实际 EdgeKind 和共享证据等级分组，每组携带来源、可信度与原始数字置信度。比较标识使用两端的文件/限定名、符号种类/语言/签名、关系类型、位置和证据字段，不依赖重建后的节点 ID。调用点位置变更或来源变更记为删除加新增；`before / after` 统计去重后的关系位置。去重只统计仍然保留的位置减少的重复记录，不把关系删除算作去重，也不把 INSERT OR IGNORE 的尝试数当作实际变化。

前后快照存入独立的临时 SQLite 文件，通过 ATTACH 在持锁连接上比较，避免把两份全图边集载入内存；不更改主连接的 temp_store。异常和成功路径均 DETACH、删除临时文件并释放写锁。本报告比较打开索引后的提取升级，不追溯打开时已执行的 schema 迁移。关系报告使用临时数据库，不改变持久 schema。快照增加升级期间的临时磁盘与查询成本；计划中的峰值估算包含快照余量，实际规模仍由关系标识长度决定。

## 资源调度

`CODEGRAPH_RESOURCE_PROFILE` 只接受显式的 `battery`、`balanced`、`performance`。解析 worker 还按 `ordinary`、`interface`、`global` 任务等级限流。默认普通保存只启用一个解析 worker，不检测充电状态，也不默认把机器打满；现有 `CODEGRAPH_PARSE_WORKERS` 等显式覆盖仍然有效。

## 验证

类型检查使用 `npm run typecheck`。局部刷新和状态字段应通过 `CodeGraph.refresh()`、`codegraph status --json`、`codegraph_explore` 的 `mode: "status"` 共同核对，确保所有入口读取同一版本状态。

监听原因的文案与分类由 `__tests__/watch-inactive-notice.test.ts` 固定（含“持锁时不出现 `codegraph sync`”这一条）；真实生命周期下的取值由 `__tests__/mcp-projectpath-lifecycle.test.ts` 覆盖：外部持锁进程 → `disabled-lock`，`CODEGRAPH_NO_WATCH=1` → `disabled-env`，并核对 `codegraph_status` 文本里的 `**Watch:**` 行。
