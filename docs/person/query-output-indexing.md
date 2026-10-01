# 查询输出、过滤与索引状态

## 当前契约

- `codegraph_explore` 默认优先输出查询符号之间的主路径和关键节点；字段、局部变量、实体属性以及短 getter/setter 只保留在符号头部或图关系中。`symbolTypes`、`excludeTypes` 可以覆盖默认展示范围。
- 请求“只列主链路”或等价的 main/primary chain 时，只返回确认过的主调用链和位置；旁支与源码默认折叠，传 `expand: true` 或明确请求 source/details 才展开。
- 结构化查询先给 `summary`；`file` + `line`（可选 `column`）自动走 LSP，缺少组合项时直接说明补哪个参数。LSP 冷启动的空结果标为 `indexing`，不冒充“查无此物”。
- 精确符号存在但没有 callers/callees 时，结果保留 `target.status: found` 并说明关系数为零；目标不存在才是 `not_found`。字符串/计算分派没有图边时会提示可能存在不可见调用。
- `directory`、`languages`、`frameworks` 和 `depth` 是展示过滤与遍历参数。目录/语言过滤不会删除过滤范围外、但处在主路径深度内的跨语言后端节点；框架过滤使用索引检测到的框架名称。
- 磁盘上刚出现、尚未写入 `files` 表的源码可以通过 `codegraph_explore` 的 `mode:"source"`（传入 `file`、`offset`、`limit`）直接查看。结果明确标为 `unindexed`，不生成节点、边或 blast radius；刷新后才会进入正式图结果。
- 单文件刷新命令为 `codegraph sync --file <project-relative-path>`。不支持的扩展会提示在 `codegraph.json` 增加映射；不会由 MCP 查询自动写入索引。
- 流程断点统一标记为 `unindexed`、`unsupported`、`dynamic_key`、`ambiguous_candidates`、`no_syntax_edge`、`framework_dynamic`、`language_boundary` 或 `lsp_unavailable`，并在文本结果中给出刷新、缩小查询或配置语言服务/框架的下一步。
- `flow`、`pipeline`、`流程`、`调用链`、`链路` 会被解析为流程意图。多词自然语言中的普通 PascalCase 或全大写主题词（例如 Word、PDF、Excel）不会仅凭大小写被报告为 `unindexed`；camelCase、snake_case、限定名、路径及已确认的类型/组件仍按显式符号处理。
- 流程未连通时，文本结果先输出英文 `Flow status — incomplete`，明确说明结果是部分证据而非“代码不存在”。自动附带的 change context、blast radius 和关系扇出会隐藏；用户显式请求的改动上下文仍保留。
- 已连通的明确流程问句同样省略重复的 blast radius、通用关系扇出和未请求的改动上下文，让主路径先成为完整首答；未连通且未显式指定 `maxFiles` 时最多展示三个相关文件。
- `codegraph_*` 工具名只有在能唯一映射 handler 并沿真实 calls 边回溯时才提升为调度路径；分页源码的下一步提示只使用默认公开的 `codegraph_explore`。
- 自然语言命中 Vue 文件但没有显式符号时，只在最高相关文件中存在唯一模板处理器且它只有一个已解析下游调用时，自动提升为 `component → handler → callee` 主路径；任一层有多个候选就保持 `unconnected`。
- MCP 的断链状态、错误原因和补救建议主要供模型消费，使用英文；安装器、`codegraph init` 等直接面向人的交互可以使用中文。
- `codegraph install` 把简短入口与查询选择规则写入对应 Agent 指令文件；完整 MCP 用法由初始化说明和工具 schema 提供。模板变更后用 `codegraph install --refresh` 更新已配置 Agent 的旧区块，保留用户内容；工具进程需在客户端完整退出并重开后加载新实现。

## 前端关系

- Vue/React/TypeScript 保留已有 store、模板处理器、hooks 与路由合成；自定义 `use*` composable/hook 的返回对象成员及解构别名可连接到其唯一返回函数，成员必须在返回对象中明确出现。
- Vue Router 支持 `useRouter` 的导入别名和接收变量别名，按词法作用域检查绑定；同名参数和数组不能借用外层 router 关系。Nuxt 导航先于自动导入解析；编译器宏与虚拟导入被消费，但不产生伪递归边。
- Vue `defineEmits` 的字面量事件与父组件 `@event="handler"` 配对；Vue `defineProps` 的回调属性与 `:on-save="handler"` 配对；React 函数组件的 `props.onSave()` 和解构参数调用可与 `<Child onSave={handler} />` 配对。接收组件须由明确导入或同文件唯一定义确定，处理器须有唯一具名定义。
- 标识符形式的 props 绑定还产生组件到属性值定义的 `references` 依赖。以上关系统一为 heuristic，带通道名和父组件绑定位置；调用边还保留子组件分派位置。
- 查询涉及 `.vue`、`.tsx` 或 `.jsx` 时会显示框架/动态关系边界，并列出有界的未解析调用位置（其中可能包含外部 API）。未连通的前端流程使用 `framework_dynamic` 原因。计算路由、动态组件、spread props、内联回调与运行时事件名仍可能缺边。
- 既有索引要执行 `codegraph index`，或刷新相关生产者和消费者文件后，才能得到新增关系。本轮不修改发行版本或标签。

## 验证边界

过滤只改变 explore 的候选和源码片段，不改变底层图、结构化查询或索引数据。`codegraph sync --file` 仍会对指定文件执行增量提取和引用解析；跨文件边可能在后续完整同步中补齐。


## 本轮验证（2026-10-01）

- 索引可信度、Vue/React 关系、文本查询、常驻说明和 store 缓存的定向测试通过（37 项）；覆盖 2,500 条待解析引用、未知提交、失败/部分任务、Unicode、参数遮蔽、同步保留和事件解绑。
- Explore 点名文件、完整函数正文、源码预算守恒和输出统计的定向测试通过（49 项），输出预算与按文件分配测试通过（65 项）；与前组重复的统计测试去重后共 139 项。警告占用响应开销，文件预留源码额度保持独立。
- `npm run check:quick` 未全通过：缺少 `dist/mcp/engine`、编译 worker 和 viewer 资产，另有 36 个依赖构建产物的测试被明确跳过。执行过程中发现的源码回归已定向复测；完整构建、三平台 CI 和隔离安装仍未执行。
- 本轮扩展已有 Vue/React 支持，真实仓库召回/精度和 Agent A/B 尚未测量；功能尚未发布。既有索引需重建或刷新相关文件后使用新增关系。
