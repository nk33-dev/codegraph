# 查询输出、过滤与索引状态

## 当前契约

- `codegraph_explore` 默认优先输出查询符号之间的主路径和关键节点；字段、局部变量、实体属性以及短 getter/setter 只保留在符号头部或图关系中。`symbolTypes`、`excludeTypes` 可以覆盖默认展示范围。
- `directory`、`languages`、`frameworks` 和 `depth` 是展示过滤与遍历参数。目录/语言过滤不会删除过滤范围外、但处在主路径深度内的跨语言后端节点；框架过滤使用索引检测到的框架名称。
- 磁盘上刚出现、尚未写入 `files` 表的源码可以通过 `codegraph_node {file: "..."}` 直接查看。结果明确标为 `unindexed`，不生成节点、边或 blast radius；刷新后才会进入正式图结果。
- 单文件刷新命令为 `codegraph sync --file <project-relative-path>`。不支持的扩展会提示在 `codegraph.json` 增加映射；不会由 MCP 查询自动写入索引。
- 流程断点统一标记为 `unindexed`、`unsupported`、`dynamic_key`、`ambiguous_candidates`、`no_syntax_edge`、`language_boundary` 或 `lsp_unavailable`，并在文本结果中给出刷新、缩小查询或配置语言服务/框架的下一步。

## 验证边界

过滤只改变 explore 的候选和源码片段，不改变底层图、结构化查询或索引数据。`codegraph sync --file` 仍会对指定文件执行增量提取和引用解析；跨文件边可能在后续完整同步中补齐。
