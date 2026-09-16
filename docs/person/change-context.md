# AI 改动上下文与语义差异

阶段四把 Git 工作区变化、改动符号、语义边、影响入口和关联测试合并到现有 `codegraph_explore`。底层推导位于 `src/graph/change-context.ts`，MCP 和 CLI 只负责触发与渲染。

## 使用契约

- 查询明确包含 review/change/diff/impact/改动/审查等意图时自动分析；也可传 `includeChanges:true`。
- 普通查询先用结果文件做路径限定的 Git 探测。结果与改动无关时返回 `changes:null`，不扫描完整 diff，也不增加文本噪声。
- 默认基准是 `HEAD`，`baseRef` 可指定其他提交或分支。CLI 对应 `--changes` 与 `--base <ref>`。
- `deepChanges:true` / `--deep-changes` 才创建基准提交的临时索引，用于比较解析后的语义边；默认局部分析不会复制完整数据库。
- 文本输出供模型直接阅读，`structuredContent.changes` 保存版本化字段：文件、行区间、符号、语义边、影响入口、关联测试、无测试风险、警告和裁剪状态。

## 推导边界

普通模式从 Git name-status、零上下文 hunk、基准文件源码和当前文件源码定位新增、修改、删除符号，并比较 `calls`、`extends`、`implements`、`overrides`、`navigates`。调用目标尚未解析时保留语法级名称；深度模式用独立基准图补充 resolved 边差异。

影响入口与测试复用 `src/graph/change-impact.ts`。传播距离是图距离，不是必然故障；动态调用、未解析引用和删除后已不存在的节点可能漏报。没有找到关联测试只会对高扇入改动发出风险提示，不会声称“没有测试”或“没有影响”。

未暂存移动在 Git 中通常表现为删除加未跟踪新增；只有新旧内容完全相同时才合并为 rename，避免猜测相似文件。`.codegraph*` 数据目录不进入改动上下文。

## 深度模式与清理

深度模式在系统临时目录创建 `codegraph-change-baseline-*`，通过本地共享 clone 检出基准提交并初始化独立索引。当前项目的 `.codegraph/` 不会被覆盖。无论成功或失败都会在 `finally` 中关闭数据库并删除临时目录；下一次深度分析还会尽力清理超过 24 小时的遗留目录。

## 验证

`__tests__/change-context.test.ts` 覆盖：

- 修改符号及调用边的新增/删除；
- 一次 `explore` 返回改动符号、影响入口和关联测试；
- 无关普通查询不附加改动上下文；
- 分支工作区中的重命名、删除和未跟踪文件；
- 显式 `baseRef` 下的双向分支切换差异；
- 深度临时索引完成后清理。

本地验证结果（Windows）：

- `npm run build`：通过，包含 TypeScript、UI、WASM 资源和构建产物检查；
- 阶段四专项：`6` 项通过；
- Graph/MCP 定向回归：`47` 项通过；
- `npm test`：全量运行时 `272` 个测试文件通过、`21` 个按环境跳过；`4649` 项测试通过、`234` 项按环境跳过。随后新增的分支切换专项已单独通过，未重复跑整套全量测试。
