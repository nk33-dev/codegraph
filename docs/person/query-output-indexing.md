# 查询输出、过滤与索引状态

## 当前契约

- `codegraph_explore` 默认优先输出查询符号之间的主路径和关键节点；字段、局部变量、实体属性以及短 getter/setter 只保留在符号头部或图关系中。`symbolTypes`、`excludeTypes` 可以覆盖默认展示范围。
- `directory`、`languages`、`frameworks` 和 `depth` 是展示过滤与遍历参数。目录/语言过滤不会删除过滤范围外、但处在主路径深度内的跨语言后端节点；框架过滤使用索引检测到的框架名称。
- 磁盘上刚出现、尚未写入 `files` 表的源码可以通过 `codegraph_node {file: "..."}` 直接查看。结果明确标为 `unindexed`，不生成节点、边或 blast radius；刷新后才会进入正式图结果。
- 单文件刷新命令为 `codegraph sync --file <project-relative-path>`。不支持的扩展会提示在 `codegraph.json` 增加映射；不会由 MCP 查询自动写入索引。
- 流程断点统一标记为 `unindexed`、`unsupported`、`dynamic_key`、`ambiguous_candidates`、`no_syntax_edge`、`language_boundary` 或 `lsp_unavailable`，并在文本结果中给出刷新、缩小查询或配置语言服务/框架的下一步。
- `flow`、`pipeline`、`流程`、`调用链`、`链路` 会被解析为流程意图。多词自然语言中的普通 PascalCase 或全大写主题词（例如 Word、PDF、Excel）不会仅凭大小写被报告为 `unindexed`；camelCase、snake_case、限定名、路径及已确认的类型/组件仍按显式符号处理。
- 流程未连通时，文本结果先输出英文 `Flow status — incomplete`，明确说明结果是部分证据而非“代码不存在”。自动附带的 change context、blast radius 和关系扇出会隐藏；用户显式请求的改动上下文仍保留。
- 自然语言命中 Vue 文件但没有显式符号时，只在最高相关文件中存在唯一模板处理器且它只有一个已解析下游调用时，自动提升为 `component → handler → callee` 主路径；任一层有多个候选就保持 `unconnected`。
- MCP 的断链状态、错误原因和补救建议主要供模型消费，使用英文；安装器、`codegraph init` 等直接面向人的交互可以使用中文。

## 验证边界

过滤只改变 explore 的候选和源码片段，不改变底层图、结构化查询或索引数据。`codegraph sync --file` 仍会对指定文件执行增量提取和引用解析；跨文件边可能在后续完整同步中补齐。
